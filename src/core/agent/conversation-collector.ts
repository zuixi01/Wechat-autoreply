import {
  sameIdentity,
  type Identity,
  type ConversationBinding
} from '../../shared/contracts/identity'
import {
  InventoryPageSchema,
  MessagePageSchema,
  type CollectionSource,
  type CollectionStatus
} from '../../shared/contracts/collection'
import type { ObservedMessage } from '../../shared/contracts/message'
import type { Ledger } from '../persistence/ledger'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'

interface CollectorOptions {
  sweepIntervalMs?: number
  pollMs?: number
  operationTimeoutMs?: number
  inventoryPagesPerTick?: number
  readsPerTick?: number
  maximumInventoryPages?: number
  maximumReadPages?: number
  requireBackground?: boolean
}
export interface CollectionEvents {
  onBindings(bindings: ConversationBinding[]): void
  onRead(binding: ConversationBinding, changed: ObservedMessage[], complete: boolean): void
  onPending(binding: ConversationBinding): void
  onFailure(): void
  onTiming?: (event: CollectionTimingEvent) => void | Promise<void>
}
export interface CollectionTimingEvent {
  stage: 'read_started' | 'read_completed' | 'read_failed' | 'read_cancelled' | 'read_stale'
  readId: string
  binding: ConversationBinding
  startedAtMs: number
  atMs: number
  sourceMessageIds: string[]
  complete: boolean
}

/** Bounded discovery and fair message paging. It never invokes a model or sends. */
export class ConversationCollector {
  private readonly options: Required<CollectorOptions>
  private controller?: AbortController
  private timer?: ReturnType<typeof setTimeout>
  private work?: Promise<void>
  private unsubscribe?: () => void
  private nextSweep = 0

  constructor(
    private readonly ledger: Ledger,
    private readonly identity: Identity,
    private readonly source: CollectionSource,
    private readonly events: CollectionEvents,
    options: CollectorOptions = {},
    private readonly now: () => number = Date.now,
    private readonly monotonicNow: () => number = () => performance.now()
  ) {
    this.options = {
      sweepIntervalMs: 30000,
      pollMs: 250,
      operationTimeoutMs: 3000,
      inventoryPagesPerTick: 2,
      readsPerTick: 8,
      maximumInventoryPages: 1000,
      maximumReadPages: 1000,
      requireBackground: true,
      ...options
    }
    for (const [key, value] of Object.entries(this.options))
      if (
        key !== 'requireBackground' &&
        (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 1000000)
      )
        throw new Error('invalid_collection_configuration')
  }
  private timing(event: CollectionTimingEvent): void {
    try {
      const pending = this.events.onTiming?.(structuredClone(event))
      if (pending) void Promise.resolve(pending).catch(() => undefined)
    } catch {
      // Observation and cursor commits never depend on diagnostics availability.
    }
  }
  async start(parent: AbortSignal): Promise<void> {
    if (this.controller || parent.aborted) throw new Error('collector_not_stopped')
    const capabilities = this.source.capabilities()
    if (
      !capabilities.stableIdentity ||
      !capabilities.stableMessageIds ||
      (this.options.requireBackground && !capabilities.backgroundRead)
    )
      throw new Error('collection_capability_unverified')
    const controller = (this.controller = new AbortController())
    const signal = AbortSignal.any([parent, controller.signal])
    // Resume checkpoints, but rebuild inventory instead of trusting a previous UI snapshot.
    this.ledger.collection.revalidate(this.identity)
    this.ledger.collection.begin(this.identity)
    this.events.onBindings(this.ledger.collection.bindings(this.identity))
    this.nextSweep = this.now() + this.options.sweepIntervalMs
    this.unsubscribe = this.source.subscribe?.((id) => {
      if (signal.aborted) return
      try {
        const known = this.ledger.collection.hint(this.identity, id)
        const binding = known
          ? this.ledger.collection.request(this.identity, id)?.entry.binding
          : undefined
        if (binding) this.events.onPending(binding)
        else this.nextSweep = 0
      } catch {
        this.events.onFailure()
      }
    })
    const abort = (): void => {
      if (this.timer) clearTimeout(this.timer)
      this.timer = undefined
      this.unsubscribe?.()
      this.unsubscribe = undefined
    }
    signal.addEventListener('abort', abort, { once: true })
    let initial = true
    const tick = async (): Promise<void> => {
      if (signal.aborted) return
      try {
        await this.tick(signal, initial)
        initial = false
      } catch {
        if (!signal.aborted) {
          controller.abort()
          this.events.onFailure()
        }
      }
      if (!signal.aborted && this.controller === controller)
        this.timer = setTimeout(() => {
          this.work = tick()
        }, this.options.pollMs)
    }
    this.work = tick()
    await this.work
  }
  async stop(): Promise<void> {
    this.controller?.abort()
    await this.work
    this.controller = undefined
    this.work = undefined
    if (this.ledger.collection.scan(this.identity))
      this.ledger.collection.interrupt(this.identity, 'interrupted')
  }
  status(): CollectionStatus {
    return this.ledger.collection.status(this.identity)
  }

  private async tick(signal: AbortSignal, initial = false): Promise<void> {
    if (!this.ledger.collection.scan(this.identity) && this.now() >= this.nextSweep) {
      this.ledger.collection.begin(this.identity)
      this.nextSweep = this.now() + this.options.sweepIntervalMs
    }
    for (
      let n = 0;
      n < (initial ? 1 : this.options.inventoryPagesPerTick) && !signal.aborted;
      n++
    ) {
      const scan = this.ledger.collection.scan(this.identity)
      if (!scan) break
      if (scan.pages >= this.options.maximumInventoryPages) {
        this.ledger.collection.interrupt(this.identity, 'limit_reached')
        break
      }
      try {
        const page = InventoryPageSchema.parse(
          await this.call(
            (s) =>
              this.source.inventory(
                {
                  identity: this.identity,
                  snapshotId: scan.snapshot,
                  cursor: scan.cursor
                },
                s
              ),
            signal
          )
        )
        if (signal.aborted) return
        if (!sameIdentity(page.identity, this.identity)) throw new Error('identity_unverified')
        if (Buffer.byteLength(JSON.stringify(page), 'utf8') > 262144)
          throw new Error('limit_reached')
        this.ledger.collection.page(
          this.identity,
          scan,
          page.entries,
          page.snapshotId,
          page.nextCursor,
          page.total,
          page.authoritative,
          this.now()
        )
        this.events.onBindings(page.entries.map((e) => e.binding))
        for (const entry of page.entries)
          if (!this.ledger.collection.ready(this.identity, entry.binding.conversationId))
            this.events.onPending(entry.binding)
      } catch (error) {
        if (signal.aborted) return
        const reason =
          error instanceof Error &&
          ['inventory_changed', 'no_progress', 'limit_reached', 'identity_unverified'].includes(
            error.message
          )
            ? (error.message as CollectionStatus['reason'])
            : 'source_unavailable'
        this.ledger.collection.interrupt(this.identity, reason)
        if (reason === 'identity_unverified') throw error
        break
      }
    }
    for (let n = 0; n < (initial ? 1 : this.options.readsPerTick) && !signal.aborted; n++) {
      const request = this.ledger.collection.next(this.identity)
      if (!request) break
      const span = {
        readId: randomUUID(),
        binding: request.entry.binding,
        startedAtMs: this.monotonicNow(),
        sourceMessageIds: [] as string[],
        complete: false
      }
      this.timing({ ...span, stage: 'read_started', atMs: span.startedAtMs })
      try {
        const page = MessagePageSchema.parse(
          await this.call((s) => this.source.read(request, s), signal)
        )
        if (signal.aborted) {
          this.timing({ ...span, stage: 'read_cancelled', atMs: this.monotonicNow() })
          return
        }
        const result = this.ledger.collection.commit(
          this.identity,
          request,
          page,
          this.options.maximumReadPages
        )
        this.timing({
          ...span,
          stage: result.stale ? 'read_stale' : 'read_completed',
          atMs: this.monotonicNow(),
          sourceMessageIds: result.stale
            ? []
            : result.changed.map((message) => message.sourceMessageId),
          complete: !result.stale && result.complete
        })
        if (!result.stale)
          this.events.onRead(request.entry.binding, result.changed, result.complete)
      } catch (error) {
        if (signal.aborted) {
          this.timing({ ...span, stage: 'read_cancelled', atMs: this.monotonicNow() })
          return
        }
        if (error instanceof Error && error.message === 'activity_changed') {
          this.timing({ ...span, stage: 'read_stale', atMs: this.monotonicNow() })
          this.ledger.collection.hint(this.identity, request.entry.binding.conversationId)
          this.events.onPending(request.entry.binding)
          this.nextSweep = 0
          break
        }
        this.timing({ ...span, stage: 'read_failed', atMs: this.monotonicNow() })
        // A failed source read cannot justify skipping messages or replaying an action.
        this.ledger.collection.failRead(this.identity, request.entry.binding.conversationId)
        this.events.onRead(request.entry.binding, [], false)
        if (error instanceof Error && error.message === 'identity_unverified') throw error
        if (
          !(error instanceof Error) ||
          ![
            'no_progress',
            'limit_reached',
            'identity_unverified',
            'message_page_too_large'
          ].includes(error.message)
        )
          this.ledger.collection.interrupt(this.identity, 'source_unavailable')
      }
    }
  }
  private async call<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    parent: AbortSignal
  ): Promise<T> {
    const controller = new AbortController()
    const signal = AbortSignal.any([parent, controller.signal])
    if (signal.aborted) throw new Error('collection_cancelled')
    const timer = setTimeout(() => controller.abort(), this.options.operationTimeoutMs)
    let abort!: () => void
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(new Error('collection_cancelled'))
      signal.addEventListener('abort', abort, { once: true })
    })
    try {
      return await Promise.race([operation(signal), cancelled])
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    }
  }
}
