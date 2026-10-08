import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Postgres } from '../database/postgres'
import { HttpTextGenerator } from '../generation/text-generator'
import { TypeSafeClient } from '../decision/typesafe-client'
import { JevReplyPipeline } from '../reply/jev-pipeline'
import { loadPublication } from '../generation/publication'
import { hashContext } from '../../../src/core/reply/hashes'
import {
  LearningValidator,
  validationDatasetHash
} from '../../../src/core/memory/learning-validation'
import { StructuredMemoryRiskChecker } from '../../../src/core/memory/learning-risk'
import type { LearningReviewTransport } from '../../../src/core/memory/learning-reviewer'
import type { ValidationSnapshot } from '../../../src/core/memory/learning-validation-store'
import {
  boundedMemorySnapshot,
  buildLearningContext
} from '../../../src/core/memory/learning-retrieval'
import { learningHash, memoryScopeKey } from '../../../src/core/memory/learning-scope'
import type {
  MemoryRevision,
  MemorySnapshotItem,
  MemoryActivationGrant,
  LearningValidationResult
} from '../../../src/shared/contracts/learning-memory'
import type { ReplyTask } from '../../../src/shared/contracts/task'
import { EnterpriseLearningRepository } from './learning-repository'
import {
  EnterpriseLearningValidationStore,
  type EnterpriseValidationGuard
} from './learning-validation-store'
import {
  EnterpriseLearningValidationBudget,
  EnterpriseBudgetedValidationTransport,
  createEnterpriseValidationFetch,
  type EnterpriseValidationRun
} from './learning-validation-budget'
import { withLearningAccount, type LearningAccountAuthority } from './learning-account'

export interface EnterpriseLearningProductValidationOptions {
  text: { apiKey: string; baseUrl: string; model: string; expectedModel: string }
  jevApiKey: string
  riskTransport: LearningReviewTransport
  validatorVersion: string
  workerId: string
  fetch?: typeof fetch
  now?: () => number
  monitorIntervalMs?: number
}
export type EnterpriseProductValidationResult = LearningValidationResult & { activated: boolean }
function validationSource(snapshot: ValidationSnapshot): string {
  return learningHash({
    memoryId: snapshot.memory.id,
    revision: snapshot.revision.revision,
    content: snapshot.revision.contentHash,
    evidence: snapshot.evidenceHash,
    corpus: snapshot.corpusVersion,
    environment: snapshot.environment,
    epoch: snapshot.environmentEpoch
  })
}
function terminalVerdict(result: LearningValidationResult): boolean {
  return (
    result.status !== 'failed' ||
    result.reasons.every((reason) =>
      [
        'candidate_severe_error',
        'candidate_coverage_missing',
        'candidate_coverage_regressed',
        'memory_executable_instruction',
        'memory_business_fact',
        'memory_authority_change',
        'memory_unsafe'
      ].includes(reason)
    )
  )
}
function grantMatches(
  grant: MemoryActivationGrant,
  snapshot: ValidationSnapshot,
  at: number
): boolean {
  return (
    grant.validationPolicyVersion === 'independent-human-origin-v2' &&
    grant.usedAt === null &&
    grant.expiresAt > at &&
    grant.memoryId === snapshot.memory.id &&
    grant.revision === snapshot.revision.revision &&
    grant.contentHash === snapshot.revision.contentHash &&
    grant.evidenceHash === snapshot.evidenceHash &&
    grant.corpusVersion === snapshot.corpusVersion &&
    grant.environmentEpoch === snapshot.environmentEpoch &&
    grant.knowledgeVersion === snapshot.environment.knowledgeVersion &&
    grant.policyVersion === snapshot.environment.policyVersion &&
    grant.validatorVersion === snapshot.environment.validatorVersion &&
    grant.datasetHash === snapshot.environment.datasetHash
  )
}
/** Runs isolated calibration through the production pipeline. No live task or send permit is created. */
export class EnterpriseLearningProductValidation {
  private readonly repository: EnterpriseLearningRepository<LearningAccountAuthority>
  private readonly store: EnterpriseLearningValidationStore
  private readonly budget: EnterpriseLearningValidationBudget
  private readonly text: EnterpriseLearningProductValidationOptions['text']
  private readonly generatorVersion: string
  private readonly now: () => number
  private readonly monitorIntervalMs: number
  drain(): Promise<void> {
    return this.budget.drain()
  }
  constructor(
    database: Postgres,
    private readonly authority: LearningAccountAuthority,
    private readonly options: EnterpriseLearningProductValidationOptions
  ) {
    this.text = structuredClone(options.text)
    this.generatorVersion = new HttpTextGenerator(this.text).version
    // Validate trusted configuration before any reservation or network dispatch.
    new TypeSafeClient({ apiKey: options.jevApiKey, maxAttempts: 1 })
    z.string().trim().min(1).max(128).parse(options.workerId)
    this.monitorIntervalMs = z
      .number()
      .int()
      .min(1)
      .max(1000)
      .parse(options.monitorIntervalMs ?? 500)
    this.now = options.now ?? Date.now
    this.repository = new EnterpriseLearningRepository(authority, options)
    this.store = new EnterpriseLearningValidationStore(authority, options)
    this.budget = new EnterpriseLearningValidationBudget(database, authority, options)
  }
  /** Restartable discovery. Only auto mode and an unvalidated automatic candidate can spend tokens. */
  async nextCandidate(
    reference: string
  ): Promise<{ conversationId: string | null; memoryId: string; revision: number } | null> {
    const rows = await withLearningAccount(
      this.authority,
      reference,
      null,
      async (db, account) =>
        (
          await db.query(
            `SELECT m.id,m.conversation_id,m.current_revision FROM learning_memories m
        JOIN learning_revisions r ON (r.tenant_id,r.account_id,r.memory_id,r.revision)=(m.tenant_id,m.account_id,m.id,m.current_revision)
        WHERE m.tenant_id=$1 AND m.account_id=$2 AND m.state IN ('pending','active') AND NOT m.pinned
        AND (m.active_revision IS NULL OR m.current_revision>m.active_revision)
        AND r.payload->>'source' IN ('review','curator') AND r.payload->'content'->>'kind'<>'preference'
        ORDER BY m.updated_at,m.id LIMIT 100`,
            [account.tenant_id, account.account_id]
          )
        ).rows,
      this.options.now
    )
    for (const row of rows) {
      const conversationId = String(row.conversation_id) || null
      try {
        const port = await this.store.bind(reference, conversationId)
        const settings = await port.settings(port.scope)
        if (settings.mode !== 'auto') continue
        const dataset = await this.store.calibration(reference, conversationId)
        if (
          dataset.cases.length < 5 ||
          new Set(dataset.cases.map((entry) => entry.conversationId)).size < 5
        )
          continue
        const snapshot = await port.validation.capture(
          port.scope,
          String(row.id),
          Number(row.current_revision)
        )
        if (
          dataset.cases.some(
            (entry) =>
              snapshot.evidenceConversationIds.includes(entry.conversationId) ||
              snapshot.revision.evidence.some((ref) => ref.episodeId === entry.caseId)
          )
        )
          continue
        const history = await withLearningAccount(
          this.authority,
          reference,
          conversationId,
          async (db, account, conversation, at) => {
            const reports = (
              await db.query(
                `SELECT payload FROM learning_validation_reports WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3
            AND memory_id=$4 AND revision=$5 AND payload->'result'->>'basisHash'=$6`,
                [
                  account.tenant_id,
                  account.account_id,
                  conversation,
                  row.id,
                  Number(row.current_revision),
                  validationSource(snapshot)
                ]
              )
            ).rows
            const attempts = (
              await db.query(
                'SELECT state,finished_at FROM learning_validation_runs WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3 AND source_id=$4 ORDER BY created_at DESC,id DESC',
                [account.tenant_id, account.account_id, conversation, validationSource(snapshot)]
              )
            ).rows
            return { reports, attempts, at }
          },
          this.options.now
        )
        if (
          history.reports.some(
            (report) =>
              report.payload.result.status !== 'passed' &&
              terminalVerdict(report.payload.result as LearningValidationResult)
          )
        )
          continue
        const previous = history.attempts[0]
        if (
          history.attempts.length >= settings.maxAttempts ||
          (previous?.finished_at != null &&
            previous.state !== 'completed' &&
            history.at <
              Number(previous.finished_at) +
                Math.min(60000, 5000 * 2 ** (history.attempts.length - 1)))
        )
          continue
        return { conversationId, memoryId: String(row.id), revision: Number(row.current_revision) }
      } catch {
        /* A stale/forgotten candidate cannot block discovery of other current ones. */
      }
    }
    return null
  }
  async validate(
    reference: string,
    conversationId: string | null,
    memoryId: string,
    revision: number,
    external?: AbortSignal
  ): Promise<EnterpriseProductValidationResult> {
    const controller = new AbortController()
    const signal = external ? AbortSignal.any([external, controller.signal]) : controller.signal
    let run: EnterpriseValidationRun | undefined
    let monitor: ReturnType<typeof setInterval> | undefined
    let checking = false
    let interruption: string | undefined
    const code = (error: unknown): string =>
      error instanceof Error && /^[a-z_]{1,100}$/.test(error.message)
        ? error.message
        : 'validation_failed'
    const stopMonitor = (): void => {
      if (monitor) clearInterval(monitor)
      monitor = undefined
    }
    try {
      if (signal.aborted) throw new Error('validation_cancelled')
      const preflight = await this.store.bind(reference, conversationId)
      const settings = await preflight.settings(preflight.scope)
      if (settings.mode === 'off') throw new Error('learning_disabled')
      const dataset = await this.store.calibration(reference, conversationId)
      if (
        dataset.cases.length < 5 ||
        dataset.cases.some((example) => !example.humanLabelled) ||
        new Set(dataset.cases.map((example) => example.conversationId)).size < 5
      )
        return {
          status: 'insufficient',
          reasons: ['independent_human_cases_required'],
          activated: false
        }
      const snapshot = await preflight.validation.capture(preflight.scope, memoryId, revision)
      if (
        dataset.cases.some(
          (example) =>
            snapshot.evidenceConversationIds.includes(example.conversationId) ||
            snapshot.revision.evidence.some((ref) => ref.episodeId === example.caseId)
        )
      )
        return {
          status: 'insufficient',
          reasons: ['calibration_training_overlap'],
          activated: false
        }
      if (snapshot.revision.content.kind === 'preference')
        return { status: 'insufficient', reasons: ['preference_requires_human'], activated: false }
      if (validationDatasetHash(dataset.cases) !== snapshot.environment.datasetHash)
        throw new Error('validation_environment_changed')
      const basis = await withLearningAccount(
        this.authority,
        reference,
        conversationId,
        async (db, account) => {
          const publication = await loadPublication(db, account)
          if (publication.textGeneratorVersion !== this.generatorVersion)
            throw new Error('validation_reply_model_changed')
          return { account, publication }
        },
        this.options.now
      )
      await preflight.validation.assertCurrent(snapshot)
      if (signal.aborted) throw new Error('validation_cancelled')
      const cached = (await this.store.grants(reference, conversationId, memoryId)).find((grant) =>
        grantMatches(grant, snapshot, this.now())
      )
      if (cached && settings.mode !== 'auto')
        return {
          status: 'passed',
          reasons: [],
          grantId: cached.id,
          activated: false,
          baselineCovered: cached.baselineCovered,
          candidateCovered: cached.candidateCovered,
          caseCount: cached.caseIds.length,
          basisHash: validationSource(snapshot)
        }
      // Each arm is pre-decision + generation + audit. The risk check is one additional call.
      const source = validationSource(snapshot)
      run = await this.budget.begin(
        reference,
        conversationId,
        source,
        this.options.workerId,
        cached ? 1 : dataset.cases.length * 6 + 1
      )
      const claim = run
      const guard: EnterpriseValidationGuard = async (db, account, at) => {
        if (signal.aborted) throw new Error(interruption ?? 'validation_cancelled')
        if (memoryScopeKey(claim.scope) !== memoryScopeKey(preflight.scope))
          throw new Error('learning_scope_mismatch')
        await this.budget.assertCurrentWithin(db, account, claim, at)
        if (learningHash(await loadPublication(db, account)) !== learningHash(basis.publication))
          throw new Error('validation_environment_changed')
      }
      const port = await this.store.bind(reference, conversationId, guard)
      await port.validation.assertCurrent(snapshot)
      monitor = setInterval(() => {
        if (checking || signal.aborted) return
        checking = true
        void this.budget.trackRequest(
          Promise.resolve(port.validation.assertCurrent(snapshot))
            .catch((error) => {
              interruption = code(error)
              controller.abort(interruption)
            })
            .finally(() => {
              checking = false
            })
        )
      }, this.monitorIntervalMs)
      monitor.unref()
      const risk = new StructuredMemoryRiskChecker(
        new EnterpriseBudgetedValidationTransport(
          this.budget,
          reference,
          claim,
          this.options.riskTransport
        ),
        settings.maxReviewInputTokens,
        settings.reviewModelId
      )
      const generator = new HttpTextGenerator({
        ...this.text,
        timeoutMs: Math.min(30000, claim.timeoutMs),
        fetch: createEnterpriseValidationFetch(
          'text',
          this.budget,
          reference,
          claim,
          this.options.fetch,
          this.text.expectedModel
        )
      })
      const decision = new TypeSafeClient({
        apiKey: this.options.jevApiKey,
        timeoutMs: Math.min(claim.timeoutMs, 30000),
        maxAttempts: 1,
        fetch: createEnterpriseValidationFetch(
          'jev',
          this.budget,
          reference,
          claim,
          this.options.fetch
        )
      })
      const pipeline = new JevReplyPipeline(decision, generator, this.now)
      const item = (value: MemoryRevision): MemorySnapshotItem => ({
        id: value.memoryId,
        revision: value.revision,
        contentHash: value.contentHash,
        scope: snapshot.memory.scope,
        content: value.content,
        evidence: value.evidence,
        expiresAt: value.expiresAt
      })
      const contexts = new Map<string, { baseline: string; candidate: string }>()
      const validator = new LearningValidator(port, {
        assessRisk: async (target, abort) => {
          if (target.memoryId !== memoryId || target.contentHash !== snapshot.revision.contentHash)
            throw new Error('validation_context_changed')
          return risk.assess(target, abort)
        },
        replay: async (example, target, abort) => {
          await port.validation.assertCurrent(snapshot)
          let pair = contexts.get(example.caseId)
          if (!pair) {
            const existing = await this.repository.retrieve(
              reference,
              conversationId,
              example.input
            )
            const limits = { maxEntries: settings.maxEntries, maxTokens: settings.maxContextTokens }
            const baseline = snapshot.replacements?.length
                ? snapshot.replacements.map(item)
                : snapshot.baseline
                  ? [item(snapshot.baseline)]
                  : [],
              candidate = [item(snapshot.revision)]
            const replacedIds = new Set(snapshot.replacements?.map((entry) => entry.memoryId) ?? [])
            const others = existing.items
              .filter((entry) => entry.id !== memoryId && !replacedIds.has(entry.id))
              .slice(0, Math.max(0, settings.maxEntries - Math.max(1, baseline.length)))
            const fits = (entries: MemorySnapshotItem[]): boolean =>
              boundedMemorySnapshot(port.scope, entries, limits).items.length === entries.length
            if (!fits(candidate) || !fits(baseline))
              throw new Error('validation_memory_context_over_budget')
            while (
              others.length &&
              (!fits([...baseline, ...others]) || !fits([...candidate, ...others]))
            )
              others.pop()
            pair = {
              baseline: buildLearningContext(
                boundedMemorySnapshot(port.scope, [...baseline, ...others], limits)
              ),
              candidate: buildLearningContext(
                boundedMemorySnapshot(port.scope, [...candidate, ...others], limits)
              )
            }
            contexts.set(example.caseId, pair)
          }
          if (target && target.memoryId !== memoryId) throw new Error('validation_target_missing')
          const processReference =
            target?.revision === snapshot.revision.revision &&
            target.contentHash === snapshot.revision.contentHash
              ? pair.candidate
              : pair.baseline
          const startedAt = this.now()
          const task: ReplyTask = {
            taskId: randomUUID(),
            identity: {
              tenantId: basis.account.tenant_id,
              employeeId: basis.account.employee_id,
              accountId: basis.account.account_id,
              agentId: basis.account.agent_id,
              platform: basis.account.platform,
              loginEpoch: 0,
              clientInstanceId: claim.id
            },
            conversationId: example.conversationId,
            bindingVersion: 1,
            conversationRevision: 1,
            runEpoch: 1,
            inboundRange: { from: 1, to: 1 },
            contextHash: hashContext(example.input),
            configVersion: basis.publication.configuration.configVersion,
            knowledgeVersion: basis.publication.configuration.knowledgeVersion,
            decisionPolicyVersion: basis.publication.policy.version,
            questionSetVersion: basis.publication.policy.questionSetVersion,
            createdAt: startedAt,
            expiresAt:
              startedAt +
              claim.timeoutMs +
              basis.publication.policy.preBudgetMs +
              basis.publication.policy.postBudgetMs
          }
          const result = await pipeline.run(
            {
              task,
              inbound: [example.input],
              evidence: basis.publication.evidence,
              retrieval: basis.publication.retrieval,
              replyRules: basis.publication.replyRules,
              processReference,
              isCurrent: () => !abort.aborted
            },
            basis.publication.policy,
            abort
          )
          if (abort.aborted) throw new Error(interruption ?? 'validation_cancelled')
          if (result.reasons.includes('decision_or_generation_failed'))
            throw new Error('validation_replay_unavailable')
          await port.validation.assertCurrent(snapshot)
          return {
            text: result.draft?.text ?? '',
            covered: false,
            severeErrors:
              result.status === 'candidate' && result.automaticAllowed && result.factsVerified
                ? []
                : ['replay_pipeline_not_approved']
          }
        }
      })
      const checked: LearningValidationResult = cached
        ? {
            status: 'passed',
            reasons: [],
            grantId: cached.id,
            baselineCovered: cached.baselineCovered,
            candidateCovered: cached.candidateCovered,
            caseCount: cached.caseIds.length
          }
        : await validator.validate(
            {
              scope: port.scope,
              memoryId,
              revision,
              cases: dataset.cases,
              knowledgeVersion: snapshot.environment.knowledgeVersion,
              policyVersion: snapshot.environment.policyVersion
            },
            signal
          )
      checked.basisHash = source
      stopMonitor()
      if (signal.aborted) throw new Error(interruption ?? 'validation_cancelled')
      await this.store.recordReport(
        reference,
        conversationId,
        memoryId,
        revision,
        checked,
        async (db, account, at) => {
          if (signal.aborted) throw new Error(interruption ?? 'validation_cancelled')
          await this.budget.assertCurrentWithin(db, account, claim, at)
        }
      )
      let activated = false
      if (
        checked.status === 'passed' &&
        (await this.repository.settings(reference, conversationId)).mode === 'auto'
      ) {
        await this.store.activateValidated(
          reference,
          conversationId,
          memoryId,
          revision,
          checked.grantId!,
          guard
        )
        activated = true
      }
      // Activation invalidates the old publication. A cleanup failure cannot undo its committed result.
      await this.budget
        .end(reference, claim, terminalVerdict(checked) ? 'completed' : 'failed')
        .catch(() => undefined)
      return { ...checked, activated }
    } catch (error) {
      stopMonitor()
      if (run)
        await this.budget
          .end(reference, run, signal.aborted ? 'cancelled' : 'failed')
          .catch(() => undefined)
      return { status: 'failed', reasons: [interruption ?? code(error)], activated: false }
    } finally {
      stopMonitor()
    }
  }
}
