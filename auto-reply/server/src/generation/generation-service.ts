import { AccountAuthority, type Scope } from '../auth/account-authority'
import type { ModelCallAuthority } from './model-call-authority'
import { ExecutionAuthority } from '../execution/execution-authority'
import { JevReplyPipeline } from '../reply/jev-pipeline'
import { loadPublication, GenerationError, type Publication } from './publication'
import {
  GenerationResultSchema,
  type GenerationInput,
  type GenerationResult,
  type AgentConfigurationSchema
} from '../../../src/shared/contracts/generation'
import {
  parseGenerationInput,
  parseGenerationResult
} from '../../../src/core/reply/generation-validation'
import { z } from 'zod'
import { hashContext, hashDraft } from '../../../src/core/reply/hashes'
import type { ReplyTask } from '../../../src/shared/contracts/task'
import type { PoolClient } from 'pg'
import type {
  EditedReviewInput,
  EditedReviewResult
} from '../../../src/shared/contracts/edited-review'
import {
  parseEditedReviewInput,
  parseEditedReviewResult
} from '../../../src/core/reply/edited-review-validation'
import { explainAssessment } from './assessment-explanation'
import {
  AssessmentEvidenceRequestSchema,
  AssessmentEvidencePageSchema,
  type AssessmentEvidenceRequest,
  type AssessmentEvidencePage
} from '../../../src/shared/contracts/assessment-evidence'
import { KnowledgeEvidenceSchema, evidenceBelongsToTask } from '../reply/jev-pipeline'
import { recordLearningForegroundWithin } from '../learning/learning-account'
import {
  prepareEnterpriseLearningTask,
  assertEnterpriseLearningTaskCurrent
} from '../learning/learning-generation-context'
import { stripLearningBinding } from '../../../src/shared/contracts/learning-task'
import { recordEnterpriseGenerationWithin } from '../learning/learning-events'

/** Bounded central work, including an account limit. Overload does not silently drop a task. */
export class GenerationService {
  private active = 0
  private readonly activeAccounts = new Map<string, number>()
  constructor(
    private readonly authority: AccountAuthority,
    private readonly execution: ExecutionAuthority,
    private readonly pipeline: JevReplyPipeline,
    private readonly textGeneratorVersion: string,
    private readonly maximumConcurrent = 10,
    private readonly modelCalls?: ModelCallAuthority
  ) {
    if (!Number.isInteger(maximumConcurrent) || maximumConcurrent < 1 || maximumConcurrent > 100)
      throw new Error('invalid_generation_capacity')
  }
  async configuration(credential: string): Promise<z.infer<typeof AgentConfigurationSchema>> {
    return this.authority.withLockedAccount(
      credential,
      async (db, s) => {
        const p = await loadPublication(db, s)
        if (p.textGeneratorVersion !== this.textGeneratorVersion)
          throw new GenerationError('CONFIGURATION_CHANGED')
        // Knowledge content and provider secrets are never included in configuration sync.
        return { ...p.configuration, memoryCorpusVersion: p.memoryCorpusVersion }
      },
      true
    )
  }
  async prepare(credential: string, input: GenerationInput): Promise<ReplyTask> {
    const request = parseGenerationInput(structuredClone(input))
    return this.authority.withLockedAccount(credential, async (db, scope) => {
      await this.validateCurrent(db, scope, stripLearningBinding(request.task), true)
      return prepareEnterpriseLearningTask(db, scope, request.task, request.inbound.join('\n'))
    })
  }
  async generate(
    credential: string,
    input: GenerationInput,
    external?: AbortSignal
  ): Promise<GenerationResult> {
    return this.process(credential, parseGenerationInput(structuredClone(input)), external)
  }
  async reviewEdited(
    credential: string,
    input: EditedReviewInput,
    external?: AbortSignal
  ): Promise<EditedReviewResult> {
    const request = parseEditedReviewInput(structuredClone(input))
    return parseEditedReviewResult(
      await this.process(credential, request.generation, external, request),
      request
    )
  }
  async assessmentEvidence(
    credential: string,
    input: AssessmentEvidenceRequest
  ): Promise<AssessmentEvidencePage> {
    const request = AssessmentEvidenceRequestSchema.parse(structuredClone(input))
    // Historical inspection remains available while paused or after the lease expires.
    // Account/device access is rechecked under the same authority lock; no model or permit is used.
    return this.authority.withLockedAccount(
      credential,
      async (db, scope) => {
        const rows = await db.query(
          `SELECT task_json,result_json FROM generation_tasks
         WHERE tenant_id=$1 AND account_id=$2 AND agent_id=$3 AND task_id=$4 AND status='completed'`,
          [scope.tenant_id, scope.account_id, scope.agent_id, request.taskId]
        )
        const row = rows.rows[0]
        if (!row) throw new GenerationError('TASK_CONFLICT')
        const result = GenerationResultSchema.parse(row.result_json),
          task = result.task,
          draft = result.draft
        this.assertScope(task, scope)
        if (
          hashContext(task) !== hashContext(row.task_json) ||
          !draft ||
          task.taskId !== request.taskId ||
          task.contextHash !== request.contextHash ||
          task.knowledgeVersion !== request.knowledgeVersion ||
          draft.draftHash !== request.draftHash ||
          draft.draftRevision !== request.draftRevision ||
          hashDraft(draft.text) !== draft.draftHash
        )
          throw new GenerationError('TASK_CONFLICT')
        const publications = await db.query(
          `SELECT evidence_json FROM generation_publications WHERE tenant_id=$1 AND account_id=$2 AND config_version=$3`,
          [scope.tenant_id, scope.account_id, task.configVersion]
        )
        if (!publications.rows[0]) throw new GenerationError('CONFIGURATION_UNAVAILABLE')
        const knowledge = z
          .array(KnowledgeEvidenceSchema)
          .max(100)
          .parse(publications.rows[0].evidence_json)
        const assessedAt =
          result.explanation?.assessedAt ?? result.review?.reviewedAt ?? task.createdAt
        const available = draft.evidenceIds.flatMap((id) => {
          const item = knowledge.find(
            (e) =>
              e.evidenceId === id &&
              result.intents.includes(e.intent) &&
              evidenceBelongsToTask(e, task, assessedAt)
          )
          return item ? [item] : []
        })
        if (request.offset > available.length) throw new GenerationError('TASK_CONFLICT')
        return AssessmentEvidencePageSchema.parse({
          ...request,
          assessedAt,
          totalAvailable: available.length,
          unavailableReferences: draft.evidenceIds.length - available.length,
          ...(request.offset + 1 < available.length ? { nextOffset: request.offset + 1 } : {}),
          evidence: available.slice(request.offset, request.offset + 1).map((e) => ({
            evidenceId: e.evidenceId,
            intent: e.intent,
            kind: e.kind,
            source: e.source,
            content: e.content,
            validFrom: e.validFrom,
            expiresAt: e.expiresAt
          }))
        })
      },
      true
    )
  }
  private async process(
    credential: string,
    request: GenerationInput,
    external?: AbortSignal,
    edited?: EditedReviewInput
  ): Promise<GenerationResult> {
    const requestHash = hashContext(edited ? { purpose: 'edited_review_v1', ...edited } : request),
      task = request.task
    const scope = await this.authority.authenticate(credential)
    this.assertScope(task, scope)
    if (external?.aborted) throw new GenerationError('CANCELLED')
    const key = hashContext({ tenant: scope.tenant_id, account: scope.account_id })
    if (this.active >= this.maximumConcurrent || (this.activeAccounts.get(key) ?? 0) >= 2)
      throw new GenerationError('GENERATION_OVERLOADED')
    this.active++
    this.activeAccounts.set(key, (this.activeAccounts.get(key) ?? 0) + 1)
    let claimed = false
    try {
      const claim = await this.authority.withLockedAccount(credential, async (db, s) => {
        const publication = await this.validateCurrent(db, s, task, true)
        const learning = await assertEnterpriseLearningTaskCurrent(db, s, task)
        const old = await db.query(
          'SELECT * FROM generation_tasks WHERE tenant_id=$1 AND account_id=$2 AND task_id=$3',
          [s.tenant_id, s.account_id, task.taskId]
        )
        const r = old.rows[0]
        if (r) {
          if (r.request_hash !== requestHash || r.agent_id !== s.agent_id)
            throw new GenerationError('TASK_CONFLICT')
          if (r.status === 'completed') {
            const cached = GenerationResultSchema.parse(r.result_json)
            if (cached.review && cached.review.expiresAt <= Date.now())
              throw new GenerationError('TASK_EXPIRED')
            return { cached: parseGenerationResult(cached, task), publication, learning }
          }
          throw new GenerationError(
            r.status === 'running' ? 'GENERATION_IN_PROGRESS' : 'GENERATION_FAILED'
          )
        }
        await recordLearningForegroundWithin(db, s)
        await db.query(
          `INSERT INTO generation_tasks(tenant_id,account_id,task_id,agent_id,request_hash,task_json,status,expires_at)
          VALUES($1,$2,$3,$4,$5,$6::jsonb,'running',to_timestamp($7/1000.0))`,
          [
            s.tenant_id,
            s.account_id,
            task.taskId,
            s.agent_id,
            requestHash,
            JSON.stringify(task),
            task.expiresAt
          ]
        )
        return { publication, learning }
      })
      if (claim.cached) return claim.cached
      claimed = true
      const controller = new AbortController()
      const timer = setTimeout(
        () => controller.abort('model_timeout'),
        Math.max(1, task.expiresAt - Date.now())
      )
      const signal = external ? AbortSignal.any([external, controller.signal]) : controller.signal
      let result: GenerationResult
      try {
        const context = {
          task,
          inbound: request.inbound,
          context: request.context,
          evidence: claim.publication.evidence,
          ...(claim.learning.text ? { processReference: claim.learning.text } : {}),
          ...(claim.publication.retrieval ? { retrieval: claim.publication.retrieval } : {}),
          ...(claim.publication.replyRules ? { replyRules: claim.publication.replyRules } : {}),
          ...(this.modelCalls
            ? { modelCalls: this.modelCalls.forTask(credential, scope, task) }
            : {}),
          isCurrent: () => !signal.aborted
        }
        const generated = edited
          ? await this.pipeline.reviewEdited(context, claim.publication.policy, edited.edit, signal)
          : await this.pipeline.run(context, claim.publication.policy, signal)
        // A completed assessment can recommend handoff or fail its audits. Retain
        // the exact employee text for a later explicit human confirmation; this
        // creates no automatic candidate or factual approval.
        if (edited && !generated.draft)
          generated.draft = {
            taskId: task.taskId,
            draftRevision: edited.edit.draftRevision,
            draftHash: hashDraft(edited.edit.text),
            text: edited.edit.text,
            action: 'reply',
            evidenceIds: edited.edit.evidenceIds
          }
        result = GenerationResultSchema.parse({
          task,
          status: generated.status,
          automaticAllowed:
            !edited &&
            generated.automaticAllowed &&
            claim.publication.configuration.automaticEnabled,
          factsVerified: generated.factsVerified === true,
          reasons: generated.reasons,
          intents: generated.intents,
          ...(generated.draft ? { draft: generated.draft } : {}),
          ...(generated.review ? { review: generated.review } : {}),
          usage: generated.usage
        })
        result.explanation = explainAssessment(result, claim.publication.evidence)
        result = parseGenerationResult(result, task)
        if (signal.aborted) throw new GenerationError('CANCELLED')
        if (this.modelCalls && result.status === 'candidate')
          await this.modelCalls.assertRecorded(scope, task, Boolean(edited))
        await this.authority.withLockedAccount(credential, async (db, s) => {
          if (signal.aborted) throw new GenerationError('CANCELLED')
          if (result.automaticAllowed)
            await this.execution.recordApprovedCandidateWithin(db, s, result)
          await this.validateCurrent(db, s, task)
          await recordEnterpriseGenerationWithin(db, s, request, result, claim.learning)
          const saved = await db.query(
            `UPDATE generation_tasks SET status='completed',result_json=$4::jsonb,updated_at=clock_timestamp()
            WHERE tenant_id=$1 AND account_id=$2 AND task_id=$3 AND status='running' RETURNING task_id`,
            [s.tenant_id, s.account_id, task.taskId, JSON.stringify(result)]
          )
          if (!saved.rowCount) throw new GenerationError('TASK_CONFLICT')
          await recordLearningForegroundWithin(db, s)
        })
      } finally {
        clearTimeout(timer)
      }
      return result!
    } catch (e) {
      if (claimed) {
        try {
          await this.authority.withLockedAccount(
            credential,
            async (db, s) => {
              await db.query(
                `UPDATE generation_tasks SET status='failed',updated_at=clock_timestamp() WHERE tenant_id=$1 AND account_id=$2 AND task_id=$3 AND status='running'`,
                [s.tenant_id, s.account_id, task.taskId]
              )
              await recordLearningForegroundWithin(db, s)
            },
            true
          )
        } catch {
          /* A revoked credential cannot mutate state; the unfinished row is not replayed. */
        }
      }
      if (e && typeof e === 'object' && 'code' in e && 'message' in e && e.code === 'P0001') {
        if (e.message === 'generation_cluster_overloaded')
          throw new GenerationError('GENERATION_OVERLOADED')
        if (e.message === 'generation_task_expired') throw new GenerationError('TASK_EXPIRED')
        if (
          ['generation_task_immutable', 'generation_task_not_restartable'].includes(
            String(e.message)
          )
        )
          throw new GenerationError('TASK_CONFLICT')
      }
      throw e
    } finally {
      this.active--
      const remaining = (this.activeAccounts.get(key) ?? 1) - 1
      if (remaining) this.activeAccounts.set(key, remaining)
      else this.activeAccounts.delete(key)
    }
  }
  private assertScope(task: ReplyTask, s: Scope): void {
    const i = task.identity
    if (
      i.tenantId !== s.tenant_id ||
      i.accountId !== s.account_id ||
      i.employeeId !== s.employee_id ||
      i.agentId !== s.agent_id ||
      i.platform !== s.platform
    )
      throw new GenerationError('TASK_CONFLICT')
  }
  private async validateCurrent(
    db: PoolClient,
    s: Scope,
    task: ReplyTask,
    preparing = false
  ): Promise<Publication> {
    this.assertScope(task, s)
    const now = Number(
      (await db.query('SELECT floor(extract(epoch from clock_timestamp())*1000)::text AS now'))
        .rows[0].now
    )
    if (task.createdAt > now || task.expiresAt <= now || task.expiresAt - task.createdAt > 60000)
      throw new GenerationError('TASK_EXPIRED')
    const lease = await db.query(
      `SELECT 1 FROM account_leases WHERE tenant_id=$1 AND account_id=$2 AND agent_id=$3 AND login_epoch=$4 AND client_instance_id=$5 AND expires_at>clock_timestamp()`,
      [
        s.tenant_id,
        s.account_id,
        s.agent_id,
        task.identity.loginEpoch,
        task.identity.clientInstanceId
      ]
    )
    if (!lease.rowCount) throw new GenerationError('SESSION_INVALID')
    const p = await loadPublication(db, s),
      c = p.configuration
    if (
      p.textGeneratorVersion !== this.textGeneratorVersion ||
      c.configVersion !== task.configVersion ||
      c.knowledgeVersion !== task.knowledgeVersion ||
      c.decisionPolicyVersion !== task.decisionPolicyVersion ||
      c.questionSetVersion !== task.questionSetVersion
    )
      throw new GenerationError('CONFIGURATION_CHANGED')
    if (!preparing) await assertEnterpriseLearningTaskCurrent(db, s, task)
    return p
  }
}
