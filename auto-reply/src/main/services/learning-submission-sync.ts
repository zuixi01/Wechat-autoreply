import {
  LearningSettingsSchema,
  LearningEpisodeSchema,
  type MemoryScope,
  type LearningSettings,
  type LearningEpisode
} from '../../shared/contracts/learning-memory'
import {
  LearningSubmissionAuthoritySchema,
  LearningSubmissionRequestSchema,
  type LearningSubmissionRequest,
  type LearningSubmissionError,
  type LearningSubmissionReceipt
} from '../../shared/contracts/learning-submissions'
import type { LearningSubmissionStore } from '../../core/persistence/learning-submissions'
import { accountMemoryScope, memoryScopeKey } from '../../core/memory/learning-scope'

export interface LearningSubmissionBinding {
  scope: MemoryScope
  authorityId: string
  settings(scope: MemoryScope, signal: AbortSignal): Promise<LearningSettings>
  episode(scope: MemoryScope, id: string, signal: AbortSignal): Promise<LearningEpisode>
  apply(request: LearningSubmissionRequest, signal: AbortSignal): Promise<unknown>
}
interface CapturedBinding extends LearningSubmissionBinding {
  epoch: number
}
function errorCode(error: unknown): LearningSubmissionError {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  if (
    code === 'AUTHORIZATION_FAILED' ||
    code === 'NOT_REGISTERED' ||
    code === 'DEVICE_SCOPE_CHANGED'
  )
    return 'permission_revoked'
  if (code === 'TASK_INVALIDATED') return 'source_unavailable'
  return 'network_unavailable'
}

/** Synchronizes named learning data only; this service has no generation, platform or send capability. */
export class LearningSubmissionSync {
  private epoch = 0
  private stopped = false
  private controller?: AbortController
  private flight?: Promise<void>
  private timer?: ReturnType<typeof setInterval>
  private readonly preparations = new Map<AbortController, Promise<LearningSubmissionReceipt>>()
  private readonly forgetting = new Set<string>()
  private readonly now: () => number
  constructor(
    private readonly store: LearningSubmissionStore,
    private readonly options: {
      resolve(scope: MemoryScope): LearningSubmissionBinding | undefined
      now?: () => number
    }
  ) {
    this.now = options.now ?? Date.now
  }

  private capture(scope: MemoryScope): CapturedBinding {
    const binding = this.options.resolve(scope)
    if (
      this.stopped ||
      this.forgetting.has(memoryScopeKey(accountMemoryScope(scope))) ||
      !binding ||
      memoryScopeKey(accountMemoryScope(scope)) !==
        memoryScopeKey(accountMemoryScope(binding.scope))
    )
      throw new Error('learning_scope_unavailable')
    // Copy the authority value: a getter backed by mutable registration must not change our captured identity.
    return {
      ...binding,
      scope: accountMemoryScope(binding.scope),
      authorityId: LearningSubmissionAuthoritySchema.parse(binding.authorityId),
      epoch: this.epoch
    }
  }
  private current(scope: MemoryScope, binding: CapturedBinding, signal: AbortSignal): boolean {
    if (signal.aborted || this.stopped || binding.epoch !== this.epoch) return false
    try {
      return this.capture(scope).authorityId === binding.authorityId
    } catch {
      return false
    }
  }
  observeEpisode(raw: unknown): void {
    const episode = LearningEpisodeSchema.parse(raw)
    this.capture(episode.scope)
    this.store.observeEpisode(episode)
  }

  receipts(scope: MemoryScope): LearningSubmissionReceipt[] {
    const binding = this.capture(scope)
    this.store.prune(scope, this.now())
    return this.store.receipts(scope, binding.authorityId)
  }
  async forget(scope: MemoryScope, authoritative: () => void | Promise<void>): Promise<void> {
    this.capture(scope)
    const key = memoryScopeKey(accountMemoryScope(scope))
    this.forgetting.add(key)
    try {
      await this.cancel()
      if (this.stopped) throw new Error('learning_scope_unavailable')
      await authoritative()
      if (this.stopped) throw new Error('learning_scope_unavailable')
      this.store.forget(scope, this.now())
    } finally {
      this.forgetting.delete(key)
    }
  }
  submit(raw: unknown): Promise<LearningSubmissionReceipt> {
    const controller = new AbortController()
    const work = (async () => {
      const request = LearningSubmissionRequestSchema.parse(raw),
        scope = request.input.scope
      const binding = this.capture(scope),
        firstSubmittedAt = this.now()
      const existing = this.store.receipt(scope, binding.authorityId, request.input.sourceId)
      let evidenceAt = existing?.evidenceAt ?? firstSubmittedAt
      if (request.kind !== 'manual' && !existing) {
        let rawEpisode: LearningEpisode | undefined
        try {
          rawEpisode = await this.bounded(controller.signal, (signal) =>
            binding.episode(scope, request.input.episodeId, signal)
          )
        } catch (error) {
          if (!this.current(scope, binding, controller.signal))
            throw new Error('learning_scope_unavailable')
          const cached = this.store.episodeTime(scope, request.input.episodeId)
          if (cached === undefined) throw error
          evidenceAt = cached
        }
        if (rawEpisode !== undefined) {
          const episode = LearningEpisodeSchema.parse(rawEpisode)
          if (
            memoryScopeKey(episode.scope) !== memoryScopeKey(scope) ||
            episode.id !== request.input.episodeId
          )
            throw new Error('learning_scope_unavailable')
          if (!this.current(scope, binding, controller.signal))
            throw new Error('learning_scope_unavailable')
          this.store.observeEpisode(episode)
          evidenceAt = episode.startedAt
        }
      }
      if (!this.current(scope, binding, controller.signal))
        throw new Error('learning_scope_unavailable')
      this.store.enqueue({
        ...request,
        authorityId: binding.authorityId,
        firstSubmittedAt,
        evidenceAt
      })
      // An earlier startup pass may have captured an empty queue before this enqueue.
      if (this.flight) await this.flight
      await this.flush()
      if (!this.current(scope, binding, controller.signal))
        throw new Error('learning_scope_unavailable')
      const receipt = this.store.receipt(scope, binding.authorityId, request.input.sourceId)
      if (!receipt) throw new Error('learning_submission_unavailable')
      return receipt
    })()
    this.preparations.set(controller, work)
    const settled = (): void => {
      this.preparations.delete(controller)
    }
    void work.then(settled, settled)
    return work
  }

  start(): void {
    if (this.stopped || this.timer) return
    this.timer = setInterval(() => {
      void this.flush().catch(() => {})
    }, 10000)
    this.timer.unref()
  }
  flush(): Promise<void> {
    if (this.flight) return this.flight
    if (this.stopped) return Promise.resolve()
    const controller = new AbortController()
    this.controller = controller
    const work = this.perform(controller.signal)
    this.flight = work
    const settled = (): void => {
      if (this.flight === work) this.flight = undefined
      if (this.controller === controller) this.controller = undefined
    }
    void work.then(settled, settled)
    return work
  }
  private async perform(signal: AbortSignal): Promise<void> {
    if (this.stopped || signal.aborted) return
    this.store.pruneEpisodeTimes(this.now())
    for (const scope of this.store.pendingScopes()) {
      if (this.stopped || signal.aborted) return
      this.store.prune(scope, this.now())
      let binding: CapturedBinding
      try {
        binding = this.capture(scope)
      } catch {
        continue
      }
      if (!this.current(scope, binding, signal)) return
      let settings: LearningSettings
      try {
        settings = LearningSettingsSchema.parse(
          await this.bounded(signal, (child) => binding.settings(scope, child))
        )
      } catch (error) {
        if (this.current(scope, binding, signal))
          for (const intent of this.store.pending(scope, binding.authorityId, this.now()))
            this.store.markError(
              scope,
              binding.authorityId,
              intent.input.sourceId,
              errorCode(error)
            )
        continue
      }
      if (!this.current(scope, binding, signal)) return
      this.store.setRetention(scope, settings.caseRetentionDays)
      for (const intent of this.store.pending(scope, binding.authorityId, this.now())) {
        if (!this.current(scope, binding, signal)) return
        try {
          await this.bounded(signal, (child) =>
            binding.apply(
              LearningSubmissionRequestSchema.parse({ kind: intent.kind, input: intent.input }),
              child
            )
          )
        } catch (error) {
          if (this.current(scope, binding, signal))
            this.store.markError(
              scope,
              binding.authorityId,
              intent.input.sourceId,
              errorCode(error)
            )
          break
        }
        if (!this.current(scope, binding, signal)) return
        this.store.acknowledge(scope, binding.authorityId, intent.input.sourceId)
      }
    }
  }
  private async bounded<T>(
    parent: AbortSignal,
    run: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const controller = new AbortController(),
      signal = AbortSignal.any([parent, controller.signal])
    if (signal.aborted) throw new Error('learning_cancelled')
    const timeout = setTimeout(() => controller.abort(), 5000)
    let abort!: () => void
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(new Error('learning_cancelled'))
      signal.addEventListener('abort', abort, { once: true })
    })
    try {
      return await Promise.race([run(signal), cancelled])
    } finally {
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
    }
  }
  async cancel(): Promise<void> {
    this.epoch++
    this.controller?.abort()
    for (const controller of this.preparations.keys()) controller.abort()
    await Promise.allSettled([...this.preparations.values(), ...(this.flight ? [this.flight] : [])])
  }
  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await this.cancel()
  }
}
