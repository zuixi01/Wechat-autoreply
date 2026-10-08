import { z } from 'zod'
import type { LearningRunOutcome } from '../../../src/core/memory/learning-scheduler'
import type { EnterpriseLearningMaintenanceService } from './learning-maintenance-service'

export interface EnterpriseLearningMaintenanceOptions {
  references(): Promise<string[]>
  pollIntervalMs?: number
  onOutcome?(outcome: LearningRunOutcome): void
}
/** Scheduling survives restart in PostgreSQL; this timer owns no durable state or model authority. */
export class EnterpriseLearningMaintenanceWorker {
  private timer: ReturnType<typeof setInterval> | null = null
  private controller: AbortController | null = null
  private running: Promise<LearningRunOutcome> | null = null
  private polling: Promise<void> | null = null
  private stopped = false
  private cursor = 0
  private readonly pollIntervalMs: number
  private shuttingDown: Promise<void> | null = null
  constructor(
    private readonly service: EnterpriseLearningMaintenanceService,
    private readonly options: EnterpriseLearningMaintenanceOptions
  ) {
    this.pollIntervalMs = z
      .number()
      .int()
      .min(1)
      .max(60000)
      .parse(options.pollIntervalMs ?? 60000)
  }
  private report(outcome: LearningRunOutcome): void {
    try {
      this.options.onOutcome?.(outcome)
    } catch {
      /* An observer cannot alter a committed maintenance transaction. */
    }
  }
  start(): void {
    if (this.timer || this.shuttingDown) return
    this.stopped = false
    const poll = (): void => {
      if (this.running || this.polling || this.stopped) return
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
      try {
        const result = await this.service.runOnce(reference, controller.signal)
        return controller.signal.aborted
          ? 'cancelled'
          : result.curation.some((report) => report.status === 'failed')
            ? 'failed'
            : result.curation.length || result.retention.length || result.closedEpisodes.length
              ? 'completed'
              : 'idle'
      } catch (error) {
        if (controller.signal.aborted) return 'cancelled'
        throw error
      }
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
    this.controller?.abort('maintenance_shutdown')
    await Promise.allSettled([this.running, this.polling])
  }
  shutdown(): Promise<void> {
    return (this.shuttingDown ??= (async () => {
      await this.stop()
      await this.service.drain()
    })())
  }
}
