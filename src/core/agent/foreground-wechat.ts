import { randomUUID } from 'node:crypto'
import {
  ForegroundObservationSchema,
  type ForegroundObservation,
  type ForegroundRecord,
  type ForegroundStatus,
  type ForegroundConnectionMode,
  type ForegroundCheckpoint
} from '../../shared/contracts/foreground-wechat'
import { hashContext } from '../reply/hashes'

export interface ForegroundDriver {
  connect(target: string, signal: AbortSignal, mode?: ForegroundConnectionMode): Promise<void>
  read(signal: AbortSignal): Promise<ForegroundObservation>
  generate(observation: ForegroundObservation, signal: AbortSignal): Promise<string | null>
  dispatch(
    observation: ForegroundObservation,
    text: string,
    signal: AbortSignal
  ): Promise<'sent' | 'not_sent' | 'unknown'>
}
export interface ForegroundJournal {
  list(limit?: number): ForegroundRecord[]
  hasUnknown?(): boolean
  unresolved?(): ForegroundRecord[]
  save(record: ForegroundRecord): void
}
const active = new Set(['connecting', 'running', 'waiting_foreground', 'generating', 'sending'])
/** Explicit single-contact foreground mode; never claims native message IDs or background capability. */
export class ForegroundWechatRuntime {
  private state: ForegroundStatus['state'] = 'idle'
  private reason = 'none'
  private target = ''
  private baseline?: ForegroundObservation
  private ownEcho?: string
  private pendingWork = false
  private controller?: AbortController
  private work?: Promise<void>
  private timer?: ReturnType<typeof setTimeout>
  constructor(
    private readonly driver: ForegroundDriver,
    private readonly journal: ForegroundJournal,
    private readonly polling = true,
    private readonly checkpoint?: (value: ForegroundCheckpoint) => void
  ) {}
  status(): ForegroundStatus {
    return {
      state: this.state,
      target: this.target,
      reason: this.reason,
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
    pending?: { count: number; preview: string },
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
    this.state = 'connecting'
    this.ownEcho = restored?.ownEcho
    this.pendingWork = restored?.pending ?? false
    this.baseline = restored?.baseline
    const controller = new AbortController()
    this.controller = controller
    const work = (async () => {
      try {
        await this.driver.connect(this.target, controller.signal, mode)
        if (controller.signal.aborted) return
        const baseline = ForegroundObservationSchema.parse(
          await this.driver.read(controller.signal)
        )
        if (controller.signal.aborted) return
        this.validate(baseline)
        if (restored) {
          // Do not consume the unread tail by replacing a durable baseline on restart.
        } else if (pending) {
          const { count, preview } = pending
          const messages = baseline.messages.slice(-count)
          const prefix = preview.replace(/(?:\.\.\.|…)$/, '').trim()
          if (
            !Number.isInteger(count) ||
            count < 1 ||
            count > 80 ||
            messages.length !== count ||
            messages.some((message) => message.direction !== 'inbound') ||
            !prefix ||
            !messages.at(-1)?.text.startsWith(prefix)
          )
            throw new Error('unread_message_unverified')
          this.baseline = { ...baseline, messages: baseline.messages.slice(0, -count) }
          this.pendingWork = true
        } else this.baseline = baseline
        this.changed()
        this.state = 'running'
        this.schedule()
      } catch (error) {
        if (!controller.signal.aborted) this.stopWith(this.code(error))
      }
    })()
    this.work = work
    try {
      await work
    } finally {
      if (this.work === work) this.work = undefined
    }
    return this.status()
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
    if (!this.polling || !['running', 'waiting_foreground'].includes(this.state)) return
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.schedule())
    }, 4000)
  }
  private stopWith(reason: string): ForegroundStatus {
    this.controller?.abort()
    clearTimeout(this.timer)
    this.state = 'paused'
    this.reason = reason
    return this.status()
  }
  private code(error: unknown): string {
    const code = error instanceof Error ? error.message : ''
    return /^[a-z_]{1,128}$/.test(code) ? code : 'read_failed'
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
      if (hashContext(previous.slice(-count)) === hashContext(next.messages.slice(0, count)))
        return next.messages.slice(count)
    }
    throw new Error('message_gap')
  }
  private async cycle(): Promise<void> {
    const controller = this.controller,
      baseline = this.baseline
    if (
      !['running', 'waiting_foreground'].includes(this.state) ||
      !controller ||
      !baseline ||
      controller.signal.aborted
    )
      return
    const signal = controller.signal
    try {
      const next = ForegroundObservationSchema.parse(await this.driver.read(signal))
      if (signal.aborted) return
      this.validate(next)
      let additions = this.additions(next)
      this.state = 'running'
      this.reason = 'none'
      if (
        additions[0]?.direction === 'outbound' &&
        this.ownEcho &&
        additions[0].text === this.ownEcho
      ) {
        additions = additions.slice(1)
        this.ownEcho = undefined
      }
      if (additions.some((m) => m.direction === 'outbound')) throw new Error('human_reply')
      if (!additions.some((m) => m.direction === 'inbound' && m.text.trim())) {
        this.baseline = next
        this.pendingWork = false
        this.changed()
        return
      }
      this.state = 'generating'
      this.pendingWork = true
      this.changed()
      const reply = await this.driver.generate(next, signal)
      if (signal.aborted) return
      if (!reply?.trim()) {
        this.baseline = next
        this.pendingWork = false
        this.changed()
        this.state = 'running'
        return
      }
      if (reply.length > 4096) throw new Error('reply_invalid')
      const current = ForegroundObservationSchema.parse(await this.driver.read(signal))
      if (signal.aborted) return
      this.validate(current)
      if (hashContext(current) !== hashContext(next)) {
        this.state = 'running'
        return
      }
      const record: ForegroundRecord = {
        id: randomUUID(),
        target: this.target,
        question: additions.map((m) => m.text).join('\n'),
        reply: reply.trim(),
        state: 'unknown',
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
      this.journal.save({ ...record, state: outcome })
      this.baseline = next
      if (outcome === 'unknown') {
        this.stopWith('send_unknown')
        return
      }
      if (outcome === 'not_sent') {
        if (!signal.aborted) this.stopWith('send_cancelled')
        return
      }
      this.ownEcho = record.reply
      this.pendingWork = false
      this.changed()
      // A pause racing a positive receipt must still persist the echo marker;
      // otherwise restart mistakes our own reply for an untracked human reply.
      if (signal.aborted) return
      this.state = 'running'
    } catch (error) {
      if (!signal.aborted) {
        const code = this.code(error)
        if (code === 'foreground_lost') {
          // Keep the original baseline; a returning window must pass every validation again.
          // Dispatch failures are handled above and never enter this recovery branch.
          this.state = 'waiting_foreground'
          this.reason = code
        } else this.stopWith(code)
      }
    }
  }
}
