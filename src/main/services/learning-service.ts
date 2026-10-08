import { z } from 'zod'
export { LearningSubmissionSync } from './learning-submission-sync'
import { randomUUID } from 'node:crypto'
import type { ProviderInput } from '../../core/session-types'
import type { LearningStore } from '../../core/memory/learning-store'
import type { LearningReviewer } from '../../core/memory/learning-reviewer'
import type { LearningContext } from '../../core/memory/learning-context'
import { LearningScheduler, type LearningRunOutcome } from '../../core/memory/learning-scheduler'
import { LearningOperationDrain } from '../../core/memory/learning-operation-drain'
import { resolveLearningScope } from '../../core/memory/learning-identity'
import { learningHash } from '../../core/memory/learning-scope'
import { LearningRetention } from '../../core/memory/learning-retention'
import { LearningCurator, type LearningCuratorOptions } from '../../core/memory/learning-curator'
import { LearningFeedbackCollector } from '../../core/memory/learning-feedback'
import {
  LearningValidator,
  validationDatasetHash,
  type LearningValidationDependencies
} from '../../core/memory/learning-validation'
import type { ValidationRunClaim } from '../../core/memory/learning-validation-budget'
import {
  MemoryScopeSchema,
  LearningCorrectionInputSchema as Correction,
  type MemoryScope,
  type LearningEpisode,
  type LearningFeedback,
  type LearningResultInput,
  type LearningHumanFeedbackInput,
  type LearningValidationCase,
  type LearningValidationResult,
  type LearningCurationReport
} from '../../shared/contracts/learning-memory'

interface LearningServiceOptions {
  workspaceId: string
  now?: () => number
  onOutcome?: (outcome: LearningRunOutcome) => void
  curation?: LearningCuratorOptions
  validation?: Partial<LearningValidationDependencies> & {
    dataset(scope: MemoryScope): Promise<{
      cases: LearningValidationCase[]
      knowledgeVersion: string
      policyVersion: string
      validatorVersion: string
    }>
    forRun?(scope: MemoryScope, run: ValidationRunClaim): LearningValidationDependencies
  }
}

/** Product events are idempotent; learning outcomes never determine sending authority. */
export class LearningService {
  readonly scheduler: LearningScheduler
  private readonly now: () => number
  private retentionTimer: ReturnType<typeof setInterval> | null = null
  private lastRetentionAt = 0
  private validationTimer: ReturnType<typeof setInterval> | null = null
  private validationController: AbortController | null = null
  private autoChecking = false
  private lastForegroundEndedAt: number | undefined
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null
  private maintenanceController: AbortController | null = null
  private readonly operations = new LearningOperationDrain()
  private stopped = false
  private shuttingDown: Promise<void> | null = null
  constructor(
    readonly store: LearningStore,
    reviewer: LearningReviewer,
    readonly options: LearningServiceOptions
  ) {
    z.string().trim().min(1).max(128).parse(options.workspaceId)
    this.now = options.now ?? Date.now
    this.scheduler = new LearningScheduler(store, reviewer, options.onOutcome, this.now)
  }
  start(): void {
    if (this.retentionTimer || this.shuttingDown) return
    this.stopped = false
    const runRetention = (): void => {
      if (this.scheduler.isForegroundActive()) return
      try {
        new LearningRetention(this.store).run(this.now())
        this.store.assembler.flushIdle(this.now())
        this.lastRetentionAt = this.now()
      } catch {
        console.error('[Learning] 案例保留期清理未完成，将在空闲时重试。')
      }
    }
    runRetention()
    this.retentionTimer = setInterval(() => {
      if (!this.scheduler.isForegroundActive()) {
        try {
          this.store.assembler.flushIdle(this.now())
        } catch {
          console.error('[Learning] 问题案例关闭未完成，将在空闲时重试。')
        }
      }
      if (this.now() - this.lastRetentionAt >= 3600000) runRetention()
    }, 60000)
    this.retentionTimer.unref()
    this.scheduler.start()
    this.validationTimer = setInterval(() => {
      void this.runAutoValidationOnce().catch(() => {})
    }, 2000)
    this.validationTimer.unref()
    this.maintenanceTimer = setInterval(() => {
      void this.runMaintenanceOnce().catch(() => {})
    }, 60000)
    this.maintenanceTimer.unref()
  }
  stop(): void {
    this.stopped = true
    this.scheduler.stop()
    this.validationController?.abort('validation_cancelled')
    this.maintenanceController?.abort('curation_cancelled')
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer)
    this.maintenanceTimer = null
    if (this.validationTimer) clearInterval(this.validationTimer)
    this.validationTimer = null
    if (this.retentionTimer) clearInterval(this.retentionTimer)
    this.retentionTimer = null
  }
  shutdown(): Promise<void> {
    this.stop()
    return (this.shuttingDown ??= (async () => {
      await Promise.all([this.scheduler.shutdown(), this.operations.drain()])
      await this.store.validationBudget.drain()
    })())
  }
  foregroundStarted(): void {
    this.validationController?.abort('validation_cancelled')
    this.maintenanceController?.abort('curation_cancelled')
    this.scheduler.foregroundStarted()
  }
  foregroundEnded(): void {
    this.scheduler.foregroundEnded()
    if (this.stopped) return
    this.lastForegroundEndedAt = this.now()
    try {
      for (const scope of this.scopes()) this.store.curation.touch(scope, this.now())
    } catch {
      /* Background bookkeeping cannot interrupt a valid reply. */
    }
  }
  resolveScope(input: ProviderInput): MemoryScope | null {
    return resolveLearningScope(this.options.workspaceId, input.binding ?? null)
  }
  accountScope(platform: ProviderInput['appType']): MemoryScope {
    return {
      workspaceId: this.options.workspaceId,
      platform: platform === 'wechat' || platform === 'wework' ? platform : 'generic'
    }
  }
  assertScope(scope: MemoryScope): MemoryScope {
    const parsed = MemoryScopeSchema.parse(scope)
    if (parsed.workspaceId !== this.options.workspaceId)
      throw new Error('learning_scope_unavailable')
    return parsed
  }
  scopes(): MemoryScope[] {
    return this.store.scopes().filter((scope) => scope.workspaceId === this.options.workspaceId)
  }
  onDraft(
    input: ProviderInput,
    context: LearningContext | null,
    draft: string,
    trustedScope?: MemoryScope
  ): LearningEpisode {
    const query = (input.extractedText || input.ocrText || '').trim()
    if (!query) throw new Error('learning_input_missing')
    const generationId = z.string().trim().min(1).max(128).parse(input.learningGenerationId)
    // Explicit object selection is checked by the host; a model or screen name cannot supply this override.
    const verified =
      this.resolveScope(input) ?? (trustedScope ? this.assertScope(trustedScope) : null)
    const scope = verified ?? {
      ...this.accountScope(input.appType),
      conversationId: `unassigned:${learningHash(generationId)}`
    }
    const sourceId = `generation:${learningHash(generationId)}`,
      old = this.store.findEpisode(scope, sourceId)
    const refs =
      context?.snapshot.items.map((item) => ({ id: item.id, revision: item.revision })) ?? []
    const episode = this.store.recordGeneratedEpisode(
      scope,
      generationId,
      {
        sourceId,
        identityStatus: verified ? 'verified' : 'unassigned',
        topic: query.slice(0, 240),
        startedAt: old?.startedAt ?? this.now(),
        endedAt: old?.endedAt ?? this.now(),
        outcome: 'unknown',
        messages: [
          {
            sourceId: `input:${learningHash(generationId)}`,
            role: 'customer',
            text: query.slice(0, 10000)
          }
        ],
        draft
      },
      refs,
      verified ? input.learningProblemId : undefined
    )
    return episode
  }
  correct(
    scope: MemoryScope,
    episodeId: string,
    input: z.infer<typeof Correction>
  ): LearningEpisode {
    this.assertScope(scope)
    return this.store.recordCorrection(scope, episodeId, input)
  }
  feedback(scope: MemoryScope, input: LearningFeedback): void {
    this.assertScope(scope)
    new LearningFeedbackCollector(this.store).record(scope, input)
  }
  confirmResult(
    scope: MemoryScope,
    episodeId: string,
    input: LearningResultInput
  ): LearningEpisode {
    this.assertScope(scope)
    return this.store.recordResult(scope, episodeId, input)
  }
  humanFeedback(scope: MemoryScope, episodeId: string, input: LearningHumanFeedbackInput): void {
    this.assertScope(scope)
    this.store.recordEmployeeFeedback(scope, episodeId, input)
  }
  validateCandidate(
    scope: MemoryScope,
    id: string,
    revision: number,
    callerSignal: AbortSignal = new AbortController().signal
  ): Promise<LearningValidationResult> {
    return this.operations.track(this.validateCandidateCore(scope, id, revision, callerSignal))
  }
  private async validateCandidateCore(
    scope: MemoryScope,
    id: string,
    revision: number,
    callerSignal: AbortSignal = new AbortController().signal
  ): Promise<LearningValidationResult> {
    if (this.stopped) return { status: 'failed', reasons: ['validation_cancelled'] }
    this.assertScope(scope)
    if (this.validationController || this.maintenanceController || this.scheduler.isBusy())
      return { status: 'failed', reasons: ['learning_background_busy'] }
    const controller = new AbortController(),
      signal = AbortSignal.any([callerSignal, controller.signal])
    this.validationController = controller
    const timer = setTimeout(
      () => controller.abort('validation_cancelled'),
      this.store.settings(scope).reviewTimeoutMs * 12
    )
    let run: ValidationRunClaim | null = null,
      basisHash: string | undefined,
      onAbort: (() => void) | undefined
    let result: LearningValidationResult
    const execute = async (): Promise<LearningValidationResult> => {
      if (signal.aborted) throw new Error('validation_cancelled')
      if (this.store.settings(scope).mode === 'off')
        return { status: 'failed', reasons: ['learning_disabled'] }
      if (!this.options.validation)
        return { status: 'insufficient', reasons: ['validation_unconfigured'] }
      const validation = this.options.validation
      const source = await validation.dataset(scope)
      if (signal.aborted) throw new Error('validation_cancelled')
      this.store.get(scope, id)
      const environment = {
        knowledgeVersion: source.knowledgeVersion,
        policyVersion: source.policyVersion,
        validatorVersion: source.validatorVersion,
        datasetHash: validationDatasetHash(source.cases)
      }
      basisHash = this.validationBasis(scope, id, revision, environment)
      run = this.store.validationBudget.begin(scope, `validation:${randomUUID()}`)
      const dependencies =
        validation.forRun?.(scope, run) ??
        (validation.replay && validation.assessRisk
          ? { replay: validation.replay, assessRisk: validation.assessRisk }
          : undefined)
      if (!dependencies) return { status: 'insufficient', reasons: ['validation_unconfigured'] }
      const refreshEnvironment = async (): Promise<typeof environment> => {
        const current = await validation.dataset(scope)
        return {
          knowledgeVersion: current.knowledgeVersion,
          policyVersion: current.policyVersion,
          validatorVersion: current.validatorVersion,
          datasetHash: validationDatasetHash(current.cases)
        }
      }
      const checked = await new LearningValidator(this.store, {
        ...dependencies,
        refreshEnvironment
      }).validate(
        {
          scope,
          memoryId: id,
          revision,
          cases: source.cases,
          knowledgeVersion: source.knowledgeVersion,
          policyVersion: source.policyVersion
        },
        signal
      )
      if (checked.status === 'passed') {
        checked.activated = false
        if (signal.aborted) throw new Error('validation_cancelled')
        const fresh = await refreshEnvironment()
        if (signal.aborted) throw new Error('validation_cancelled')
        this.store.get(scope, id)
        this.store.validation.setEnvironment(scope, fresh)
        if (signal.aborted) throw new Error('validation_cancelled')
        if (this.store.settings(scope).mode === 'auto') {
          this.store.activateValidated(scope, id, revision, checked.grantId!)
          checked.activated = true
        }
      }
      return checked
    }
    try {
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(new Error('validation_cancelled'))
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
      })
      result = await Promise.race([this.operations.track(execute()), aborted])
    } catch (error) {
      result = {
        status: 'failed',
        reasons: [
          error instanceof Error && /^[a-z_]{1,100}$/.test(error.message)
            ? error.message
            : 'validation_failed'
        ]
      }
    } finally {
      clearTimeout(timer)
      if (onAbort) signal.removeEventListener('abort', onAbort)
      if (run) {
        try {
          this.store.validationBudget.end(run, signal.aborted ? 'cancelled' : 'completed')
        } catch {
          /* Shutdown must not recreate a closed store. */
        }
      }
      this.validationController = null
    }
    if (basisHash) result.basisHash = basisHash
    if (!result.reasons.includes('learning_background_busy')) {
      try {
        this.store.validation.recordReport(scope, id, revision, result)
      } catch {
        /* Forgotten scopes are never recreated to retain a report. */
      }
    }
    return result
  }
  private validationBasis(
    scope: MemoryScope,
    id: string,
    revision: number,
    environment: {
      knowledgeVersion: string
      policyVersion: string
      validatorVersion: string
      datasetHash: string
    }
  ): string {
    const record = this.store.get(scope, id)
    this.store.validation.setEnvironment(scope, environment)
    return learningHash({
      id,
      revision,
      environment,
      environmentStamp: this.store.validation.environmentStamp(scope),
      currentRevision: record.currentRevision,
      activeRevision: record.activeRevision
    })
  }
  runAutoValidationOnce(): Promise<'idle' | 'completed'> {
    return this.operations.track(this.runAutoValidationCore())
  }
  private async runAutoValidationCore(): Promise<'idle' | 'completed'> {
    if (
      this.stopped ||
      this.autoChecking ||
      this.validationController ||
      this.maintenanceController ||
      this.scheduler.isBusy() ||
      !this.options.validation
    )
      return 'idle'
    this.autoChecking = true
    try {
      for (const scope of this.scopes()) {
        const settings = this.store.settings(scope)
        if (
          settings.mode !== 'auto' ||
          (this.lastForegroundEndedAt !== undefined &&
            this.now() < this.lastForegroundEndedAt + settings.idleDelayMs)
        )
          continue
        for (const memory of this.store.list(scope)) {
          if (
            memory.pinned ||
            memory.state === 'archived' ||
            memory.currentRevision === memory.activeRevision ||
            this.now() < memory.updatedAt + settings.idleDelayMs
          )
            continue
          const source = await this.options.validation.dataset(scope)
          if (this.stopped || this.scheduler.isBusy() || this.maintenanceController) return 'idle'
          const basis = this.validationBasis(scope, memory.id, memory.currentRevision, {
            knowledgeVersion: source.knowledgeVersion,
            policyVersion: source.policyVersion,
            validatorVersion: source.validatorVersion,
            datasetHash: validationDatasetHash(source.cases)
          })
          const reports = this.store.validation
            .reports(scope, memory.id)
            .filter((report) => report.result.basisHash === basis)
          const latest = reports[0]
          if (latest?.result.status === 'insufficient') continue
          if (latest?.result.status === 'passed' && latest.result.grantId) {
            try {
              this.store.activateValidated(
                scope,
                memory.id,
                memory.currentRevision,
                latest.result.grantId
              )
              this.store.validation.recordReport(scope, memory.id, memory.currentRevision, {
                ...latest.result,
                activated: true
              })
              return 'completed'
            } catch {
              /* A stale or consumed grant requires a fresh validation. */
            }
          }
          if (latest?.result.reasons.includes('validation_budget_exhausted')) {
            if (
              new Date(latest.createdAt).toISOString().slice(0, 10) ===
              new Date(this.now()).toISOString().slice(0, 10)
            )
              continue
          } else if (
            reports.filter(
              (report) =>
                report.result.status === 'failed' &&
                !report.result.reasons.includes('validation_cancelled')
            ).length >= settings.maxAttempts
          )
            continue
          if (latest && this.now() < latest.createdAt + settings.idleDelayMs) continue
          const result = await this.validateCandidate(scope, memory.id, memory.currentRevision)
          return result.reasons.includes('learning_background_busy') ? 'idle' : 'completed'
        }
      }
      return 'idle'
    } finally {
      this.autoChecking = false
    }
  }
  curate(scope: MemoryScope, dryRun: boolean): Promise<LearningCurationReport> {
    return this.operations.track(this.curateCore(scope, dryRun))
  }
  private async curateCore(scope: MemoryScope, dryRun: boolean): Promise<LearningCurationReport> {
    if (this.stopped) throw new Error('curation_cancelled')
    this.assertScope(scope)
    if (
      !dryRun &&
      (this.scheduler.isBusy() || this.validationController || this.maintenanceController)
    )
      throw new Error('learning_background_busy')
    const controller = new AbortController()
    if (!dryRun) this.maintenanceController = controller
    try {
      return await new LearningCurator(this.store, this.options.curation).run(
        scope,
        { dryRun, now: this.now() },
        controller.signal
      )
    } finally {
      if (!dryRun) this.maintenanceController = null
    }
  }
  runMaintenanceOnce(): Promise<'idle' | 'completed'> {
    return this.operations.track(this.runMaintenanceCore())
  }
  private async runMaintenanceCore(): Promise<'idle' | 'completed'> {
    if (
      this.stopped ||
      this.scheduler.isBusy() ||
      this.validationController ||
      this.maintenanceController
    )
      return 'idle'
    for (const scope of this.scopes()) {
      if (this.stopped) return 'idle'
      const settings = this.store.settings(scope)
      if (
        settings.mode === 'off' ||
        !settings.curationEnabled ||
        (this.lastForegroundEndedAt !== undefined &&
          this.now() < this.lastForegroundEndedAt + 7200000)
      )
        continue
      const report = await this.curate(scope, false)
      if (
        report.status === 'completed' ||
        report.status === 'initialized' ||
        report.status === 'failed'
      )
        return 'completed'
    }
    return 'idle'
  }
  review(scope: MemoryScope, episodeId: string, sourceId: string): string {
    this.assertScope(scope)
    const job = this.store.jobs.enqueue(scope, episodeId, 'manual', sourceId)
    if (!job) throw new Error('learning_disabled')
    return job.id
  }
}
