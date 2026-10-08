import type { Ledger } from '../../core/persistence/ledger'
import type { LearningOutboxEvent } from '../../core/persistence/learning-outbox'
import { hashContext } from '../../core/reply/hashes'
import type { WorkbenchScope } from '../../shared/contracts/workbench'
import type { AgentRegistration } from './agent-registration'
import { DeviceRequestError } from './agent-registration'
import { learningHash } from '../../core/memory/learning-scope'
import { LearningSettingsResponseSchema } from '../../shared/contracts/learning-management'

type LearningClient = Partial<
  Pick<
    AgentRegistration,
    | 'recordLearningCorrection'
    | 'recordLearningResult'
    | 'recordLearningFeedback'
    | 'learningSettings'
  >
>

/** Feedback synchronization has no platform, lease, generation or send capability. */
export class LearningOutboxSync {
  private controller?: AbortController
  private flight?: Promise<void>
  private timer?: ReturnType<typeof setInterval>
  private stopped = false
  constructor(
    private readonly ledger: Ledger,
    private readonly client: LearningClient,
    private readonly scope: () => WorkbenchScope | undefined,
    private readonly storageFailure: () => void
  ) {}

  available(): boolean {
    return (
      !this.stopped &&
      !!this.client.recordLearningCorrection &&
      !!this.client.recordLearningResult &&
      !!this.client.recordLearningFeedback
    )
  }

  start(): void {
    if (this.stopped || this.timer || !this.available()) return
    this.timer = setInterval(() => {
      void this.flush().catch(() => {})
    }, 10000)
    this.timer.unref()
  }

  flush(): Promise<void> {
    if (this.flight) return this.flight
    if (this.stopped || !this.available()) return Promise.resolve()
    const controller = new AbortController()
    this.controller = controller
    const work = this.perform(controller)
    this.flight = work
    const settled = (): void => {
      if (this.flight === work) this.flight = undefined
      if (this.controller === controller) this.controller = undefined
    }
    void work.then(settled, settled)
    return work
  }

  private async perform(controller: AbortController): Promise<void> {
    const scope = this.scope()
    if (!scope) return
    const current = (): boolean =>
      !this.stopped &&
      !controller.signal.aborted &&
      hashContext(this.scope() ?? {}) === hashContext(scope)
    let events: LearningOutboxEvent[]
    if (this.client.learningSettings) {
      let conversations: string[]
      try {
        conversations = this.ledger.learning.pendingConversations(scope)
      } catch {
        this.storageFailure()
        throw new Error('learning_storage_unavailable')
      }
      for (const conversationId of conversations) {
        if (!current()) return
        let days: number
        try {
          const settings = await this.bounded(controller.signal, (signal) =>
            this.client.learningSettings!(
              {
                workspaceId: `enterprise:${learningHash({ tenant: scope.tenantId, account: scope.accountId })}`,
                tenantId: scope.tenantId,
                accountId: scope.accountId,
                platform: scope.platform,
                conversationId
              },
              undefined,
              signal
            )
          )
          days = LearningSettingsResponseSchema.parse(settings).caseRetentionDays
        } catch {
          if (!current()) return
          // No replay without current authority. Offline cleanup still honors the
          // persisted policy; only never-configured scopes use the absolute maximum.
          try {
            this.ledger.learning.pending(scope, Date.now(), 365)
          } catch {
            this.storageFailure()
            throw new Error('learning_storage_unavailable')
          }
          return
        }
        if (!current()) return
        try {
          this.ledger.learning.setRetention(scope, conversationId, days)
        } catch {
          this.storageFailure()
          throw new Error('learning_storage_unavailable')
        }
      }
    }
    try {
      events = this.ledger.learning.pending(scope)
    } catch {
      this.storageFailure()
      throw new Error('learning_storage_unavailable')
    }
    for (const event of events) {
      if (!current()) return
      try {
        await this.submit(event, controller.signal)
      } catch (error) {
        if (
          !current() ||
          !(error instanceof DeviceRequestError) ||
          error.code !== 'TASK_INVALIDATED'
        )
          return
        try {
          this.ledger.learning.discard(scope, event.input.sourceId)
        } catch {
          this.storageFailure()
          throw new Error('learning_storage_unavailable')
        }
        continue
      }
      if (!current()) return
      try {
        this.ledger.learning.acknowledge(scope, event.input.sourceId)
      } catch {
        this.storageFailure()
        throw new Error('learning_storage_unavailable')
      }
    }
  }

  private async submit(event: LearningOutboxEvent, parent: AbortSignal): Promise<void> {
    await this.bounded<unknown>(parent, (signal) =>
      event.kind === 'correction'
        ? this.client.recordLearningCorrection!(event.task, event.draft, event.input, signal)
        : event.kind === 'result'
          ? this.client.recordLearningResult!(event.task, event.draft, event.input, signal)
          : this.client.recordLearningFeedback!(event.task, event.draft, event.input, signal)
    )
  }

  private async bounded<T>(
    parent: AbortSignal,
    run: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const controller = new AbortController(),
      signal = AbortSignal.any([parent, controller.signal])
    if (signal.aborted) throw new Error('learning_cancelled')
    const timer = setTimeout(() => controller.abort(), 5000)
    let abort!: () => void
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(new Error('learning_cancelled'))
      signal.addEventListener('abort', abort, { once: true })
    })
    try {
      return await Promise.race([run(signal), cancelled])
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    }
  }

  async cancel(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.controller?.abort()
    await this.flight?.catch(() => {})
  }

  async stop(): Promise<void> {
    this.stopped = true
    await this.cancel()
  }
}
