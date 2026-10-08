import { z } from 'zod'
import { ReplyTaskSchema, type ReplyTask } from '../../../src/shared/contracts/task'
import { hashContext } from '../../../src/core/reply/hashes'
import type { PoolClient } from 'pg'
import type { Scope } from '../auth/account-authority'
import { learningHash } from '../../../src/core/memory/learning-scope'
import { MemoryReplayReceiptSchema } from '../../../evals/memory/replay'
import { JevResponseSchema } from '../../../src/shared/contracts/decision'
import { ModelStageSchema, type ModelStage } from '../generation/model-call-contracts'
import {
  effectiveLearningSettings,
  withLearningAccount,
  type LearningAccountAuthority
} from './learning-account'
import type { EnterpriseMemoryReplayPacket } from './learning-memory-replay'
import type {
  EnterpriseLearningValidationBudget,
  EnterpriseValidationAdmissionGuard,
  EnterpriseValidationRun
} from './learning-validation-budget'

export interface EvaluationAssignment {
  ordinal: number
  assignmentId: string
  caseId: string
  arm: 'none' | 'baseline' | 'learned'
}
export type EvaluationBasis = Pick<
  EnterpriseMemoryReplayPacket,
  'input' | 'publication' | 'model' | 'methods' | 'episodes' | 'frames'
>
export interface EvaluationCheckpointSnapshot {
  scope: Scope
  basis: EvaluationBasis
  frozen: EnterpriseMemoryReplayPacket['frozen']
  assignments: EvaluationAssignment[]
  receipts: EnterpriseMemoryReplayPacket['receipts']
  state: string
  attemptCount: number
  executionTasks: { assignmentId: string; taskHash: string; task: ReplyTask }[]
}
const parsedStage = (stage: ModelStage, raw: unknown): unknown =>
  stage === 'text'
    ? z
        .strictObject({
          text: z.string().trim().min(1).max(10000),
          evidenceIds: z.array(z.string().min(1).max(128)).min(1).max(100)
        })
        .parse(raw)
    : JevResponseSchema.parse(raw)

const assertExecutionBinding = (
  task: ReplyTask,
  scope: Scope,
  basis: Pick<EvaluationBasis, 'input' | 'publication'>,
  caseId: string
): void => {
  const cases = basis.input.cases.filter((item) => item.caseId === caseId)
  const publication = basis.publication
  if (
    cases.length !== 1 ||
    task.identity.tenantId !== scope.tenant_id ||
    task.identity.accountId !== scope.account_id ||
    task.identity.employeeId !== scope.employee_id ||
    task.identity.agentId !== scope.agent_id ||
    task.identity.platform !== scope.platform ||
    task.conversationId !== cases[0].conversationId ||
    task.configVersion !== publication.configuration.configVersion ||
    task.knowledgeVersion !== publication.configuration.knowledgeVersion ||
    task.decisionPolicyVersion !== publication.policy.version ||
    task.questionSetVersion !== publication.policy.questionSetVersion ||
    task.memorySnapshotHash !== undefined ||
    task.learningContextVersion !== undefined ||
    task.memoryCorpusVersion !== undefined
  )
    throw new Error('evaluation_checkpoint_execution_conflict')
}
type RecordedEvaluationStage = {
  assignment_id: string
  model_call_refs: unknown
  execution_task_hash: string | null
}

/** Worker-only private evidence. These tables are never a learning or generation input. */
export class EnterpriseEvaluationCheckpoint {
  constructor(
    private readonly authority: LearningAccountAuthority,
    private readonly budget: EnterpriseLearningValidationBudget,
    private readonly now?: () => number
  ) {}
  private locked<T>(
    reference: string,
    operation: (db: PoolClient, scope: Scope, conversation: string, at: number) => Promise<T>
  ): Promise<T> {
    return withLearningAccount(this.authority, reference, null, operation, this.now)
  }

  async create(
    reference: string,
    run: EnterpriseValidationRun,
    basis: EvaluationBasis,
    frozen: EnterpriseMemoryReplayPacket['frozen'],
    assignments: EvaluationAssignment[],
    guard: EnterpriseValidationAdmissionGuard
  ): Promise<void> {
    await this.locked(reference, async (db, scope, _conversation, at) => {
      const row = await this.budget.assertCurrentWithin(db, scope, run, at)
      await guard(db, scope, at)
      if (row.purpose !== 'evaluation' || assignments.length !== basis.input.cases.length * 3)
        throw new Error('evaluation_checkpoint_invalid')
      const settings = await effectiveLearningSettings(db, scope, '')
      let expiresAt = frozen.frozenAt + settings.caseRetentionDays * 86400000
      const sourceIds = [
        ...new Set(
          basis.methods
            .flatMap((m) => m.evidence.map((e) => e.episodeId))
            .concat(basis.episodes.map((e) => e.id))
        )
      ]
      const sources = (
        await db.query(
          'SELECT id,conversation_id,created_at FROM learning_episodes WHERE tenant_id=$1 AND account_id=$2 AND id=ANY($3::uuid[])',
          [scope.tenant_id, scope.account_id, sourceIds]
        )
      ).rows
      if (sources.length !== sourceIds.length)
        throw new Error('evaluation_checkpoint_source_missing')
      const conversations = [
        ...new Set(
          basis.input.cases
            .map((c) => c.conversationId)
            .concat(sources.map((s) => String(s.conversation_id)))
        )
      ]
      const patches = (
        await db.query(
          'SELECT conversation_id,payload FROM learning_settings WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=ANY($3::text[])',
          [scope.tenant_id, scope.account_id, conversations]
        )
      ).rows
      const days = (conversation: string): number =>
        z
          .number()
          .int()
          .min(7)
          .max(365)
          .parse(
            (
              patches.find((p) => p.conversation_id === conversation)?.payload as
                | { caseRetentionDays?: number }
                | undefined
            )?.caseRetentionDays ?? settings.caseRetentionDays
          )
      for (const conversation of conversations)
        expiresAt = Math.min(expiresAt, frozen.frozenAt + days(conversation) * 86400000)
      for (const source of sources) {
        expiresAt = Math.min(
          expiresAt,
          Number(source.created_at) + days(String(source.conversation_id)) * 86400000
        )
      }
      for (const method of basis.methods)
        if (method.expiresAt !== undefined) expiresAt = Math.min(expiresAt, method.expiresAt)
      for (const evidence of basis.publication.evidence)
        expiresAt = Math.min(expiresAt, evidence.expiresAt)
      if (expiresAt <= at) throw new Error('evaluation_checkpoint_expired')
      const keys = [scope.tenant_id, scope.account_id, run.id]
      await db.query(
        "INSERT INTO learning_evaluation_checkpoints(tenant_id,account_id,run_id,scope,basis,frozen,basis_hash,state,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,'collecting',$8,$9)",
        [
          ...keys,
          scope,
          basis,
          frozen,
          learningHash({ scope, basis, frozen, assignments }),
          at,
          expiresAt
        ]
      )
      await db.query(
        `INSERT INTO learning_evaluation_arms(tenant_id,account_id,run_id,ordinal,assignment_id,case_id,arm,state)
        SELECT $1,$2,$3,x.ordinal,x."assignmentId"::uuid,x."caseId",x.arm,'pending' FROM jsonb_to_recordset($4::jsonb) AS x(ordinal integer,"assignmentId" text,"caseId" text,arm text)`,
        [...keys, JSON.stringify(assignments)]
      )
      await this.assertSizeWithin(db, keys)
    })
  }

  private async assertSizeWithin(
    db: PoolClient,
    keys: string[],
    addition?: unknown
  ): Promise<void> {
    const row = (
      await db.query(
        `SELECT (octet_length(to_jsonb(c)::text) + (SELECT COALESCE(SUM(octet_length(to_jsonb(a)::text)),0) FROM learning_evaluation_arms a WHERE a.tenant_id=$1 AND a.account_id=$2 AND a.run_id=$3) + (SELECT COALESCE(SUM(octet_length(to_jsonb(s)::text)),0) FROM learning_evaluation_stages s WHERE s.tenant_id=$1 AND s.account_id=$2 AND s.run_id=$3) + (SELECT COALESCE(SUM(octet_length(to_jsonb(t)::text)),0) FROM learning_evaluation_execution_tasks t WHERE t.tenant_id=$1 AND t.account_id=$2 AND t.run_id=$3) + COALESCE(octet_length($4::jsonb::text),0) + 32)::text AS bytes FROM learning_evaluation_checkpoints c WHERE c.tenant_id=$1 AND c.account_id=$2 AND c.run_id=$3`,
        [...keys, addition ?? null]
      )
    ).rows[0]
    if (!row) throw new Error('evaluation_checkpoint_unavailable')
    if (Number(row.bytes) > 64 * 1024 * 1024) throw new Error('evaluation_checkpoint_too_large')
  }

  private async current(
    db: PoolClient,
    scope: Scope,
    run: EnterpriseValidationRun,
    at: number
  ): Promise<{ frozen: EnterpriseMemoryReplayPacket['frozen']; maxRequests: number }> {
    await this.budget.assertCurrentWithin(db, scope, run, at)
    const row = (
      await db.query(
        "SELECT scope,frozen,state,expires_at,basis->'input'->'maxRequests' AS max_requests FROM learning_evaluation_checkpoints WHERE tenant_id=$1 AND account_id=$2 AND run_id=$3",
        [scope.tenant_id, scope.account_id, run.id]
      )
    ).rows[0]
    if (
      !row ||
      row.state !== 'collecting' ||
      Number(row.expires_at) <= at ||
      learningHash(row.scope) !== learningHash(scope)
    )
      throw new Error('evaluation_checkpoint_unavailable')
    return {
      frozen: row.frozen as EnterpriseMemoryReplayPacket['frozen'],
      maxRequests: z.number().int().min(1).max(18000).parse(row.max_requests)
    }
  }

  /** Called in reserve's account-locked transaction before inserting the next fee row. */
  async assertRequestBudgetWithin(
    db: PoolClient,
    scope: Scope,
    run: EnterpriseValidationRun,
    at: number
  ): Promise<void> {
    const checkpoint = await this.current(db, scope, run, at)
    const used = (
      await db.query(
        'SELECT count(*)::int AS n FROM learning_attempts WHERE tenant_id=$1 AND account_id=$2 AND validation_run_id=$3',
        [scope.tenant_id, scope.account_id, run.id]
      )
    ).rows[0]
    // All admissions count, including unknown usage and cancellation before dispatch.
    // UTC fee buckets and a new process never reset this frozen batch's ceiling.
    if (Number(used.n) >= checkpoint.maxRequests)
      throw new Error('evaluation_request_budget_exceeded')
  }

  async start(
    reference: string,
    run: EnterpriseValidationRun,
    assignment: EvaluationAssignment
  ): Promise<{ activeMs: number; timingComplete: boolean }> {
    return this.locked(reference, async (db, scope, _conversation, at) => {
      await this.current(db, scope, run, at)
      const changed = await db.query(
        `UPDATE learning_evaluation_arms SET state='running' WHERE tenant_id=$1 AND account_id=$2 AND run_id=$3 AND ordinal=$4 AND assignment_id=$5 AND case_id=$6 AND arm=$7 AND state='pending'
        AND NOT EXISTS(SELECT 1 FROM learning_evaluation_arms a WHERE a.tenant_id=$1 AND a.account_id=$2 AND a.run_id=$3 AND a.ordinal<$4 AND a.state<>'completed') RETURNING ordinal,active_ms,timing_complete`,
        [
          scope.tenant_id,
          scope.account_id,
          run.id,
          assignment.ordinal,
          assignment.assignmentId,
          assignment.caseId,
          assignment.arm
        ]
      )
      if (!changed.rowCount) throw new Error('evaluation_checkpoint_order_conflict')
      return {
        activeMs: Number(changed.rows[0].active_ms),
        timingComplete: Boolean(changed.rows[0].timing_complete)
      }
    })
  }

  async finish(
    reference: string,
    run: EnterpriseValidationRun,
    assignment: EvaluationAssignment,
    raw: unknown,
    executionTask: ReplyTask
  ): Promise<void> {
    const receipt = MemoryReplayReceiptSchema.parse(raw)
    await this.locked(reference, async (db, scope, _conversation, at) => {
      const row = await this.current(db, scope, run, at)
      await this.recordExecutionTaskWithin(db, scope, run, assignment, executionTask, at)
      const expectedExecutions = await this.executionHashesWithin(
        db,
        scope,
        run.id,
        assignment.assignmentId
      )
      if (hashContext(receipt.executionTaskHashes) !== hashContext(expectedExecutions))
        throw new Error('evaluation_checkpoint_execution_conflict')
      const manifest =
        receipt.arm === 'none'
          ? row.frozen.noMemoryManifestHash
          : receipt.arm === 'baseline'
            ? row.frozen.staticMemoryManifestHash
            : row.frozen.learnedMemoryManifestHash
      if (
        receipt.assignmentId !== assignment.assignmentId ||
        receipt.caseId !== assignment.caseId ||
        receipt.arm !== assignment.arm ||
        receipt.configurationHash !== row.frozen.sharedConfigurationHash ||
        receipt.memoryManifestHash !== manifest
      )
        throw new Error('evaluation_checkpoint_receipt_conflict')
      const refs = z.array(z.uuid()).parse(receipt.modelCallRefs)
      const keys = [scope.tenant_id, scope.account_id, run.id]
      const calls = (
        await db.query(
          'SELECT claim_token,state,input_tokens,output_tokens,measurement FROM learning_attempts WHERE tenant_id=$1 AND account_id=$2 AND validation_run_id=$3 AND claim_token=ANY($4::uuid[])',
          [...keys, refs]
        )
      ).rows
      if (
        new Set(refs).size !== refs.length ||
        calls.length !== refs.length ||
        calls.some((c) => c.state === 'running') ||
        (!refs.length &&
          !(
            receipt.pipelineStatus === 'handoff' &&
            receipt.pipelineReasons?.includes('explicit_human_request')
          ))
      )
        throw new Error('evaluation_checkpoint_fee_conflict')
      const measured = calls.every((c) => c.measurement === 'reported')
      if (
        receipt.inputTokens !==
          (measured ? calls.reduce((n, c) => n + Number(c.input_tokens), 0) : null) ||
        receipt.outputTokens !==
          (measured ? calls.reduce((n, c) => n + Number(c.output_tokens), 0) : null)
      )
        throw new Error('evaluation_checkpoint_fee_conflict')
      if (
        refs.length &&
        (
          await db.query(
            "SELECT 1 FROM learning_evaluation_arms WHERE tenant_id=$1 AND account_id=$2 AND run_id=$3 AND (receipt->'modelCallRefs') ?| $4::text[]",
            [...keys, refs]
          )
        ).rowCount
      )
        throw new Error('evaluation_checkpoint_fee_conflict')
      await this.assertAssignmentStagesWithin(
        db,
        scope,
        run.id,
        assignment.assignmentId,
        refs,
        true
      )
      await this.assertSizeWithin(db, keys, receipt)
      const changed = await db.query(
        "UPDATE learning_evaluation_arms SET state='completed',receipt=$6 WHERE tenant_id=$1 AND account_id=$2 AND run_id=$3 AND ordinal=$4 AND assignment_id=$5 AND state='running' RETURNING ordinal",
        [...keys, assignment.ordinal, assignment.assignmentId, receipt]
      )
      if (!changed.rowCount) throw new Error('evaluation_checkpoint_receipt_conflict')
    })
  }

  async complete(reference: string, run: EnterpriseValidationRun): Promise<void> {
    await this.locked(reference, async (db, scope, _conversation, at) => {
      await this.current(db, scope, run, at)
      const keys = [scope.tenant_id, scope.account_id, run.id]
      if (
        (
          await db.query(
            "SELECT 1 FROM learning_evaluation_arms WHERE tenant_id=$1 AND account_id=$2 AND run_id=$3 AND state<>'completed'",
            keys
          )
        ).rowCount
      )
        throw new Error('evaluation_checkpoint_incomplete')
      await db.query(
        "UPDATE learning_evaluation_checkpoints SET state='completed' WHERE tenant_id=$1 AND account_id=$2 AND run_id=$3",
        keys
      )
    })
  }
  async incomplete(
    reference: string,
    run: EnterpriseValidationRun,
    state: 'incomplete' | 'waiting_budget' = 'incomplete',
    active?: { assignmentId: string; elapsedMs: number }
  ): Promise<void> {
    await this.locked(reference, async (db, scope, _conversation, at) => {
      const keys = [scope.tenant_id, scope.account_id, run.id]
      const changed = await db.query(
        "UPDATE learning_evaluation_checkpoints c SET state=$5,resume_at=$6 WHERE tenant_id=$1 AND account_id=$2 AND run_id=$3 AND state<>'completed' AND EXISTS(SELECT 1 FROM learning_validation_runs r WHERE (r.tenant_id,r.account_id,r.id)=(c.tenant_id,c.account_id,c.run_id) AND r.claim_token=$4) RETURNING run_id",
        [
          ...keys,
          run.claimToken,
          state,
          state === 'waiting_budget' ? Math.floor(at / 86400000) * 86400000 + 86400000 : 0
        ]
      )
      if (changed.rowCount && active)
        await db.query(
          "UPDATE learning_evaluation_arms SET active_ms=active_ms+$5 WHERE tenant_id=$1 AND account_id=$2 AND run_id=$3 AND assignment_id=$4 AND state='running'",
          [
            ...keys,
            z.uuid().parse(active.assignmentId),
            z.number().finite().nonnegative().parse(active.elapsedMs)
          ]
        )
    })
  }

  private async readWithin(
    db: PoolClient,
    scope: Scope,
    id: string,
    at: number
  ): Promise<
    EvaluationCheckpointSnapshot & { resumeAt: number; sourceId: string; finishedAt: number | null }
  > {
    const keys = [scope.tenant_id, scope.account_id, z.uuid().parse(id)]
    await this.assertSizeWithin(db, keys)
    const row = (
      await db.query(
        'SELECT c.*,r.source_id,r.finished_at FROM learning_evaluation_checkpoints c JOIN learning_validation_runs r ON (r.tenant_id,r.account_id,r.id)=(c.tenant_id,c.account_id,c.run_id) WHERE c.tenant_id=$1 AND c.account_id=$2 AND c.run_id=$3',
        keys
      )
    ).rows[0]
    if (!row || Number(row.expires_at) <= at || learningHash(row.scope) !== learningHash(scope))
      throw new Error('evaluation_checkpoint_unavailable')
    const arms = (
      await db.query(
        'SELECT * FROM learning_evaluation_arms WHERE tenant_id=$1 AND account_id=$2 AND run_id=$3 ORDER BY ordinal',
        keys
      )
    ).rows
    const assignments = arms.map((a, index) => {
      if (Number(a.ordinal) !== index) throw new Error('evaluation_checkpoint_order_conflict')
      return {
        ordinal: index,
        assignmentId: z.uuid().parse(a.assignment_id),
        caseId: z.string().min(1).max(128).parse(a.case_id),
        arm: z.enum(['none', 'baseline', 'learned']).parse(a.arm)
      }
    })
    if (
      learningHash({ scope: row.scope, basis: row.basis, frozen: row.frozen, assignments }) !==
      row.basis_hash
    )
      throw new Error('evaluation_checkpoint_basis_conflict')
    let unfinished = false,
      running = 0
    const receipts: EnterpriseMemoryReplayPacket['receipts'] = []
    for (const [index, arm] of arms.entries()) {
      if (arm.state !== 'completed') {
        unfinished = true
        if (arm.state === 'running') running++
        continue
      }
      if (unfinished) throw new Error('evaluation_checkpoint_order_conflict')
      const receipt = MemoryReplayReceiptSchema.parse(arm.receipt),
        assignment = assignments[index]
      if (
        receipt.assignmentId !== assignment.assignmentId ||
        receipt.caseId !== assignment.caseId ||
        receipt.arm !== assignment.arm ||
        receipt.configurationHash !== row.frozen.sharedConfigurationHash ||
        receipt.memoryManifestHash !==
          (receipt.arm === 'none'
            ? row.frozen.noMemoryManifestHash
            : receipt.arm === 'baseline'
              ? row.frozen.staticMemoryManifestHash
              : row.frozen.learnedMemoryManifestHash)
      )
        throw new Error('evaluation_checkpoint_receipt_conflict')
      receipts.push(receipt)
      z.array(z.uuid()).parse(receipt.modelCallRefs)
    }
    if (running > 1 || (row.state === 'completed' && receipts.length !== assignments.length))
      throw new Error('evaluation_checkpoint_incomplete')
    const executionTasks = await this.readExecutionTasksWithin(
      db,
      scope,
      id,
      row.basis as EvaluationBasis,
      assignments
    )
    const stages = (
      await db.query<RecordedEvaluationStage>(
        'SELECT assignment_id::text,model_call_refs,execution_task_hash FROM learning_evaluation_stages WHERE tenant_id=$1 AND account_id=$2 AND run_id=$3',
        keys
      )
    ).rows
    for (const receipt of receipts) {
      const expected = executionTasks
        .filter((value) => value.assignmentId === receipt.assignmentId)
        .map((value) => value.taskHash)
        .sort()
      if (
        (expected.length || receipt.executionTaskHashes) &&
        hashContext(expected) !== hashContext(receipt.executionTaskHashes)
      )
        throw new Error('evaluation_checkpoint_execution_conflict')
      await this.assertAssignmentStagesWithin(
        db,
        scope,
        id,
        receipt.assignmentId,
        z.array(z.uuid()).parse(receipt.modelCallRefs),
        expected.length > 0,
        stages.filter((value) => value.assignment_id === receipt.assignmentId)
      )
    }
    return {
      scope,
      basis: row.basis as EvaluationBasis,
      frozen: row.frozen as EnterpriseMemoryReplayPacket['frozen'],
      assignments,
      receipts,
      state: String(row.state),
      attemptCount: Number(row.attempt_count),
      executionTasks,
      resumeAt: Number(row.resume_at),
      sourceId: String(row.source_id),
      finishedAt: row.finished_at === null ? null : Number(row.finished_at)
    }
  }

  private async assertAssignmentStagesWithin(
    db: PoolClient,
    scope: Scope,
    id: string,
    assignmentId: string,
    refs: string[],
    requireExecution: boolean,
    recordedStages?: RecordedEvaluationStage[]
  ): Promise<void> {
    const rows =
      recordedStages ??
      (
        await db.query<RecordedEvaluationStage>(
          'SELECT assignment_id::text,model_call_refs,execution_task_hash FROM learning_evaluation_stages WHERE tenant_id=$1 AND account_id=$2 AND run_id=$3 AND assignment_id=$4',
          [scope.tenant_id, scope.account_id, id, assignmentId]
        )
      ).rows
    const stageRefs = rows.flatMap((row) => z.array(z.uuid()).length(1).parse(row.model_call_refs))
    if (
      new Set(stageRefs).size !== stageRefs.length ||
      hashContext([...stageRefs].sort()) !== hashContext([...refs].sort()) ||
      (requireExecution && rows.some((row) => !row.execution_task_hash))
    )
      throw new Error('evaluation_checkpoint_fee_conflict')
  }

  private async assertRecordedCallsWithin(db: PoolClient, scope: Scope, id: string): Promise<void> {
    const keys = [scope.tenant_id, scope.account_id, id]
    if (
      (
        await db.query(
          `WITH refs AS (
            SELECT unnest(model_call_refs) AS ref FROM learning_evaluation_stages WHERE tenant_id=$1 AND account_id=$2 AND run_id=$3
            UNION SELECT jsonb_array_elements_text(receipt->'modelCallRefs')::uuid FROM learning_evaluation_arms WHERE tenant_id=$1 AND account_id=$2 AND run_id=$3 AND state='completed'
          ) SELECT 1 FROM learning_attempts c LEFT JOIN refs ON refs.ref=c.claim_token WHERE c.tenant_id=$1 AND c.account_id=$2 AND c.validation_run_id=$3 AND (c.state='running' OR refs.ref IS NULL) LIMIT 1`,
          keys
        )
      ).rowCount
    )
      throw new Error('evaluation_usage_reconciliation_required')
    if (
      (
        await db.query(
          `WITH refs AS (
          SELECT unnest(model_call_refs) AS ref FROM learning_evaluation_stages WHERE tenant_id=$1 AND account_id=$2 AND run_id=$3
          UNION SELECT jsonb_array_elements_text(receipt->'modelCallRefs')::uuid FROM learning_evaluation_arms WHERE tenant_id=$1 AND account_id=$2 AND run_id=$3 AND state='completed'
        ) SELECT 1 FROM refs WHERE NOT EXISTS(SELECT 1 FROM learning_attempts c WHERE c.tenant_id=$1 AND c.account_id=$2 AND c.validation_run_id=$3 AND c.claim_token=refs.ref) LIMIT 1`,
          keys
        )
      ).rowCount
    )
      throw new Error('evaluation_usage_reconciliation_required')
  }

  async claim(
    reference: string,
    id: string,
    workerId: string,
    guard: (
      snapshot: EvaluationCheckpointSnapshot,
      db: PoolClient,
      scope: Scope,
      at: number
    ) => Promise<void>
  ): Promise<{ snapshot: EvaluationCheckpointSnapshot; run?: EnterpriseValidationRun }> {
    return this.locked(reference, async (db, scope, _conversation, at) => {
      const snapshot = await this.readWithin(db, scope, id, at)
      await guard(snapshot, db, scope, at)
      await this.assertSizeWithin(db, [scope.tenant_id, scope.account_id, id])
      const allCompleted = snapshot.receipts.length === snapshot.assignments.length
      if (
        !allCompleted &&
        (
          await db.query(
            `SELECT 1 FROM learning_background_leases WHERE tenant_id=$1 AND account_id=$2 AND lease_until>$4
           UNION ALL SELECT 1 FROM learning_validation_runs WHERE tenant_id=$1 AND account_id=$2 AND id=$3 AND state='running' AND lease_until>$4 LIMIT 1`,
            [scope.tenant_id, scope.account_id, id, at]
          )
        ).rowCount
      )
        throw new Error('learning_background_busy')
      await this.assertRecordedCallsWithin(db, scope, id)
      if (allCompleted) {
        const keys = [scope.tenant_id, scope.account_id, id]
        // An export failure must not consume another attempt or provider request.
        // Only this immutable batch's lease is released; unrelated workers keep theirs.
        await db.query(
          'DELETE FROM learning_background_leases WHERE tenant_id=$1 AND account_id=$2 AND claim_token IN (SELECT claim_token FROM learning_validation_runs WHERE tenant_id=$1 AND account_id=$2 AND id=$3)',
          keys
        )
        await db.query(
          "UPDATE learning_validation_runs SET state='completed',finished_at=COALESCE(finished_at,$4) WHERE tenant_id=$1 AND account_id=$2 AND id=$3",
          [...keys, at]
        )
        await db.query(
          "UPDATE learning_evaluation_checkpoints SET state='completed',resume_at=0 WHERE tenant_id=$1 AND account_id=$2 AND run_id=$3",
          keys
        )
        return { snapshot: { ...snapshot, state: 'completed' } }
      }
      if (snapshot.state === 'waiting_budget' && at < snapshot.resumeAt)
        throw new Error('evaluation_budget_waiting')
      const settings = await effectiveLearningSettings(db, scope, '')
      const total = Number(
        (
          await db.query(
            'SELECT COALESCE(SUM(COALESCE(c.attempt_count,1)),0)::int AS n FROM learning_validation_runs r LEFT JOIN learning_evaluation_checkpoints c ON (c.tenant_id,c.account_id,c.run_id)=(r.tenant_id,r.account_id,r.id) WHERE r.tenant_id=$1 AND r.account_id=$2 AND r.source_id=$3',
            [scope.tenant_id, scope.account_id, snapshot.sourceId]
          )
        ).rows[0].n
      )
      const retry = snapshot.state === 'waiting_budget' ? 0 : 1
      if (total + retry > settings.maxAttempts) throw new Error('attempt_limit')
      if (
        retry &&
        snapshot.finishedAt !== null &&
        at < snapshot.finishedAt + Math.min(60000, 5000 * 2 ** (total - 1))
      )
        throw new Error('validation_retry_not_ready')
      const run = await this.budget.reclaimEvaluationWithin(db, scope, id, workerId, at)
      const keys = [scope.tenant_id, scope.account_id, id]
      await db.query(
        "UPDATE learning_evaluation_checkpoints SET state='collecting',attempt_count=attempt_count+$4,resume_at=0 WHERE tenant_id=$1 AND account_id=$2 AND run_id=$3",
        [...keys, retry]
      )
      await db.query(
        "UPDATE learning_evaluation_arms SET state='pending',timing_complete=timing_complete AND $4 WHERE tenant_id=$1 AND account_id=$2 AND run_id=$3 AND state='running'",
        [...keys, snapshot.state !== 'collecting']
      )
      return { snapshot, run }
    })
  }

  /** Authenticated inspection only: never claims, repairs, retries or releases a lease. */
  async readCompleted(reference: string, id: string): Promise<EvaluationCheckpointSnapshot> {
    return this.locked(reference, async (db, scope, _conversation, at) => {
      const keys = [scope.tenant_id, scope.account_id, z.uuid().parse(id)]
      await this.assertSizeWithin(db, keys)
      const snapshot = await this.readWithin(db, scope, id, at)
      if (
        snapshot.state !== 'completed' ||
        !snapshot.assignments.length ||
        snapshot.receipts.length !== snapshot.assignments.length
      )
        throw new Error('evaluation_checkpoint_incomplete')
      await this.assertRecordedCallsWithin(db, scope, id)
      const calls = (
        await db.query(
          'SELECT claim_token::text,state,input_tokens,output_tokens,measurement FROM learning_attempts WHERE tenant_id=$1 AND account_id=$2 AND validation_run_id=$3',
          keys
        )
      ).rows
      const byId = new Map(calls.map((call) => [String(call.claim_token), call]))
      const used = new Set<string>()
      for (const receipt of snapshot.receipts) {
        const refs = z.array(z.uuid()).max(3).parse(receipt.modelCallRefs)
        if (
          (!refs.length &&
            !(
              receipt.pipelineStatus === 'handoff' &&
              receipt.pipelineReasons?.includes('explicit_human_request')
            )) ||
          refs.some((ref) => used.has(ref) || !byId.has(ref)) ||
          new Set(refs).size !== refs.length
        )
          throw new Error('evaluation_checkpoint_fee_conflict')
        refs.forEach((ref) => used.add(ref))
        const recorded = refs.map((ref) => byId.get(ref)!)
        const measured = recorded.every((call) => call.measurement === 'reported')
        if (
          recorded.some((call) => call.state === 'running') ||
          receipt.inputTokens !==
            (measured ? recorded.reduce((n, call) => n + Number(call.input_tokens), 0) : null) ||
          receipt.outputTokens !==
            (measured ? recorded.reduce((n, call) => n + Number(call.output_tokens), 0) : null)
        )
          throw new Error('evaluation_checkpoint_fee_conflict')
      }
      if (used.size !== calls.length) throw new Error('evaluation_usage_reconciliation_required')
      return structuredClone({
        scope: snapshot.scope,
        basis: snapshot.basis,
        frozen: snapshot.frozen,
        assignments: snapshot.assignments,
        receipts: snapshot.receipts,
        state: snapshot.state,
        attemptCount: snapshot.attemptCount,
        executionTasks: snapshot.executionTasks
      })
    })
  }

  async stage(
    reference: string,
    run: EnterpriseValidationRun,
    assignment: EvaluationAssignment,
    stage: ModelStage
  ): Promise<unknown | undefined> {
    return this.locked(reference, async (db, scope, _conversation, at) => {
      await this.current(db, scope, run, at)
      const row = (
        await db.query(
          'SELECT result FROM learning_evaluation_stages WHERE tenant_id=$1 AND account_id=$2 AND run_id=$3 AND assignment_id=$4 AND stage=$5',
          [
            scope.tenant_id,
            scope.account_id,
            run.id,
            assignment.assignmentId,
            ModelStageSchema.parse(stage)
          ]
        )
      ).rows[0]
      return row ? parsedStage(stage, row.result) : undefined
    })
  }

  async saveStage(
    reference: string,
    run: EnterpriseValidationRun,
    assignment: EvaluationAssignment,
    stage: ModelStage,
    raw: unknown,
    refs: string[],
    guard: EnterpriseValidationAdmissionGuard,
    executionTask: ReplyTask
  ): Promise<void> {
    const value = parsedStage(stage, raw)
    z.array(z.uuid()).length(1).parse(refs)
    await this.locked(reference, async (db, scope, _conversation, at) => {
      await this.current(db, scope, run, at)
      await guard(db, scope, at)
      const taskHash = hashContext(ReplyTaskSchema.parse(executionTask))
      if (
        !(
          await db.query(
            'SELECT 1 FROM learning_evaluation_execution_tasks WHERE tenant_id=$1 AND account_id=$2 AND run_id=$3 AND assignment_id=$4 AND task_hash=$5',
            [scope.tenant_id, scope.account_id, run.id, assignment.assignmentId, taskHash]
          )
        ).rowCount
      )
        throw new Error('evaluation_checkpoint_execution_conflict')
      const keys = [scope.tenant_id, scope.account_id, run.id]
      if (
        !(
          await db.query(
            "SELECT 1 FROM learning_evaluation_arms WHERE tenant_id=$1 AND account_id=$2 AND run_id=$3 AND assignment_id=$4 AND state='running'",
            [...keys, assignment.assignmentId]
          )
        ).rowCount
      )
        throw new Error('evaluation_checkpoint_order_conflict')
      if (
        (
          await db.query(
            "SELECT 1 FROM learning_attempts WHERE tenant_id=$1 AND account_id=$2 AND validation_run_id=$3 AND claim_token=$4 AND state<>'running'",
            [...keys, refs[0]]
          )
        ).rowCount !== 1 ||
        (
          await db.query(
            'SELECT 1 FROM learning_evaluation_stages WHERE tenant_id=$1 AND account_id=$2 AND run_id=$3 AND model_call_refs && $4::uuid[]',
            [...keys, refs]
          )
        ).rowCount
      )
        throw new Error('evaluation_checkpoint_fee_conflict')
      if (
        stage !== 'pre' &&
        !(
          await db.query(
            'SELECT 1 FROM learning_evaluation_stages WHERE tenant_id=$1 AND account_id=$2 AND run_id=$3 AND assignment_id=$4 AND stage=$5',
            [...keys, assignment.assignmentId, stage === 'text' ? 'pre' : 'text']
          )
        ).rowCount
      )
        throw new Error('evaluation_checkpoint_order_conflict')
      await this.assertSizeWithin(db, keys, {
        tenant_id: scope.tenant_id,
        account_id: scope.account_id,
        run_id: run.id,
        assignment_id: assignment.assignmentId,
        stage,
        result: value,
        model_call_refs: refs,
        execution_task_hash: taskHash,
        created_at: at
      })
      await db.query(
        'INSERT INTO learning_evaluation_stages(tenant_id,account_id,run_id,assignment_id,stage,result,model_call_refs,created_at,execution_task_hash) VALUES($1,$2,$3,$4,$5,$6,$7::uuid[],$8,$9)',
        [...keys, assignment.assignmentId, stage, value, refs, at, taskHash]
      )
    })
  }

  async recordExecutionTaskWithin(
    db: PoolClient,
    scope: Scope,
    run: EnterpriseValidationRun,
    assignment: EvaluationAssignment,
    raw: ReplyTask,
    at: number
  ): Promise<void> {
    const task = ReplyTaskSchema.parse(raw),
      taskHash = hashContext(task)
    await this.current(db, scope, run, at)
    const keys = [scope.tenant_id, scope.account_id, run.id, assignment.assignmentId]
    if (
      !(
        await db.query(
          "SELECT 1 FROM learning_evaluation_arms WHERE tenant_id=$1 AND account_id=$2 AND run_id=$3 AND assignment_id=$4 AND ordinal=$5 AND case_id=$6 AND arm=$7 AND state='running'",
          [...keys, assignment.ordinal, assignment.caseId, assignment.arm]
        )
      ).rowCount
    )
      throw new Error('evaluation_checkpoint_order_conflict')
    const binding = (
      await db.query(
        `SELECT basis->'publication' AS publication,
        (SELECT COALESCE(jsonb_agg(item),'[]'::jsonb) FROM jsonb_array_elements(basis->'input'->'cases') item WHERE item->>'caseId'=$4) AS cases
        FROM learning_evaluation_checkpoints WHERE tenant_id=$1 AND account_id=$2 AND run_id=$3`,
        [...keys.slice(0, 3), assignment.caseId]
      )
    ).rows[0]
    if (!binding) throw new Error('evaluation_checkpoint_execution_conflict')
    assertExecutionBinding(
      task,
      scope,
      {
        input: { cases: binding.cases } as EvaluationBasis['input'],
        publication: binding.publication
      },
      assignment.caseId
    )
    const existing = (
      await db.query(
        'SELECT task_hash FROM learning_evaluation_execution_tasks WHERE tenant_id=$1 AND account_id=$2 AND run_id=$3 AND assignment_id=$4',
        keys
      )
    ).rows
    if (existing.some((row) => row.task_hash === taskHash)) return
    if (existing.length >= 9) throw new Error('evaluation_execution_capacity_exceeded')
    const value = {
      tenant_id: scope.tenant_id,
      account_id: scope.account_id,
      run_id: run.id,
      assignment_id: assignment.assignmentId,
      task_hash: taskHash,
      task,
      created_at: at
    }
    await this.assertSizeWithin(db, keys.slice(0, 3), value)
    await db.query('INSERT INTO learning_evaluation_execution_tasks VALUES($1,$2,$3,$4,$5,$6,$7)', [
      ...keys,
      taskHash,
      task,
      at
    ])
  }

  private async executionHashesWithin(
    db: PoolClient,
    scope: Scope,
    runId: string,
    assignmentId: string
  ): Promise<string[]> {
    return (
      await db.query(
        'SELECT task_hash FROM learning_evaluation_execution_tasks WHERE tenant_id=$1 AND account_id=$2 AND run_id=$3 AND assignment_id=$4 ORDER BY task_hash',
        [scope.tenant_id, scope.account_id, runId, assignmentId]
      )
    ).rows.map((row) => String(row.task_hash))
  }
  async executionHashes(
    reference: string,
    run: EnterpriseValidationRun,
    assignment: EvaluationAssignment
  ): Promise<string[]> {
    return this.locked(reference, async (db, scope, _conversation, at) => {
      await this.current(db, scope, run, at)
      return this.executionHashesWithin(db, scope, run.id, assignment.assignmentId)
    })
  }
  private async readExecutionTasksWithin(
    db: PoolClient,
    scope: Scope,
    id: string,
    basis: EvaluationBasis,
    assignments: EvaluationAssignment[]
  ): Promise<EvaluationCheckpointSnapshot['executionTasks']> {
    const rows = (
      await db.query(
        'SELECT assignment_id::text,task_hash,task FROM learning_evaluation_execution_tasks WHERE tenant_id=$1 AND account_id=$2 AND run_id=$3 ORDER BY assignment_id,task_hash',
        [scope.tenant_id, scope.account_id, id]
      )
    ).rows
    const counts = new Map<string, number>()
    return rows.map((row) => {
      const task = ReplyTaskSchema.parse(row.task)
      const assignmentId = z.uuid().parse(row.assignment_id)
      const assignment = assignments.find((value) => value.assignmentId === assignmentId)
      if (!assignment || hashContext(task) !== row.task_hash)
        throw new Error('evaluation_checkpoint_execution_conflict')
      assertExecutionBinding(task, scope, basis, assignment.caseId)
      const count = (counts.get(assignmentId) ?? 0) + 1
      if (count > 9) throw new Error('evaluation_execution_capacity_exceeded')
      counts.set(assignmentId, count)
      return {
        assignmentId,
        taskHash: String(row.task_hash),
        task
      }
    })
  }
}

/** Forgetting any constituent scope discards the account batch; anonymous fee rows remain. */
export async function discardEvaluationCheckpointsWithin(
  db: PoolClient,
  scope: Pick<Scope, 'tenant_id' | 'account_id'>,
  at: number
): Promise<void> {
  await stopEvaluationRunsWithin(db, scope, at)
  await db.query(
    'DELETE FROM learning_evaluation_checkpoints WHERE tenant_id=$1 AND account_id=$2',
    [scope.tenant_id, scope.account_id]
  )
}

export async function purgeExpiredEvaluationCheckpointsWithin(
  db: PoolClient,
  scope: Pick<Scope, 'tenant_id' | 'account_id'>,
  at: number
): Promise<void> {
  const removed = await db.query(
    'DELETE FROM learning_evaluation_checkpoints WHERE tenant_id=$1 AND account_id=$2 AND expires_at<=$3 RETURNING run_id',
    [scope.tenant_id, scope.account_id, at]
  )
  if (removed.rowCount)
    await stopEvaluationRunsWithin(
      db,
      scope,
      at,
      removed.rows.map((r) => String(r.run_id))
    )
}

async function stopEvaluationRunsWithin(
  db: PoolClient,
  scope: Pick<Scope, 'tenant_id' | 'account_id'>,
  at: number,
  runIds?: string[]
): Promise<void> {
  const keys = [scope.tenant_id, scope.account_id]
  await db.query(
    "DELETE FROM learning_background_leases WHERE tenant_id=$1 AND account_id=$2 AND claim_token IN (SELECT claim_token FROM learning_validation_runs WHERE tenant_id=$1 AND account_id=$2 AND purpose='evaluation' AND ($3::uuid[] IS NULL OR id=ANY($3::uuid[])))",
    [...keys, runIds ?? null]
  )
  await db.query(
    "UPDATE learning_validation_runs SET state='cancelled',finished_at=$3 WHERE tenant_id=$1 AND account_id=$2 AND purpose='evaluation' AND state='running' AND ($4::uuid[] IS NULL OR id=ANY($4::uuid[]))",
    [...keys, at, runIds ?? null]
  )
  await db.query(
    "UPDATE learning_attempts SET state='cancelled' WHERE tenant_id=$1 AND account_id=$2 AND state='running' AND validation_run_id IN (SELECT id FROM learning_validation_runs WHERE tenant_id=$1 AND account_id=$2 AND purpose='evaluation' AND ($3::uuid[] IS NULL OR id=ANY($3::uuid[])))",
    [...keys, runIds ?? null]
  )
}
