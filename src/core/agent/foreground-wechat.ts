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

export interface ForegroundDriver {
  dispatchFailure?(): ForegroundDispatchFailure | undefined
  metrics?(): ForegroundStatus['performance']
  accept?(observation: ForegroundObservation): void
  receiptText?(): string | undefined
  receiptFingerprint?(): string | undefined
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
    private readonly checkpoint?: (value: ForegroundCheckpoint) => void
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
    this.validate(baseline)
    this.driver.accept?.(baseline)
    if (!restored) {
      if (pending) {
        const { count, preview } = pending
        let start = baseline.messages.length
        if (count === null) {
          // A red dot identifies a new conversation, not the number of messages.
          // Include the complete consecutive incoming turn, anchored by the last
          // outgoing message (or the beginning of a short visible conversation).
          while (start > 0 && baseline.messages[start - 1].direction === 'inbound') start--
          if (start === 0 && baseline.messages.length === 80)
            throw new Error('unread_message_unverified')
        } else start -= count
        const messages = baseline.messages.slice(Math.max(0, start))
        const prefix = preview.replace(/(?:\.\.\.|…)$/, '').trim()
        if (
          (count !== null &&
            (!Number.isInteger(count) || count < 1 || count > 80 || messages.length !== count)) ||
          !messages.length ||
          messages.some((message) => message.direction === 'outbound') ||
          !prefix ||
          !messages.at(-1)?.text.startsWith(prefix)
        )
          throw new Error('unread_message_unverified')
        this.baseline = { ...baseline, messages: baseline.messages.slice(0, start) }
        this.pendingWork = true
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
  private changed(): void {
    if (this.baseline)
      this.checkpoint?.({
        baseline: this.baseline,
        ownEcho: this.ownEcho,
        ownEchoFingerprint: this.ownEchoFingerprint,
        pending: this.pendingWork
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
    if (!this.polling || !['running', 'waiting_foreground', 'recovering'].includes(this.state))
      return
    clearTimeout(this.timer)
    const delay =
      this.state === 'recovering'
        ? Math.min(30000, 1000 * 2 ** (this.recoveryAttempts - 1))
        : this.state === 'waiting_foreground'
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
    if (code === 'foreground_lost' || code === 'screen_obscured') {
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
  private additions(next: ForegroundObservation): ForegroundObservation['messages'] {
    const previous = this.baseline!.messages
    if (!previous.length) return next.messages
    for (let count = Math.min(previous.length, next.messages.length); count > 0; count--) {
      if (sameForegroundMessages(previous.slice(-count), next.messages.slice(0, count)))
        return next.messages.slice(count)
    }
    throw new Error('message_gap')
  }
  private async cycle(): Promise<void> {
    const controller = this.controller,
      baseline = this.baseline
    if (
      !['running', 'waiting_foreground', 'recovering'].includes(this.state) ||
      !controller ||
      controller.signal.aborted
    )
      return
    const signal = controller.signal
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
      let additions = this.additions(next)
      this.state = 'running'
      this.reason = 'none'
      this.nextRetryAt = undefined
      let consumedOwnEcho = false
      if (
        additions[0]?.direction === 'outbound' &&
        this.ownEcho &&
        sameForegroundMessages(
          [additions[0]],
          [{ direction: 'outbound', text: this.ownEcho, pixelFingerprint: this.ownEchoFingerprint }]
        )
      ) {
        additions = additions.slice(1)
        consumedOwnEcho = true
      }
      if (additions.some((m) => m.direction === 'outbound')) {
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
          message.direction === 'system' && /non-text|图片|语音|视频|表情/.test(message.text)
      )
      if (media.length)
        this.journal.save({
          id: randomUUID(),
          target: this.target,
          question: media.map((message) => message.text).join('\n'),
          reply: '',
          state: 'handoff',
          source: next,
          failureReason: 'media_requires_owner',
          createdAt: Date.now()
        })
      additions = additions.filter((message) => message.direction === 'inbound')
      if (!additions.some((m) => m.direction === 'inbound' && m.text.trim())) {
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
      const reply = await this.driver.generate(next, signal, additions)
      if (signal.aborted) return
      if (!reply?.trim()) {
        this.journal.save({
          id: randomUUID(),
          target: this.target,
          question: additions.map((message) => message.text).join('\n'),
          reply: '',
          state: 'handoff',
          source: next,
          failureReason: 'owner_decision_required',
          createdAt: Date.now()
        })
        this.baseline = next
        if (consumedOwnEcho) {
          this.ownEcho = undefined
          this.ownEchoFingerprint = undefined
        }
        this.pendingWork = false
        this.recoveryAttempts = 0
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
        question: additions.map((m) => m.text).join('\n'),
        reply: reply.trim(),
        state: 'unknown',
        source: current,
        createdAt: Date.now()
      }
      this.journal.save(record)
      this.state = 'sending'
      let outcome: ForegroundRecord['state'] = 'unknown'
      try {
        outcome = await this.driver.dispatch(current, record.reply, signal)
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
    this.baseline = observation
    this.ownEcho = this.driver.receiptText?.() ?? reply
    this.ownEchoFingerprint = this.driver.receiptFingerprint?.()
    this.pendingWork = false
    this.recoveryAttempts = 0
    this.lastReplyDurationMs = Date.now() - started
    if (record) {
      const checkpoint = {
        baseline: this.baseline,
        ownEcho: this.ownEcho,
        ownEchoFingerprint: this.ownEchoFingerprint,
        pending: this.pendingWork
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
