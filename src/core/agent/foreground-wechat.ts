import { randomUUID } from 'node:crypto'
import {
  ForegroundObservationSchema,
  sameForegroundMessages,
  type ForegroundObservation,
  type ForegroundRecord,
  type ForegroundStatus,
  type ForegroundDispatchFailure,
  type ForegroundConnectionMode,
  type ForegroundCheckpoint
} from '../../shared/contracts/foreground-wechat'
import { hashContext } from '../reply/hashes'
import {
  ReplyPlanSchema,
  type ReplyPlan,
  type Delivery,
  type ReplyPart
} from '../../shared/contracts/foreground-reply-plan'

export interface ForegroundDriver {
  manual?(observation: ForegroundObservation, messages: ForegroundObservation['messages']): void
  generatePlan?(
    observation: ForegroundObservation,
    signal: AbortSignal,
    incoming?: ForegroundObservation['messages']
  ): Promise<ReplyPlan | null>
  dispatchImage?(
    observation: ForegroundObservation,
    part: Extract<ReplyPart, { kind: 'image' }>,
    signal: AbortSignal
  ): Promise<'sent' | 'not_sent' | 'unknown'>
  dispatchFailure?(): ForegroundDispatchFailure | undefined
  metrics?(): ForegroundStatus['performance']
  accept?(observation: ForegroundObservation): void
  receiptText?(): string | undefined
  receiptFingerprint?(): string | undefined
  receiptBaseline?(): ForegroundObservation | undefined
  reconcileHistory?(
    baseline: ForegroundObservation,
    next: ForegroundObservation,
    signal: AbortSignal
  ): Promise<ForegroundObservation | undefined>
  seed?(messages: ForegroundObservation['messages']): void
  connect(
    target: string,
    signal: AbortSignal,
    mode?: ForegroundConnectionMode,
    focus?: boolean
  ): Promise<void>
  read(signal: AbortSignal, fresh?: boolean): Promise<ForegroundObservation>
  generate(
    observation: ForegroundObservation,
    signal: AbortSignal,
    incoming?: ForegroundObservation['messages']
  ): Promise<string | null>
  dispatch(
    observation: ForegroundObservation,
    text: string,
    signal: AbortSignal
  ): Promise<'sent' | 'not_sent' | 'unknown'>
  verifyReceipt?(
    observation: ForegroundObservation,
    text: string,
    signal: AbortSignal
  ): Promise<'sent' | 'unknown'>
}
export interface ForegroundJournal {
  list(limit?: number): ForegroundRecord[]
  hasUnknown?(): boolean
  unresolved?(): ForegroundRecord[]
  handoffs?(): ForegroundRecord[]
  save(record: ForegroundRecord): void
  complete?(record: ForegroundRecord, checkpoint: ForegroundCheckpoint): void
}
export interface ForegroundUnreadHint {
  count: number | null
  preview: string
}
const active = new Set([
  'connecting',
  'running',
  'waiting_foreground',
  'waiting_owner',
  'recovering',
  'generating',
  'sending'
])
const transient = new Set([
  'model_network_failed',
  'model_timeout',
  'model_busy',
  'model_response_invalid',
  'visual_response_invalid',
  'capture_failed',
  'window_query_failed',
  'wechat_window_unavailable',
  'message_gap'
])
/** Explicit single-contact foreground mode; never claims native message IDs or background capability. */
export class ForegroundWechatRuntime {
  private state: ForegroundStatus['state'] = 'idle'
  private reason = 'none'
  private target = ''
  private baseline?: ForegroundObservation
  private ownEcho?: string
  private ownEchoFingerprint?: string
  private pendingWork = false
  private delivery?: Delivery
  private generation?: {
    observation: ForegroundObservation
    settled: boolean
    result?: string | ReplyPlan | null
    error?: unknown
    work: Promise<void>
  }
  private controller?: AbortController
  private work?: Promise<void>
  private timer?: ReturnType<typeof setTimeout>
  private recoveryAttempts = 0
  private lastReplyDurationMs?: number
  private nextRetryAt?: number
  private connection?: {
    mode: ForegroundConnectionMode
    pending?: ForegroundUnreadHint
    restored?: ForegroundCheckpoint
    retried: boolean
  }
  private pendingReceipt?: {
    record: ForegroundRecord
    observation: ForegroundObservation
    started: number
  }
  constructor(
    private readonly driver: ForegroundDriver,
    private readonly journal: ForegroundJournal,
    private readonly polling = true,
    private readonly checkpoint?: (value: ForegroundCheckpoint) => void,
    private readonly backgroundGeneration = false,
    private readonly generationGate?: import('./foreground-generation-gate').ForegroundGenerationGate
  ) {}
  activity(): Omit<ForegroundStatus, 'records'> {
    return {
      state: this.state,
      target: this.target,
      reason: this.reason,
      recoveryAttempts: this.recoveryAttempts,
      lastReplyDurationMs: this.lastReplyDurationMs,
      nextRetryAt: this.nextRetryAt,
      performance: this.driver.metrics?.()
    }
  }
  status(): ForegroundStatus {
    return {
      ...this.activity(),
      records: [
        ...(this.journal.unresolved?.() ?? []).slice(0, 50),
        ...(this.journal.handoffs?.() ?? []).slice(0, 50),
        ...this.journal.list(50).slice(-50).reverse()
      ]
        .filter((record, index, all) => all.findIndex((value) => value.id === record.id) === index)
        .slice(0, 50)
    }
  }
  async start(
    target: string,
    mode: ForegroundConnectionMode = 'search',
    pending?: ForegroundUnreadHint,
    restored?: ForegroundCheckpoint
  ): Promise<ForegroundStatus> {
    if (active.has(this.state) || this.work) return this.status()
    this.target = target.trim()
    if (!this.target) return this.stopWith('target_required')
    if (restored && restored.baseline.contact !== this.target)
      return this.stopWith('checkpoint_invalid')
    if (this.journal.hasUnknown?.() ?? this.journal.list().some((r) => r.state === 'unknown'))
      return this.stopWith('send_unknown')
    this.reason = 'none'
    this.recoveryAttempts = 0
    this.nextRetryAt = undefined
    this.state = 'connecting'
    this.ownEcho = restored?.ownEcho
    this.ownEchoFingerprint = restored?.ownEchoFingerprint
    this.pendingWork = restored?.pending ?? false
    this.delivery = restored?.delivery
    this.generation = undefined
    this.baseline = restored?.baseline
    this.pendingReceipt = undefined
    this.connection = { mode, pending, restored, retried: false }
    const controller = new AbortController()
    this.controller = controller
    const work = (async () => {
      try {
        await this.establish(controller.signal)
      } catch (error) {
        if (!controller.signal.aborted) this.recover(error)
      }
      this.schedule()
    })()
    this.work = work
    try {
      await work
    } finally {
      if (this.work === work) this.work = undefined
    }
    return this.status()
  }
  private async establish(signal: AbortSignal): Promise<void> {
    const connection = this.connection!
    const focus = !connection.retried
    connection.retried = true
    await this.driver.connect(this.target, signal, connection.mode, focus)
    if (signal.aborted) return
    const { restored, pending } = connection
    if (restored)
      this.driver.seed?.([
        ...restored.baseline.messages,
        ...(restored.ownEcho && restored.ownEchoFingerprint
          ? [
              {
                direction: 'outbound' as const,
                text: restored.ownEcho,
                pixelFingerprint: restored.ownEchoFingerprint
              }
            ]
          : [])
      ])
    const baseline = ForegroundObservationSchema.parse(await this.driver.read(signal))
    if (signal.aborted) return
    if (restored && baseline.windowToken !== restored.baseline.windowToken) {
      // An explicit restart binds and reads the current native window afresh.
      // Carry message progress across relogin only after proving the same
      // conversation boundary; live window changes still fail validate().
      this.validate({ ...baseline, windowToken: restored.baseline.windowToken })
      if (!restored.baseline.messages.length) throw new Error('message_gap')
      this.additions(baseline)
      this.baseline = { ...restored.baseline, windowToken: baseline.windowToken }
    }
    this.validate(baseline)
    this.driver.accept?.(baseline)
    if (!restored) {
      if (pending) {
        const { count, preview } = pending
        let start = baseline.messages.length
        let ambiguous: ForegroundObservation['messages'] = []
        if (count === null) {
          // A red dot identifies a new conversation, not the number of messages.
          // Include the complete consecutive incoming turn, anchored by the last
          // outgoing message (or the beginning of a short visible conversation).
          while (start > 0 && baseline.messages[start - 1].direction === 'inbound') start--
          if (start === 0 && baseline.messages.length === 80)
            throw new Error('unread_message_unverified')
          // With no saved boundary a dot cannot prove older text is unread.
          // Reply only to the preview-anchored latest item and retain the rest
          // as a visible handoff, rather than silently answering read history.
          ambiguous = baseline.messages.slice(start, -1)
          start = baseline.messages.length - 1
        } else start -= count
        const messages = baseline.messages.slice(Math.max(0, start))
        const prefix = preview.replace(/(?:\.\.\.|…)$/, '').trim()
        const last = messages.at(-1)
        const mediaPreview =
          /^\[(?:图片|表情|动画表情|语音|视频|文件)\]$/.test(prefix) &&
          last?.direction === 'system' &&
          /非文本|non-text|图片|表情|语音|视频|文件/.test(last.text)
        if (
          (count !== null &&
            (!Number.isInteger(count) || count < 1 || count > 80 || messages.length !== count)) ||
          !messages.length ||
          messages.some((message) => message.direction === 'outbound') ||
          !prefix ||
          (!last?.text.startsWith(prefix) && !mediaPreview)
        )
          throw new Error('unread_message_unverified')
        this.baseline = { ...baseline, messages: baseline.messages.slice(0, start) }
        this.pendingWork = true
        if (ambiguous.length) {
          const record: ForegroundRecord = {
            id: randomUUID(),
            target: this.target,
            question: ambiguous.map((message) => message.text).join('\n'),
            reply: '',
            state: 'handoff',
            failureReason: 'unread_boundary_ambiguous',
            source: this.baseline,
            createdAt: Date.now()
          }
          if (this.journal.complete)
            this.journal.complete(record, { baseline: this.baseline, pending: true })
          else this.journal.save(record)
        }
      } else this.baseline = baseline
    }
    this.connection = undefined
    this.state = 'running'
    this.reason = 'none'
    this.recoveryAttempts = 0
    this.nextRetryAt = undefined
    this.changed()
  }
  async pause(): Promise<ForegroundStatus> {
    this.stopWith('user_pause')
    await this.work
    return this.status()
  }
  hasPending(): boolean {
    return this.pendingWork
  }
  hasBoundary(): boolean {
    return Boolean(this.baseline)
  }
  private changed(): void {
    if (this.baseline)
      this.checkpoint?.({
        baseline: this.baseline,
        ownEcho: this.ownEcho,
        ownEchoFingerprint: this.ownEchoFingerprint,
        pending: this.pendingWork,
        delivery: this.delivery
      })
  }
  tick(): Promise<void> {
    if (this.work) return this.work
    const work = this.cycle()
    this.work = work
    return work.finally(() => {
      if (this.work === work) this.work = undefined
    })
  }
  private schedule(): void {
    if (
      !this.polling ||
      !['running', 'waiting_foreground', 'waiting_owner', 'recovering'].includes(this.state)
    )
      return
    clearTimeout(this.timer)
    const delay =
      this.state === 'recovering'
        ? Math.min(30000, 1000 * 2 ** (this.recoveryAttempts - 1))
        : ['waiting_foreground', 'waiting_owner'].includes(this.state)
          ? 1000
          : 750
    this.nextRetryAt = this.state === 'recovering' ? Date.now() + delay : undefined
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.schedule())
    }, delay)
  }
  private stopWith(reason: string): ForegroundStatus {
    this.controller?.abort()
    clearTimeout(this.timer)
    this.state = 'paused'
    this.reason = reason
    this.nextRetryAt = undefined
    return this.status()
  }
  private code(error: unknown): string {
    const code = error instanceof Error ? error.message : ''
    return /^[a-z_]{1,128}$/.test(code) ? code : 'read_failed'
  }
  private recover(error: unknown): void {
    const code = this.code(error)
    if (code === 'human_input' || code === 'human_reply') {
      this.state = 'waiting_owner'
      this.reason = code
    } else if (code === 'foreground_lost' || code === 'screen_obscured') {
      this.state = 'waiting_foreground'
      this.reason = code
    } else if (transient.has(code) && (code !== 'message_gap' || this.recoveryAttempts < 2)) {
      // Read/generation failures never authorize sending; keep waiting at a
      // capped interval instead of requiring a manual restart after an outage.
      this.recoveryAttempts = Math.min(6, this.recoveryAttempts + 1)
      this.state = 'recovering'
      this.reason = code
    } else this.stopWith(code)
  }
  private validate(next: ForegroundObservation): void {
    if (next.contact !== this.target || !next.privateChat) throw new Error('contact_mismatch')
    if (next.inputText.trim()) throw new Error('human_input')
    if (this.baseline && next.windowToken !== this.baseline.windowToken)
      throw new Error('window_changed')
    if (this.baseline && next.revision !== this.baseline.revision) throw new Error('rules_changed')
  }
  awaitingGeneration(): boolean {
    return Boolean(this.generation && !this.generation.settled)
  }
  private additions(next: ForegroundObservation): ForegroundObservation['messages'] {
    const previous = this.baseline!.messages
    if (!previous.length) return next.messages
    for (let count = Math.min(previous.length, next.messages.length); count > 0; count--) {
      if (sameForegroundMessages(previous.slice(-count), next.messages.slice(0, count)))
        return next.messages.slice(count)
    }
    throw new Error('message_gap')
  }
  private async additionsWithProof(
    next: ForegroundObservation,
    signal: AbortSignal
  ): Promise<ForegroundObservation['messages']> {
    try {
      return this.additions(next)
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== 'message_gap' ||
        !this.driver.reconcileHistory
      )
        throw error
      const old = this.baseline!
      const result = await this.driver.reconcileHistory(old, next, signal)
      if (signal.aborted) throw new Error('cancelled')
      if (!result) throw error
      const proved = ForegroundObservationSchema.parse(result)
      this.validate(proved)
      if (
        !proved.messages.length ||
        proved.messages.length > old.messages.length ||
        hashContext(proved.messages) !== hashContext(next.messages.slice(0, proved.messages.length))
      )
        throw error
      this.baseline = proved
      const additions = this.additions(next)
      this.pendingWork =
        this.pendingWork || additions.some((message) => message.direction === 'inbound')
      this.changed()
      return additions
    }
  }
  private async draft(
    next: ForegroundObservation,
    incoming: ForegroundObservation['messages'],
    signal: AbortSignal
  ): Promise<string | ReplyPlan | null | undefined> {
    const operation = (): Promise<string | ReplyPlan | null> =>
      this.driver.generatePlan
        ? this.driver.generatePlan(next, signal, incoming)
        : this.driver.generate(next, signal, incoming)
    const generate = (): Promise<string | ReplyPlan | null> =>
      this.generationGate ? this.generationGate.run(signal, operation) : operation()
    if (!this.backgroundGeneration) return generate()
    if (
      !this.generation ||
      this.generation.observation.revision !== next.revision ||
      !sameForegroundMessages(this.generation.observation.messages, next.messages)
    ) {
      const job: NonNullable<ForegroundWechatRuntime['generation']> = {
        observation: next,
        settled: false,
        work: Promise.resolve()
      }
      job.work = generate().then(
        (result) => {
          job.result = result
          job.settled = true
        },
        (error) => {
          job.error = error
          job.settled = true
        }
      )
      this.generation = job
    }
    const job = this.generation
    await Promise.race([job.work, new Promise<void>((resolve) => setTimeout(resolve, 0))])
    if (!job.settled) return undefined
    this.generation = undefined
    if (job.error) throw job.error
    return job.result ?? null
  }
  private async cycle(): Promise<void> {
    const controller = this.controller
    let baseline = this.baseline
    if (
      !['running', 'waiting_foreground', 'waiting_owner', 'recovering', 'generating'].includes(
        this.state
      ) ||
      !controller ||
      controller.signal.aborted
    )
      return
    const signal = controller.signal
    if (this.generation && !this.generation.settled) return
    const started = Date.now()
    try {
      if (this.connection) {
        await this.establish(signal)
        return
      }
      if (this.pendingReceipt) {
        const pending = this.pendingReceipt
        const outcome = await this.driver.verifyReceipt!(
          pending.observation,
          pending.record.reply,
          signal
        )
        if (outcome !== 'sent') {
          if (!signal.aborted) {
            if (this.driver.dispatchFailure?.()?.failureReason !== 'send_echo_unverified') {
              this.stopWith('send_unknown')
              return
            }
            this.state = 'recovering'
            this.reason = 'send_verifying'
            this.recoveryAttempts = Math.min(6, this.recoveryAttempts + 1)
          }
          return
        }
        this.confirm(pending.observation, pending.record.reply, pending.started, {
          ...pending.record,
          state: 'sent'
        })
        this.pendingReceipt = undefined
        return
      }
      if (!baseline) return
      const next = ForegroundObservationSchema.parse(
        await this.driver.read(signal, this.state === 'recovering')
      )
      if (signal.aborted) return
      this.validate(next)
      let additions = await this.additionsWithProof(next, signal)
      baseline = this.baseline!
      this.state = 'running'
      this.reason = 'none'
      this.nextRetryAt = undefined
      let consumedOwnEcho = false
      if (
        (additions[0]?.direction === 'outbound' ||
          (additions[0]?.direction === 'system' && this.ownEcho === '[非文本消息]')) &&
        this.ownEcho &&
        sameForegroundMessages(
          [additions[0]],
          [
            {
              direction: additions[0].direction,
              text: this.ownEcho,
              pixelFingerprint: this.ownEchoFingerprint
            }
          ]
        )
      ) {
        additions = additions.slice(1)
        consumedOwnEcho = true
      }
      if (additions.some((m) => m.direction === 'outbound')) {
        this.delivery = undefined
        this.generation = undefined
        try {
          this.driver.manual?.(
            next,
            additions.filter((message) => message.direction === 'outbound')
          )
        } catch {
          /* Learning cannot block delivery. */
        }
        const lastHuman = additions.findLastIndex((message) => message.direction === 'outbound')
        this.baseline = {
          ...next,
          messages: next.messages.slice(0, next.messages.length - additions.length + lastHuman + 1)
        }
        this.ownEcho = undefined
        this.ownEchoFingerprint = undefined
        this.pendingWork = additions
          .slice(lastHuman + 1)
          .some((message) => message.direction === 'inbound')
        this.changed()
        throw new Error('human_reply')
      }
      this.driver.accept?.(next)
      const media = additions.filter(
        (message) =>
          message.direction === 'system' && /non-text|非文本|图片|语音|视频|表情/.test(message.text)
      )
      if (media.length) {
        const lastMedia = next.messages.findLastIndex((message) => media.includes(message))
        const key = hashContext({
          target: this.target,
          window: next.windowToken,
          prior: baseline.messages,
          throughMedia: next.messages.slice(0, lastMedia + 1)
        })
        this.journal.save({
          id: `${key.slice(0, 8)}-${key.slice(8, 12)}-4${key.slice(13, 16)}-a${key.slice(17, 20)}-${key.slice(20, 32)}`,
          target: this.target,
          question: media.map((message) => message.text).join('\n'),
          reply: '',
          state: 'handoff',
          source: next,
          failureReason: 'media_requires_owner',
          createdAt: Date.now()
        })
      }
      additions = additions.filter((message) => message.direction === 'inbound')
      if (!additions.some((m) => m.direction === 'inbound' && m.text.trim()) && !this.delivery) {
        this.baseline = next
        if (consumedOwnEcho) {
          this.ownEcho = undefined
          this.ownEchoFingerprint = undefined
        }
        this.pendingWork = false
        this.recoveryAttempts = 0
        this.changed()
        return
      }
      this.state = 'generating'
      this.pendingWork = true
      this.changed()
      if (additions.some((message) => message.direction === 'inbound')) this.delivery = undefined
      let reply: string | null
      if (!this.delivery) {
        const generated = await this.draft(next, additions, signal)
        if (generated === undefined) return
        if (generated && typeof generated !== 'string')
          this.delivery = {
            ...ReplyPlanSchema.parse(generated),
            id: randomUUID(),
            question: additions.map((message) => message.text).join('\n'),
            cursor: 0
          }
        reply = typeof generated === 'string' ? generated : generated ? '' : null
      } else reply = ''
      const part = this.delivery?.parts[this.delivery.cursor]
      if (part) reply = part.kind === 'text' ? part.text : '[图片表情包]'
      if (signal.aborted) return
      if (!reply?.trim()) {
        const handoff: ForegroundRecord = {
          id: randomUUID(),
          target: this.target,
          question: additions.map((message) => message.text).join('\n'),
          reply: '',
          state: 'handoff',
          source: next,
          failureReason: 'owner_decision_required',
          createdAt: Date.now()
        }
        this.baseline = next
        if (consumedOwnEcho) {
          this.ownEcho = undefined
          this.ownEchoFingerprint = undefined
        }
        this.pendingWork = false
        this.recoveryAttempts = 0
        if (this.journal.complete)
          this.journal.complete(handoff, { baseline: next, pending: false })
        else this.journal.save(handoff)
        this.changed()
        this.state = 'running'
        return
      }
      if (reply.length > 4096) throw new Error('reply_invalid')
      const current = ForegroundObservationSchema.parse(await this.driver.read(signal))
      if (signal.aborted) return
      this.validate(current)
      if (
        hashContext({ ...current, messages: [] }) !== hashContext({ ...next, messages: [] }) ||
        !sameForegroundMessages(current.messages, next.messages)
      ) {
        this.state = 'running'
        return
      }
      const record: ForegroundRecord = {
        id: randomUUID(),
        target: this.target,
        question: this.delivery?.question ?? additions.map((m) => m.text).join('\n'),
        reply: reply.trim(),
        state: 'unknown',
        source: current,
        planId: this.delivery?.id,
        partIndex: this.delivery?.cursor,
        part,
        createdAt: Date.now()
      }
      this.changed()
      this.journal.save(record)
      this.state = 'sending'
      let outcome: ForegroundRecord['state'] = 'unknown'
      try {
        outcome =
          part?.kind === 'image'
            ? this.driver.dispatchImage
              ? await this.driver.dispatchImage(current, part, signal)
              : 'not_sent'
            : await this.driver.dispatch(current, record.reply, signal)
      } catch {
        /* Unknown never authorizes replay. */
      }
      const failure = outcome === 'sent' ? undefined : this.driver.dispatchFailure?.()
      if (outcome !== 'sent') this.journal.save({ ...record, state: outcome, ...failure })
      if (outcome === 'unknown') {
        if (
          !signal.aborted &&
          failure?.failureStage === 'receipt' &&
          failure.failureReason === 'send_echo_unverified' &&
          this.driver.verifyReceipt
        ) {
          this.pendingReceipt = { record, observation: current, started }
          this.state = 'recovering'
          this.reason = 'send_verifying'
          this.recoveryAttempts = 1
          return
        }
        this.stopWith('send_unknown')
        return
      }
      if (outcome === 'not_sent') {
        if (!signal.aborted) {
          if (
            failure?.failureStage === 'before_input' &&
            failure.failureReason === 'screen_obscured'
          ) {
            this.recover(new Error('screen_obscured'))
            return
          }
          if (
            failure?.failureStage === 'before_input' &&
            ['send_screen_changed', 'foreground_lost', 'window_query_failed'].includes(
              failure.failureReason ?? ''
            ) &&
            this.recoveryAttempts < 3
          ) {
            this.recoveryAttempts++
            this.state = 'recovering'
            this.reason = failure.failureReason!
          } else this.stopWith(failure?.failureReason ?? 'send_cancelled')
        }
        return
      }
      this.confirm(next, record.reply, started, { ...record, state: 'sent' })
      // A pause racing a positive receipt must still persist the echo marker;
      // otherwise restart mistakes our own reply for an untracked human reply.
      if (signal.aborted) return
      this.state = 'running'
    } catch (error) {
      if (!signal.aborted) {
        this.recover(error)
      }
    }
  }
  private confirm(
    observation: ForegroundObservation,
    reply: string,
    started: number,
    record?: ForegroundRecord
  ): void {
    this.baseline = this.driver.receiptBaseline?.() ?? observation
    this.ownEcho = this.driver.receiptText?.() ?? reply
    this.ownEchoFingerprint = this.driver.receiptFingerprint?.()
    if (this.delivery) {
      if (this.delivery.cursor + 1 < this.delivery.parts.length)
        this.delivery = { ...this.delivery, cursor: this.delivery.cursor + 1 }
      else this.delivery = undefined
    }
    this.pendingWork = Boolean(this.delivery)
    this.recoveryAttempts = 0
    this.lastReplyDurationMs = Date.now() - started
    if (record) {
      const checkpoint = {
        baseline: this.baseline,
        ownEcho: this.ownEcho,
        ownEchoFingerprint: this.ownEchoFingerprint,
        pending: this.pendingWork,
        delivery: this.delivery
      }
      if (this.journal.complete) this.journal.complete(record, checkpoint)
      else this.journal.save(record)
    }
    this.changed()
    if (this.controller?.signal.aborted) return
    this.reason = 'none'
    this.nextRetryAt = undefined
    this.state = 'running'
  }
}
