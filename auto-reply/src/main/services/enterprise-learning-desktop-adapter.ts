import type { AgentRegistration } from './agent-registration'
import {
  LearningDesktopRequests,
  type LearningMemoryDesktopApi
} from '../../shared/contracts/learning-desktop'
import { MemoryScopeSchema, type MemoryScope } from '../../shared/contracts/learning-memory'
import { learningHash } from '../../core/memory/learning-scope'

export const enterpriseLearningDesktopMethods = [
  'learningEpisode',
  'learningModelDirectory',
  'learningSnapshot',
  'learningDetail',
  'learningSettings',
  'learningAct',
  'learningManual',
  'learningReview',
  'learningCancel',
  'learningCalibration',
  'learningReports',
  'learningSearch',
  'learningValidate',
  'learningCurate',
  'learningEpisodeCorrection',
  'learningEpisodeResult',
  'learningEpisodeFeedback'
] as const
export type EnterpriseLearningDesktopClient = Pick<
  AgentRegistration,
  'status' | (typeof enterpriseLearningDesktopMethods)[number]
>
type Input<K extends keyof LearningMemoryDesktopApi> = Parameters<LearningMemoryDesktopApi[K]>[0]

/** Uses the same registered client; there is no renderer credential or fallback store. */
export class EnterpriseLearningDesktopAdapter implements LearningMemoryDesktopApi {
  private readonly requests = new Map<AbortController, Promise<unknown>>()
  private epoch = 0
  private forgetting = false
  constructor(
    private readonly client: EnterpriseLearningDesktopClient,
    private readonly forget: (scope: MemoryScope) => Promise<void>,
    private readonly available: () => boolean
  ) {}

  scope(raw?: MemoryScope): MemoryScope {
    if (this.forgetting) throw new Error('learning_forget_in_progress')
    const status = this.client.status(),
      device = status.scope
    if (
      !this.available() ||
      !device ||
      !status.serverUrl ||
      !['registered', 'connected'].includes(status.state)
    )
      throw new Error('learning_scope_unavailable')
    const owned: MemoryScope = {
      workspaceId: `enterprise:${learningHash({ tenant: device.tenant_id, account: device.account_id })}`,
      tenantId: device.tenant_id,
      accountId: device.account_id,
      platform: device.platform
    }
    if (raw === undefined) return owned
    const selected = MemoryScopeSchema.parse(raw)
    if (
      selected.workspaceId !== owned.workspaceId ||
      selected.tenantId !== owned.tenantId ||
      selected.accountId !== owned.accountId ||
      selected.platform !== owned.platform
    )
      throw new Error('learning_scope_unavailable')
    return selected
  }
  async stop(): Promise<void> {
    this.epoch++
    const pending = [...this.requests]
    for (const [controller] of pending) controller.abort()
    await Promise.allSettled(pending.map(([, work]) => work))
  }
  private run<T>(
    raw: MemoryScope | undefined,
    operation: (scope: MemoryScope, signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const scope = this.scope(raw),
      status = this.client.status(),
      epoch = this.epoch
    const controller = new AbortController()
    let onAbort!: () => void
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error('learning_cancelled'))
      controller.signal.addEventListener('abort', onAbort, { once: true })
    })
    const work = (async () => {
      try {
        const value = await Promise.race([operation(scope, controller.signal), aborted])
        if (
          epoch !== this.epoch ||
          !this.available() ||
          learningHash({ serverUrl: status.serverUrl, scope: status.scope }) !==
            learningHash({
              serverUrl: this.client.status().serverUrl,
              scope: this.client.status().scope
            })
        )
          throw new Error('learning_scope_unavailable')
        this.scope(scope)
        return value
      } finally {
        controller.signal.removeEventListener('abort', onAbort)
        this.requests.delete(controller)
      }
    })()
    this.requests.set(controller, work)
    return work
  }
  snapshot(input?: Input<'snapshot'>): ReturnType<LearningMemoryDesktopApi['snapshot']> {
    const value = LearningDesktopRequests.snapshot.parse(input ?? {})
    return this.run(value.scope, (scope, signal) => this.client.learningSnapshot(scope, signal))
  }
  detail(input: Input<'detail'>): ReturnType<LearningMemoryDesktopApi['detail']> {
    const value = LearningDesktopRequests.detail.parse(input)
    return this.run(value.scope, (scope, signal) =>
      this.client.learningDetail(scope, value.id, signal)
    )
  }
  settings(input: Input<'settings'>): ReturnType<LearningMemoryDesktopApi['settings']> {
    const value = LearningDesktopRequests.settings.parse(input)
    return this.run(value.scope, (scope, signal) =>
      this.client.learningSettings(scope, value.patch, signal)
    )
  }
  act(input: Input<'act'>): ReturnType<LearningMemoryDesktopApi['act']> {
    const value = LearningDesktopRequests.act.parse(input)
    return this.run(value.scope, (scope, signal) =>
      this.client.learningAct({ ...value, scope }, signal)
    )
  }
  manual(input: Input<'manual'>): ReturnType<LearningMemoryDesktopApi['manual']> {
    const { scope, ...value } = LearningDesktopRequests.manual.parse(input)
    return this.run(scope, (selected, signal) =>
      this.client.learningManual(selected, value, signal)
    )
  }
  review(input: Input<'review'>): ReturnType<LearningMemoryDesktopApi['review']> {
    const { scope, ...value } = LearningDesktopRequests.review.parse(input)
    return this.run(scope, (selected, signal) =>
      this.client.learningReview(selected, value, signal)
    )
  }
  private cancelJob(input: Input<'cancel'>): Promise<void> {
    const value = LearningDesktopRequests.cancel.parse(input)
    return this.run(value.scope, (scope, signal) =>
      this.client.learningCancel(scope, value.jobId, signal)
    )
  }
  cancel(input: Input<'cancel'>): Promise<void> {
    return this.cancelJob(input)
  }
  async forgetScope(
    input: Input<'forgetScope'>
  ): ReturnType<LearningMemoryDesktopApi['forgetScope']> {
    const value = LearningDesktopRequests['forget-scope'].parse(input)
    this.scope(value.scope)
    await this.stop()
    return this.run(value.scope, async (scope) => {
      this.forgetting = true
      try {
        await this.forget(scope)
      } finally {
        this.forgetting = false
      }
    })
  }
  correct(input: Input<'correct'>): ReturnType<LearningMemoryDesktopApi['correct']> {
    const value = LearningDesktopRequests.correct.parse(input)
    return this.run(value.scope, (scope, signal) =>
      this.client.learningEpisodeCorrection({ ...value, scope }, signal)
    )
  }
  confirmResult(
    input: Input<'confirmResult'>
  ): ReturnType<LearningMemoryDesktopApi['confirmResult']> {
    const value = LearningDesktopRequests.result.parse(input)
    return this.run(value.scope, (scope, signal) =>
      this.client.learningEpisodeResult({ ...value, scope }, signal)
    )
  }
  feedback(input: Input<'feedback'>): ReturnType<LearningMemoryDesktopApi['feedback']> {
    const value = LearningDesktopRequests.feedback.parse(input)
    return this.run(value.scope, (scope, signal) =>
      this.client.learningEpisodeFeedback({ ...value, scope }, signal)
    )
  }
  episode(input: Input<'episode'>): ReturnType<LearningMemoryDesktopApi['episode']> {
    const value = LearningDesktopRequests.episode.parse(input)
    return this.run(value.scope, (scope, signal) =>
      this.client.learningEpisode(scope, value.episodeId, signal)
    )
  }
  modelDirectory(
    input: Input<'modelDirectory'>
  ): ReturnType<LearningMemoryDesktopApi['modelDirectory']> {
    const value = LearningDesktopRequests['model-directory'].parse(input)
    return this.run(value.scope, (scope, signal) =>
      this.client.learningModelDirectory(scope, signal)
    )
  }
  calibration(input: Input<'calibration'>): ReturnType<LearningMemoryDesktopApi['calibration']> {
    const value = LearningDesktopRequests.calibration.parse(input)
    return this.run(value.scope, (scope, signal) =>
      this.client.learningCalibration(scope, undefined, signal)
    )
  }
  importCalibration(
    input: Input<'importCalibration'>
  ): ReturnType<LearningMemoryDesktopApi['importCalibration']> {
    const value = LearningDesktopRequests['import-calibration'].parse(input)
    return this.run(value.scope, (scope, signal) =>
      this.client.learningCalibration(scope, value.input, signal)
    )
  }
  validate(input: Input<'validate'>): ReturnType<LearningMemoryDesktopApi['validate']> {
    const value = LearningDesktopRequests.validate.parse(input)
    return this.run(value.scope, (scope, signal) =>
      this.client.learningValidate(scope, value.id, value.expectedRevision, signal)
    )
  }
  curate(input: Input<'curate'>): ReturnType<LearningMemoryDesktopApi['curate']> {
    const value = LearningDesktopRequests.curate.parse(input)
    return this.run(value.scope, (scope, signal) =>
      this.client.learningCurate(scope, value.dryRun, signal)
    )
  }
  searchEpisodes(
    input: Input<'searchEpisodes'>
  ): ReturnType<LearningMemoryDesktopApi['searchEpisodes']> {
    const value = LearningDesktopRequests.search.parse(input)
    return this.run(value.scope, (scope, signal) =>
      this.client.learningSearch(scope, value.query, value.limit, signal)
    )
  }
  reports(input: Input<'reports'>): ReturnType<LearningMemoryDesktopApi['reports']> {
    const value = LearningDesktopRequests.reports.parse(input)
    return this.run(value.scope, (scope, signal) => this.client.learningReports(scope, signal))
  }
  async assignLegacy(input: Input<'assignLegacy'>): Promise<never> {
    const value = LearningDesktopRequests['assign-legacy'].parse(input)
    this.scope(value.scope)
    throw new Error('enterprise_legacy_assignment_unavailable')
  }
}
