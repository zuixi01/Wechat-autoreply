export interface JobContext {
  signal: AbortSignal
  isCurrent: () => boolean
}
interface ScheduledJob<T> {
  key: string
  firstAt: number
  dueAt: number
  controller: AbortController
  work: (context: JobContext) => Promise<T>
  apply: (result: T, context: JobContext) => Promise<void>
}
interface SchedulerOptions {
  concurrency?: number
  quietMs?: number
  maximumWaitMs?: number
  onError?: (key: string, reason: 'queue_overloaded' | 'generation_failed') => void
  maximumConversations?: number
}

/** Per-conversation supersession; separate conversations may generate concurrently. */
export class ConversationScheduler<T> {
  private paused = true
  private active = 0
  private timer?: ReturnType<typeof setTimeout>
  private readonly queued = new Map<string, ScheduledJob<T>>()
  private readonly current = new Map<string, ScheduledJob<T>>()
  private readonly interruptedWaits = new Map<string, number>()
  private readonly concurrency: number
  private readonly quietMs: number
  private readonly maximumWaitMs: number
  private readonly maximumConversations: number

  constructor(
    private readonly options: SchedulerOptions = {},
    private readonly now: () => number = Date.now
  ) {
    this.concurrency = options.concurrency ?? 2
    this.quietMs = options.quietMs ?? 1000
    this.maximumWaitMs = options.maximumWaitMs ?? 3000
    this.maximumConversations = options.maximumConversations ?? 200
    if (
      !Number.isInteger(this.concurrency) ||
      this.concurrency < 1 ||
      this.concurrency > 32 ||
      !Number.isFinite(this.quietMs) ||
      this.quietMs < 0 ||
      !Number.isFinite(this.maximumWaitMs) ||
      this.maximumWaitMs < this.quietMs ||
      !Number.isInteger(this.maximumConversations) ||
      this.maximumConversations < 1
    )
      throw new Error('invalid_scheduler_configuration')
  }

  resume(): void {
    this.paused = false
    this.arm()
  }

  pause(): void {
    this.paused = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    for (const job of this.current.values()) job.controller.abort()
    this.queued.clear()
    this.current.clear()
    this.interruptedWaits.clear()
  }

  cancel(key: string): void {
    this.interruptedWaits.delete(key)
    this.abort(key)
  }

  /** Abort stale work while a trusted collection page is being committed.
   * A queued burst retains its original maximum-wait deadline and queue slot. */
  interrupt(key: string): void {
    const queued = this.queued.get(key)
    if (queued) this.interruptedWaits.set(key, queued.firstAt)
    this.abort(key)
  }

  private abort(key: string): void {
    this.current.get(key)?.controller.abort()
    this.current.delete(key)
    this.queued.delete(key)
    this.arm()
  }

  pending(key: string): boolean {
    return this.current.has(key)
  }

  submit(key: string, work: ScheduledJob<T>['work'], apply: ScheduledJob<T>['apply']): void {
    if (this.paused) return
    if (
      !this.current.has(key) &&
      !this.interruptedWaits.has(key) &&
      this.current.size + this.interruptedWaits.size >= this.maximumConversations
    ) {
      this.options.onError?.(key, 'queue_overloaded')
      return
    }
    const pending = this.queued.get(key)
    const firstAt = pending?.firstAt ?? this.interruptedWaits.get(key) ?? this.now()
    this.interruptedWaits.delete(key)
    this.current.get(key)?.controller.abort()
    const job: ScheduledJob<T> = {
      key,
      firstAt,
      dueAt: Math.min(this.now() + this.quietMs, firstAt + this.maximumWaitMs),
      controller: new AbortController(),
      work,
      apply
    }
    this.current.set(key, job)
    this.queued.set(key, job)
    this.arm()
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (this.paused || this.active >= this.concurrency || this.queued.size === 0) return
    const next = Math.min(...[...this.queued.values()].map((job) => job.dueAt))
    this.timer = setTimeout(
      () => {
        this.timer = undefined
        this.pump()
      },
      Math.max(0, next - this.now())
    )
  }

  private pump(): void {
    if (this.paused) return
    const ready = [...this.queued.values()]
      .filter((job) => job.dueAt <= this.now())
      .sort((a, b) => a.firstAt - b.firstAt || a.dueAt - b.dueAt)
    for (const job of ready) {
      if (this.active >= this.concurrency) break
      this.queued.delete(job.key)
      this.active++
      const context: JobContext = {
        signal: job.controller.signal,
        isCurrent: () =>
          !this.paused && !job.controller.signal.aborted && this.current.get(job.key) === job
      }
      void this.execute(job, context)
    }
    this.arm()
  }

  private async execute(job: ScheduledJob<T>, context: JobContext): Promise<void> {
    try {
      const result = await job.work(context)
      if (context.isCurrent()) await job.apply(result, context)
    } catch {
      if (context.isCurrent()) this.options.onError?.(job.key, 'generation_failed')
    } finally {
      if (this.current.get(job.key) === job) this.current.delete(job.key)
      this.active--
      this.arm()
    }
  }
}
