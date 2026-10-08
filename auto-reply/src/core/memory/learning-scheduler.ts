import { randomUUID } from 'node:crypto'
import type { LearningStore } from './learning-store'
import type { LearningReviewer } from './learning-reviewer'
import { LearningReviewFailure } from './learning-reviewer'
import type { ReviewUsage } from '../../shared/contracts/learning-memory'
import { LearningOperationDrain } from './learning-operation-drain'

export type LearningRunOutcome = 'idle' | 'completed' | 'failed' | 'cancelled'
/** The reviewer has no device capabilities; foreground preemption invalidates writes before abort. */
export class LearningScheduler {
  private readonly workerId = randomUUID()
  private controller: AbortController | null = null
  private foregroundCount = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private stopped = false
  private readonly operations = new LearningOperationDrain()
  private shuttingDown: Promise<void> | null = null
  private lastForegroundEndedAt: number | undefined
  constructor(
    private readonly store: LearningStore,
    private readonly reviewer: LearningReviewer,
    private readonly onOutcome: (outcome: LearningRunOutcome) => void = () => {},
    private readonly now: () => number = Date.now
  ) {}
  start(): void {
    if (this.timer || this.shuttingDown) return
    this.stopped = false
    this.timer = setInterval(() => {
      void this.runOnce()
        .then((outcome) => this.reportOutcome(outcome))
        .catch(() => this.reportOutcome('failed'))
    }, 1000)
    this.timer.unref()
  }
  stop(): void {
    this.stopped = true
    this.controller?.abort('shutdown')
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
  shutdown(): Promise<void> {
    this.stop()
    return (this.shuttingDown ??= this.operations.drain())
  }
  foregroundStarted(): void {
    this.foregroundCount++
    this.controller?.abort('foreground_preempted')
  }
  foregroundEnded(): void {
    this.foregroundCount = Math.max(0, this.foregroundCount - 1)
    this.lastForegroundEndedAt = this.now()
  }
  isForegroundActive(): boolean {
    return this.foregroundCount > 0
  }
  isBusy(): boolean {
    return this.controller !== null || this.foregroundCount > 0
  }
  private reportOutcome(outcome: LearningRunOutcome): void {
    try {
      this.onOutcome(outcome)
    } catch {
      /* Reporting cannot change the durable review result. */
    }
  }
  runOnce(): Promise<LearningRunOutcome> {
    return this.operations.track(this.execute())
  }
  private async execute(): Promise<LearningRunOutcome> {
    if (this.controller || this.stopped || this.foregroundCount) return 'idle'
    const claim = this.store.jobs.claim(this.workerId, this.lastForegroundEndedAt)
    if (!claim) return 'idle'
    const controller = new AbortController()
    this.controller = controller
    const settings = this.store.settings(claim.scope)
    const timer = setTimeout(() => controller.abort('review_timeout'), settings.reviewTimeoutMs)
    let abortListener: (() => void) | undefined
    let receivedUsage: ReviewUsage | undefined
    try {
      const request = {
        episodes: claim.episodeIds.map((id) => this.store.episode(claim.scope, id)),
        memories: this.store.list(claim.scope),
        feedback: this.store.feedbackEvents(claim.scope),
        settings
      }
      request.feedback = request.feedback.filter((event) =>
        claim.episodeIds.includes(event.episodeId)
      )
      const reviewRequest = {
        ...request,
        loadedRevisions: this.store.loadedRevisions(claim.scope, request.feedback)
      }
      const aborted = new Promise<never>((_, reject) => {
        abortListener = () =>
          reject(new Error(String(controller.signal.reason ?? 'review_cancelled')))
        controller.signal.addEventListener('abort', abortListener, { once: true })
      })
      const settleUsage = (usage: ReviewUsage | undefined): void => {
        if (!usage) return
        try {
          this.store.jobs.settleAttemptUsage(claim, usage)
        } catch {
          /* Scope forgetting or a closed store cannot revive the request. */
        }
      }
      const reviewing = this.operations.track(
        this.reviewer.review(reviewRequest, controller.signal).then(
          (result) => {
            settleUsage(result.usage)
            return result
          },
          (error) => {
            if (error instanceof LearningReviewFailure) settleUsage(error.usage)
            throw error
          }
        )
      )
      const result = await Promise.race([reviewing, aborted])
      receivedUsage = result.usage
      if (controller.signal.aborted || this.foregroundCount || this.stopped)
        throw new Error('review_cancelled')
      this.store.applyReview(claim, result)
      return 'completed'
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'review_failed'
      // Error messages can originate in providers; only persist bounded internal codes.
      const code = /^[a-z_]{1,100}$/.test(reason) ? reason : 'review_failed'
      try {
        this.store.jobs.fail(
          claim,
          code,
          error instanceof LearningReviewFailure ? error.usage : receivedUsage
        )
      } catch {
        return 'cancelled'
      }
      return controller.signal.aborted ? 'cancelled' : 'failed'
    } finally {
      clearTimeout(timer)
      if (abortListener) controller.signal.removeEventListener('abort', abortListener)
      this.controller = null
    }
  }
}
