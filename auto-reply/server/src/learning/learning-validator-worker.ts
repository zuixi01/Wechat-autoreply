import { z } from 'zod'
import type { EnterpriseLearningProductValidation } from './learning-product-validation'
import type { LearningRunOutcome } from '../../../src/core/memory/learning-scheduler'

export interface EnterpriseLearningValidatorOptions {
  references(): Promise<string[]>
  pollIntervalMs?: number
  onOutcome?(outcome: LearningRunOutcome): void
}
/** The database owns claims and fees. This loop only discovers authenticated auto candidates. */
export class EnterpriseLearningValidatorWorker {
  private stopped = false
  private timer: ReturnType<typeof setInterval> | null = null
  private controller: AbortController | null = null
  private running: Promise<LearningRunOutcome> | null = null
  private polling: Promise<void> | null = null
  private cursor = 0
  private readonly pollIntervalMs: number
  private shuttingDown: Promise<void> | null = null
  constructor(
    private readonly product: EnterpriseLearningProductValidation,
    private readonly options: EnterpriseLearningValidatorOptions
  ) {
    this.pollIntervalMs = z
      .number()
      .int()
      .min(1)
      .max(60000)
      .parse(options.pollIntervalMs ?? 1000)
  }
  private report(outcome: LearningRunOutcome): void {
    try {
      this.options.onOutcome?.(outcome)
    } catch {
      /* Observers cannot alter committed state. */
    }
  }
  start(): void {
    if (this.timer || this.shuttingDown) return
    this.stopped = false
    const poll = (): void => {
      if (this.polling || this.running || this.stopped) return
      const pending = this.poll()
      this.polling = pending
      void pending
        .catch(() => this.report('failed'))
        .finally(() => {
          if (this.polling === pending) this.polling = null
        })
    }
    this.timer = setInterval(poll, this.pollIntervalMs)
    this.timer.unref()
    poll()
  }
  private async poll(): Promise<void> {
    const references = await this.options.references()
    for (let index = 0; index < references.length && !this.stopped; index++) {
      const outcome = await this.runOnce(references[this.cursor++ % references.length])
      if (outcome !== 'idle') {
        this.report(outcome)
        return
      }
    }
  }
  runOnce(reference: string): Promise<LearningRunOutcome> {
    if (this.stopped || this.running) return Promise.resolve('idle')
    const controller = new AbortController()
    this.controller = controller
    const pending = (async (): Promise<LearningRunOutcome> => {
      const candidate = await this.product.nextCandidate(reference)
      if (!candidate || this.stopped || controller.signal.aborted) return 'idle'
      const result = await this.product.validate(
        reference,
        candidate.conversationId,
        candidate.memoryId,
        candidate.revision,
        controller.signal
      )
      return controller.signal.aborted
        ? 'cancelled'
        : result.status === 'failed'
          ? 'failed'
          : 'completed'
    })()
    this.running = pending
    void pending
      .finally(() => {
        if (this.running === pending) {
          this.running = null
          this.controller = null
        }
      })
      .catch(() => {})
    return pending
  }
  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.controller?.abort('validation_shutdown')
    await Promise.allSettled([this.running, this.polling])
  }
  shutdown(): Promise<void> {
    return (this.shuttingDown ??= (async () => {
      await this.stop()
      await this.product.drain()
    })())
  }
}
