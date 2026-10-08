import { randomUUID } from 'node:crypto'
import type { EnterpriseLearningQueue, EnterpriseLearningClaim } from './learning-queue'
import type { EnterpriseLearningRepository } from './learning-repository'
import type { LearningAccountAuthority } from './learning-account'
import {
  LearningReviewFailure,
  type LearningReviewer
} from '../../../src/core/memory/learning-reviewer'
import type { LearningRunOutcome } from '../../../src/core/memory/learning-scheduler'
import type { ReviewUsage } from '../../../src/shared/contracts/learning-memory'
import { LearningOperationDrain } from '../../../src/core/memory/learning-operation-drain'

export interface EnterpriseLearningReviewerOptions {
  /** Dedicated database worker bindings, enumerated again after restart. Never persisted by this worker. */
  references(): Promise<string[]>
  fingerprint?(): string | Promise<string>
  monitorIntervalMs?: number
  pollIntervalMs?: number
  onOutcome?(outcome: LearningRunOutcome): void
}
function failureCode(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error)
  return /^[a-z_]{1,100}$/.test(reason) ? reason : 'review_failed'
}

/** Executes data-only reviews. Account locks and durable claims, rather than this process, own authority. */
export class EnterpriseLearningReviewerWorker {
  private readonly workerId = randomUUID()
  private controller: AbortController | null = null
  private stopped = false
  private timer: ReturnType<typeof setInterval> | null = null
  private busy = false
  private polling: Promise<void> | null = null
  private running: Promise<LearningRunOutcome> | null = null
  private cursor = 0
  private readonly modelOperations = new LearningOperationDrain()
  private shuttingDown: Promise<void> | null = null
  constructor(
    private readonly queue: EnterpriseLearningQueue,
    private readonly repository: EnterpriseLearningRepository<LearningAccountAuthority>,
    private readonly reviewer: LearningReviewer,
    private readonly options: EnterpriseLearningReviewerOptions
  ) {}
  private report(outcome: LearningRunOutcome): void {
    try {
      this.options.onOutcome?.(outcome)
    } catch {
      /* Diagnostics do not alter durable results. */
    }
  }
  start(): void {
    if (this.timer || this.shuttingDown) return
    this.stopped = false
    const poll = (): void => {
      if (this.polling || this.busy || this.stopped) return
      const pending = this.poll()
      this.polling = pending
      void pending
        .catch(() => this.report('failed'))
        .finally(() => {
          if (this.polling === pending) this.polling = null
        })
    }
    this.timer = setInterval(poll, this.options.pollIntervalMs ?? 1000)
    this.timer.unref()
    poll()
  }
  private async poll(): Promise<void> {
    const references = await this.options.references()
    if (this.stopped || !references.length) return
    for (let index = 0; index < references.length && !this.stopped; index++) {
      const reference = references[this.cursor++ % references.length]
      try {
        const result = await this.runOnce(reference)
        if (result !== 'idle') {
          this.report(result)
          return
        }
      } catch {
        this.report('failed')
      }
    }
  }
  async stop(): Promise<void> {
    this.stopped = true
    this.controller?.abort('review_shutdown')
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await Promise.allSettled([this.running, this.polling])
  }
  shutdown(): Promise<void> {
    return (this.shuttingDown ??= (async () => {
      await this.stop()
      await this.modelOperations.drain()
    })())
  }
  runOnce(reference: string): Promise<LearningRunOutcome> {
    if (this.busy || this.stopped) return Promise.resolve('idle')
    this.busy = true
    const pending = this.execute(reference)
    this.running = pending
    void pending
      .finally(() => {
        this.busy = false
        if (this.running === pending) this.running = null
      })
      .catch(() => {})
    return pending
  }
  private async execute(reference: string): Promise<LearningRunOutcome> {
    const controller = new AbortController()
    this.controller = controller
    let claim: EnterpriseLearningClaim | null = null
    let receivedUsage: ReviewUsage | undefined
    let dispatched = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    let monitor: ReturnType<typeof setInterval> | undefined
    const monitoring: { pending: Promise<void> | null } = { pending: null }
    let abortListener: (() => void) | undefined
    const aborted = new Promise<never>((_, reject) => {
      abortListener = () =>
        reject(new Error(failureCode(controller.signal.reason ?? 'review_cancelled')))
      controller.signal.addEventListener('abort', abortListener, { once: true })
    })
    // Shutdown may occur while authentication/input queries are awaiting, before Promise.race starts.
    void aborted.catch(() => {})
    try {
      claim = await this.queue.claim(reference, this.workerId)
      if (!claim) return 'idle'
      if (this.stopped || controller.signal.aborted) throw new Error('review_shutdown')
      const input = await this.repository.reviewInput(reference, claim)
      const fingerprint = await this.options.fingerprint?.()
      const check = async (): Promise<void> => {
        await this.queue.assertCurrentClaim(reference, claim!)
        const current = await this.repository.reviewInput(reference, claim!)
        if (
          current.basisHash !== input.basisHash ||
          (await this.options.fingerprint?.()) !== fingerprint
        )
          throw new Error('learning_review_context_changed')
        if (this.stopped || controller.signal.aborted) throw new Error('review_cancelled')
      }
      await check()
      timeout = setTimeout(
        () => controller.abort('review_timeout'),
        input.request.settings.reviewTimeoutMs
      )
      monitor = setInterval(() => {
        if (monitoring.pending || controller.signal.aborted) return
        const pending = check()
        monitoring.pending = pending
        void pending
          .catch((error) => controller.abort(failureCode(error)))
          .finally(() => {
            if (monitoring.pending === pending) monitoring.pending = null
          })
      }, this.options.monitorIntervalMs ?? 500)
      monitor.unref()
      const captured = claim
      const settle = async (usage?: ReviewUsage): Promise<void> => {
        if (!usage) return
        try {
          await captured.settleUsage(usage)
        } catch {
          /* Forgotten scopes cannot be recreated by a fee receipt. */
        }
      }
      dispatched = true
      const reviewing = this.reviewer.review(structuredClone(input.request), controller.signal)
      void this.modelOperations
        .track(
          reviewing.then(
            (result) => settle(result.usage),
            (error) => settle(error instanceof LearningReviewFailure ? error.usage : undefined)
          )
        )
        .catch(() => {})
      const result = await Promise.race([reviewing, aborted])
      receivedUsage = result.usage
      // The fingerprint is checked again immediately before the transactional authority check.
      if (controller.signal.aborted || this.stopped)
        throw new Error(failureCode(controller.signal.reason ?? 'review_cancelled'))
      if ((await this.options.fingerprint?.()) !== fingerprint)
        throw new Error('learning_review_context_changed')
      await this.queue.complete(reference, claim, result.usage, (db, scope, conversation, at) =>
        this.repository.applyReviewWithin(db, scope, conversation, at, captured, input, result)
      )
      return 'completed'
    } catch (error) {
      if (!claim) throw error
      const usage =
        error instanceof LearningReviewFailure && error.usage
          ? error.usage
          : (receivedUsage ??
            (!dispatched
              ? { inputTokens: 0, outputTokens: 0, measurement: 'not_dispatched' as const }
              : undefined))
      try {
        await this.queue.fail(reference, claim, failureCode(error), usage)
      } catch {
        return 'cancelled'
      }
      return controller.signal.aborted || this.stopped ? 'cancelled' : 'failed'
    } finally {
      if (timeout) clearTimeout(timeout)
      if (monitor) clearInterval(monitor)
      if (abortListener) controller.signal.removeEventListener('abort', abortListener)
      // Drain the authority poll before releasing the process slot. Late model promises only own fee receipts.
      if (monitoring.pending) await monitoring.pending.catch(() => {})
      if (this.controller === controller) this.controller = null
    }
  }
}
