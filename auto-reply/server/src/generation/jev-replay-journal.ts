import { createHash, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { Id } from '../../../src/shared/contracts/identity'
import { hashContext } from '../../../src/core/reply/hashes'
import { BlindReviewArtifactSchema } from '../../../evals/jev/blind-review'
import {
  validateFrozenReplayInputs,
  ReplayInputSchema,
  replayCaseInputHash
} from '../../../evals/jev/replay-input'
import {
  ReplayCallBindingSchema,
  type ReplayCallBinding,
  type ReplayCallJournal
} from '../../../evals/jev/replay-providers'
import {
  ReplayAttemptSchema,
  type ReplayAssignment,
  type ReplayAttempt,
  type AuthorizedReplaySource
} from '../../../evals/jev/replay'
import type { Postgres } from '../database/postgres'
import { Administration } from '../admin/administration'
import { EvaluationPlanSchema } from '../admin/evaluation-admission'
import { PublicationSchema } from './publication'
import { evaluationSnapshotHash } from './evaluation-authorization'
import { preQuestions, auditQuestions } from '../reply/jev-pipeline'
import {
  ModelCallLimitSchema,
  ModelCallStartSchema,
  ModelCallResultSchema,
  ModelStageSchema,
  ModelCallError,
  type ModelStage,
  type ModelCallStart,
  type ModelCallHandle
} from './model-call-contracts'

const BeginSchema = z.strictObject({
  tenantId: Id,
  accountId: Id,
  runId: Id,
  fullRawCases: z.unknown(),
  maxRunAttempts: z.number().int().min(1).max(100000)
})
const AssignmentSchema = z.strictObject({
  runId: Id,
  caseId: Id,
  arm: z.enum(['A', 'B', 'C']),
  assignmentId: z.uuid()
})
type Prepared = ReturnType<typeof validateFrozenReplayInputs> & {
  executionId: string
  source: AuthorizedReplaySource
}

/** Independent administrator evaluation authority. No task, lease, permit, learning
 * enablement or production pause change is created. Limits count HTTP attempts,
 * not tokens or money. An unfinished attempt permanently blocks its arm. */
export class JevReplayJournal implements ReplayCallJournal {
  private prepared?: Prepared
  private checkedContents?: string
  constructor(
    private readonly db: Postgres,
    private readonly activeTextGeneratorVersion: string
  ) {}

  async setLimit(tenantId: string, accountId: string, input: unknown): Promise<void> {
    const limit = ModelCallLimitSchema.parse(input)
    await this.operate(tenantId, accountId, async (db) => {
      await db.query(
        `INSERT INTO jev_replay_limits(tenant_id,account_id,daily_attempt_limit) VALUES($1,$2,$3)
        ON CONFLICT(tenant_id,account_id) DO UPDATE SET daily_attempt_limit=excluded.daily_attempt_limit`,
        [tenantId, accountId, limit.dailyAttemptLimit]
      )
    })
  }

  async readLimit(
    tenantId: string,
    accountId: string
  ): Promise<{
    dailyAttemptLimit: number
    usedAttempts: number
    remainingAttempts: number
  } | null> {
    return this.operate(tenantId, accountId, async (db) => {
      const limit = await db.query(
        'SELECT daily_attempt_limit FROM jev_replay_limits WHERE tenant_id=$1 AND account_id=$2',
        [tenantId, accountId]
      )
      if (!limit.rows[0]) return null
      const used = await db.query(
        `SELECT count(*)::int AS n FROM jev_replay_attempts WHERE tenant_id=$1 AND account_id=$2 AND usage_day=(clock_timestamp() AT TIME ZONE 'UTC')::date`,
        [tenantId, accountId]
      )
      const dailyAttemptLimit = Number(limit.rows[0].daily_attempt_limit),
        usedAttempts = Number(used.rows[0].n)
      return {
        dailyAttemptLimit,
        usedAttempts,
        remainingAttempts: Math.max(0, dailyAttemptLimit - usedAttempts)
      }
    })
  }

  async begin(raw: z.infer<typeof BeginSchema>): Promise<Prepared> {
    const request = BeginSchema.parse(structuredClone(raw))
    const { tenantId, accountId, runId, maxRunAttempts } = request
    const source = await new Administration(
      this.db,
      this.activeTextGeneratorVersion
    ).readFrozenEvaluation(tenantId, accountId, runId)
    const validated = validateFrozenReplayInputs(
      source,
      request.fullRawCases,
      this.activeTextGeneratorVersion
    )
    if (
      this.prepared &&
      (this.prepared.source.runId !== runId ||
        this.prepared.source.authenticatedScope.tenantId !== tenantId ||
        this.prepared.source.authenticatedScope.accountId !== accountId ||
        this.prepared.input.split !== validated.input.split)
    )
      throw new ModelCallError('CONTEXT_UNAVAILABLE')
    const inputHash = hashContext(validated.input)
    const executionId = await this.operate(tenantId, accountId, async (db) => {
      const current = await db.query(
        `SELECT snapshot_hash,publication_json,plan_json,created_at,expires_at,clock_timestamp() AS server_now
        FROM evaluation_runs WHERE tenant_id=$1 AND account_id=$2 AND id=$3`,
        [tenantId, accountId, runId]
      )
      const row = current.rows[0]
      if (
        !row ||
        row.snapshot_hash !== source.snapshotHash ||
        hashContext(row.publication_json) !== hashContext(source.publication) ||
        hashContext(row.plan_json) !== hashContext(source.plan)
      )
        throw new ModelCallError('CONTEXT_UNAVAILABLE')
      validateFrozenReplayInputs(
        {
          ...source,
          createdAt: new Date(row.created_at),
          expiresAt: new Date(row.expires_at),
          serverNow: new Date(row.server_now)
        },
        validated.input,
        this.activeTextGeneratorVersion
      )
      const account = await db.query(
        'SELECT employee_id,platform FROM accounts WHERE tenant_id=$1 AND id=$2',
        [tenantId, accountId]
      )
      if (
        account.rows[0]?.employee_id !== source.authenticatedScope.employeeId ||
        account.rows[0]?.platform !== source.authenticatedScope.platform
      )
        throw new ModelCallError('CONTEXT_UNAVAILABLE')
      const existing = await db.query(
        'SELECT * FROM jev_replay_executions WHERE tenant_id=$1 AND account_id=$2 AND run_id=$3 AND split=$4',
        [tenantId, accountId, runId, validated.input.split]
      )
      if (existing.rows[0]) {
        const e = existing.rows[0]
        this.checkContents(e)
        const actor = await this.authenticate(db, tenantId)
        const login = (await db.query('SELECT session_user AS login')).rows[0].login
        if (
          e.input_hash !== inputHash ||
          hashContext(e.input_json) !== inputHash ||
          e.plan_hash !== validated.summary.executionPlanHash ||
          e.snapshot_hash !== source.snapshotHash ||
          e.max_attempts !== maxRunAttempts ||
          e.actor_id !== actor ||
          e.login_name !== login ||
          e.employee_id !== source.authenticatedScope.employeeId ||
          e.platform !== source.authenticatedScope.platform
        )
          throw new ModelCallError('CONTEXT_UNAVAILABLE')
        return e.id as string
      }
      const id = randomUUID()
      await db.query(
        `INSERT INTO jev_replay_executions(tenant_id,account_id,id,run_id,employee_id,platform,split,snapshot_hash,plan_hash,input_hash,
        publication_json,plan_json,input_json,pre_question_hash,post_question_hash,max_attempts,initial_paused,actor_id,login_name)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14,$15,$16,true,'','')`,
        [
          tenantId,
          accountId,
          id,
          runId,
          source.authenticatedScope.employeeId,
          source.authenticatedScope.platform,
          validated.input.split,
          source.snapshotHash,
          validated.summary.executionPlanHash,
          inputHash,
          JSON.stringify(source.publication),
          JSON.stringify(source.plan),
          JSON.stringify(validated.input),
          hashContext(preQuestions()),
          hashContext(auditQuestions()),
          maxRunAttempts
        ]
      )
      return id
    })
    if (this.prepared && this.prepared.executionId !== executionId)
      throw new ModelCallError('CONTEXT_UNAVAILABLE')
    this.prepared = structuredClone({ ...validated, source, executionId })
    return structuredClone(this.prepared)
  }

  async bindAssignment(raw: ReplayAssignment): Promise<ReplayCallBinding> {
    const assignment = AssignmentSchema.parse(structuredClone(raw)),
      prepared = this.prepared
    if (
      !prepared ||
      assignment.runId !== prepared.source.runId ||
      !prepared.input.cases.some((c) => c.caseId === assignment.caseId)
    )
      throw new ModelCallError('CONTEXT_UNAVAILABLE')
    const item = prepared.source.plan.assignments.find((c) => c.caseId === assignment.caseId)!
    const binding = ReplayCallBindingSchema.parse({
      ...assignment,
      ...prepared.source.authenticatedScope,
      executionPlanHash: prepared.summary.executionPlanHash,
      snapshotHash: prepared.source.snapshotHash,
      inputHash: item.inputHash
    })
    await this.operate(binding.tenantId, binding.accountId, async (db) => {
      const old = await db.query(
        `SELECT id,input_hash FROM jev_replay_assignments WHERE tenant_id=$1 AND account_id=$2 AND execution_id=$3 AND case_id=$4 AND arm=$5`,
        [binding.tenantId, binding.accountId, prepared.executionId, binding.caseId, binding.arm]
      )
      if (old.rows[0]) {
        if (old.rows[0].id !== binding.assignmentId || old.rows[0].input_hash !== binding.inputHash)
          throw new ModelCallError('CONTEXT_UNAVAILABLE')
        return
      }
      await db.query(
        `INSERT INTO jev_replay_assignments(tenant_id,account_id,execution_id,id,case_id,arm,input_hash) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          binding.tenantId,
          binding.accountId,
          prepared.executionId,
          binding.assignmentId,
          binding.caseId,
          binding.arm,
          binding.inputHash
        ]
      )
    })
    return binding
  }

  async reserve(
    rawBinding: ReplayCallBinding,
    rawStage: ModelStage,
    rawStart: ModelCallStart
  ): Promise<ModelCallHandle> {
    const binding = ReplayCallBindingSchema.parse(structuredClone(rawBinding)),
      stage = ModelStageSchema.parse(rawStage),
      start = ModelCallStartSchema.parse(structuredClone(rawStart)),
      id = randomUUID()
    await this.operate(binding.tenantId, binding.accountId, async (db, actor) => {
      await this.checkBinding(db, binding, actor)
      await db.query(
        `INSERT INTO jev_replay_attempts(tenant_id,account_id,id,assignment_id,stage,start_json) VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
        [
          binding.tenantId,
          binding.accountId,
          id,
          binding.assignmentId,
          stage,
          JSON.stringify(start)
        ]
      )
    }) // COMMIT precedes handing control back to the HTTP transport.
    return {
      finish: async (rawResult) => {
        const result = ModelCallResultSchema.parse(structuredClone(rawResult)),
          resultHash = hashContext(result)
        if (Buffer.byteLength(JSON.stringify(result)) > 65536)
          throw new ModelCallError('RECORD_UNAVAILABLE')
        await this.operate(binding.tenantId, binding.accountId, async (db, actor) => {
          await this.checkBinding(db, binding, actor)
          const old = await db.query(
            'SELECT result_hash,result_json FROM jev_replay_results WHERE tenant_id=$1 AND account_id=$2 AND attempt_id=$3',
            [binding.tenantId, binding.accountId, id]
          )
          if (old.rows[0]) {
            if (
              old.rows[0].result_hash !== resultHash ||
              hashContext(old.rows[0].result_json) !== resultHash
            )
              throw new ModelCallError('RECORD_UNAVAILABLE')
            return
          }
          await db.query(
            'INSERT INTO jev_replay_results(tenant_id,account_id,attempt_id,result_hash,result_json) VALUES($1,$2,$3,$4,$5::jsonb)',
            [binding.tenantId, binding.accountId, id, resultHash, JSON.stringify(result)]
          )
        })
      }
    }
  }

  async readAttempts(rawBinding: ReplayCallBinding): Promise<ReplayAttempt[]> {
    const binding = ReplayCallBindingSchema.parse(structuredClone(rawBinding))
    return this.operate(binding.tenantId, binding.accountId, async (db, actor) => {
      await this.checkBinding(db, binding, actor)
      return this.readAttemptRecords(db, binding)
    })
  }

  /** Called by the trusted runner immediately after core execution, never by a
   * file-registration command. A seal binds measured spans and gate decisions
   * as well as the response digests; it does not authenticate the HTTP provider. */
  async sealArtifact(
    rawBinding: ReplayCallBinding,
    rawArtifact: unknown
  ): Promise<{
    assignmentId: string
    artifactHash: string
    ledgerHash: string
    sealedAt: string
  }> {
    const binding = ReplayCallBindingSchema.parse(structuredClone(rawBinding))
    const artifact = BlindReviewArtifactSchema.parse(structuredClone(rawArtifact))
    if (hashContext(rawArtifact) !== hashContext(artifact))
      throw new ModelCallError('RECORD_UNAVAILABLE')
    return this.operate(binding.tenantId, binding.accountId, async (db, actor) => {
      const row = await this.checkBinding(db, binding, actor)
      const attempts = await this.readAttemptRecords(db, binding)
      this.checkArtifact(binding, artifact, attempts, PublicationSchema.parse(row.publication_json))
      const artifactHash = hashContext(artifact),
        ledgerHash = hashContext(attempts)
      const old = await db.query(
        'SELECT artifact_hash,ledger_hash,attempt_count,sealed_at FROM jev_replay_artifact_seals WHERE tenant_id=$1 AND account_id=$2 AND assignment_id=$3',
        [binding.tenantId, binding.accountId, binding.assignmentId]
      )
      let seal = old.rows[0]
      if (seal) {
        if (
          seal.artifact_hash !== artifactHash ||
          seal.ledger_hash !== ledgerHash ||
          seal.attempt_count !== attempts.length
        )
          throw new ModelCallError('RECORD_UNAVAILABLE')
      } else {
        seal = (
          await db.query(
            `INSERT INTO jev_replay_artifact_seals(tenant_id,account_id,assignment_id,artifact_hash,ledger_hash,attempt_count)
          VALUES($1,$2,$3,$4,$5,$6) RETURNING sealed_at`,
            [
              binding.tenantId,
              binding.accountId,
              binding.assignmentId,
              artifactHash,
              ledgerHash,
              attempts.length
            ]
          )
        ).rows[0]
      }
      return {
        assignmentId: binding.assignmentId,
        artifactHash,
        ledgerHash,
        sealedAt: new Date(seal.sealed_at).toISOString()
      }
    })
  }

  /** Fresh database verification for blind generation/import. Local files cannot
   * register missing seals or replace the original measured result. The same
   * executor administrator is required; independent human labels remain separate. */
  async verifyArtifacts(request: {
    tenantId: string
    accountId: string
    runId: string
    fullRawCases: unknown
    artifacts: unknown
  }): Promise<{
    protocol: 'jev-replay-sealed-v1'
    executionId: string
    artifactSetHash: string
    sealedAssignments: number
    centralRecordVerified: true
    releaseAuthorized: false
  }> {
    const source = await new Administration(
      this.db,
      this.activeTextGeneratorVersion
    ).readFrozenEvaluation(request.tenantId, request.accountId, request.runId)
    const validated = validateFrozenReplayInputs(
      source,
      request.fullRawCases,
      this.activeTextGeneratorVersion
    )
    const artifacts = z.array(BlindReviewArtifactSchema).parse(request.artifacts)
    if (
      hashContext(request.artifacts) !== hashContext(artifacts) ||
      artifacts.length !== validated.input.cases.length * 3
    )
      throw new ModelCallError('RECORD_UNAVAILABLE')
    const planned = new Map(validated.input.cases.map((c) => [c.caseId, c]))
    const pairs = new Set<string>(),
      assignments = new Set<string>()
    return this.operate(request.tenantId, request.accountId, async (db) => {
      const current = (
        await db.query(
          `SELECT a.employee_id,a.platform,a.enabled,e.enabled AS employee_enabled,r.publication_json,r.plan_json,r.snapshot_hash,
        r.created_at,r.expires_at,clock_timestamp() AS server_now FROM accounts a
        JOIN employees e ON (e.tenant_id,e.id)=(a.tenant_id,a.employee_id)
        JOIN evaluation_runs r ON (r.tenant_id,r.account_id)=(a.tenant_id,a.id)
        WHERE a.tenant_id=$1 AND a.id=$2 AND r.id=$3`,
          [request.tenantId, request.accountId, request.runId]
        )
      ).rows[0]
      if (
        !current ||
        !current.enabled ||
        !current.employee_enabled ||
        current.employee_id !== source.authenticatedScope.employeeId ||
        current.platform !== source.authenticatedScope.platform ||
        current.snapshot_hash !== source.snapshotHash ||
        hashContext(current.publication_json) !== hashContext(source.publication) ||
        hashContext(current.plan_json) !== hashContext(source.plan)
      )
        throw new ModelCallError('CONTEXT_UNAVAILABLE')
      validateFrozenReplayInputs(
        {
          ...source,
          createdAt: new Date(current.created_at),
          expiresAt: new Date(current.expires_at),
          serverNow: new Date(current.server_now)
        },
        validated.input,
        this.activeTextGeneratorVersion
      )
      const actual = await db.query(
        'SELECT *,session_user AS current_login FROM jev_replay_executions WHERE tenant_id=$1 AND account_id=$2 AND run_id=$3 AND split=$4',
        [request.tenantId, request.accountId, request.runId, validated.input.split]
      )
      const execution = actual.rows[0]
      if (!execution) throw new ModelCallError('RECORD_UNAVAILABLE')
      this.checkContents(execution)
      const actor = await this.authenticate(db, request.tenantId)
      if (
        execution.actor_id !== actor ||
        execution.login_name !== execution.current_login ||
        execution.employee_id !== source.authenticatedScope.employeeId ||
        execution.platform !== source.authenticatedScope.platform ||
        execution.input_hash !== hashContext(validated.input) ||
        execution.plan_hash !== validated.summary.executionPlanHash ||
        execution.snapshot_hash !== source.snapshotHash ||
        hashContext(execution.publication_json) !== hashContext(source.publication)
      )
        throw new ModelCallError('CONTEXT_UNAVAILABLE')
      const saved = await db.query(
        `SELECT s.id,s.case_id,s.arm,s.input_hash FROM jev_replay_assignments s
        WHERE s.tenant_id=$1 AND s.account_id=$2 AND s.execution_id=$3`,
        [request.tenantId, request.accountId, execution.id]
      )
      if (saved.rows.length !== artifacts.length) throw new ModelCallError('RECORD_UNAVAILABLE')
      // Read each protected relation once rather than joining two RLS-filtered
      // sets. Use only database assignment IDs, under the same account lock.
      const sealedRecords = await db.query(
        `SELECT assignment_id,artifact_hash,ledger_hash,attempt_count FROM jev_replay_artifact_seals
        WHERE tenant_id=$1 AND account_id=$2 AND assignment_id=ANY($3::uuid[])`,
        [request.tenantId, request.accountId, saved.rows.map((row) => row.id)]
      )
      if (sealedRecords.rows.length !== saved.rows.length)
        throw new ModelCallError('RECORD_UNAVAILABLE')
      const assignmentsById = new Map(saved.rows.map((row) => [row.id, row]))
      const seals = new Map(sealedRecords.rows.map((row) => [row.assignment_id, row]))
      const recorded = await db.query(
        `SELECT assignment_id,id,stage,start_json FROM jev_replay_attempts
        WHERE tenant_id=$1 AND account_id=$2 AND assignment_id=ANY($3::uuid[]) ORDER BY reserved_at,attempt_number,id`,
        [request.tenantId, request.accountId, saved.rows.map((row) => row.id)]
      )
      const results = await db.query(
        `SELECT attempt_id,result_json,result_hash FROM jev_replay_results
        WHERE tenant_id=$1 AND account_id=$2 AND attempt_id=ANY($3::uuid[])`,
        [request.tenantId, request.accountId, recorded.rows.map((row) => row.id)]
      )
      const resultsById = new Map(results.rows.map((row) => [row.attempt_id, row]))
      const ledger = new Map<string, ReplayAttempt[]>()
      for (const row of recorded.rows) {
        const entries = ledger.get(row.assignment_id) ?? []
        const result = resultsById.get(row.id)
        entries.push(
          this.parseAttempt({
            ...row,
            result_json: result?.result_json ?? null,
            result_hash: result?.result_hash ?? null
          })
        )
        ledger.set(row.assignment_id, entries)
      }
      for (const artifact of artifacts) {
        const item = planned.get(artifact.caseId),
          pair = `${artifact.caseId}\0${artifact.arm}`
        if (!item || pairs.has(pair) || assignments.has(artifact.assignmentId))
          throw new ModelCallError('RECORD_UNAVAILABLE')
        const binding = ReplayCallBindingSchema.parse({
          ...source.authenticatedScope,
          runId: request.runId,
          caseId: artifact.caseId,
          arm: artifact.arm,
          assignmentId: artifact.assignmentId,
          executionPlanHash: validated.summary.executionPlanHash,
          snapshotHash: source.snapshotHash,
          inputHash: replayCaseInputHash(item)
        })
        const assigned = assignmentsById.get(artifact.assignmentId)
        const sealed = seals.get(artifact.assignmentId)
        if (
          !assigned ||
          assigned.case_id !== binding.caseId ||
          assigned.arm !== binding.arm ||
          assigned.input_hash !== binding.inputHash
        )
          throw new ModelCallError('CONTEXT_UNAVAILABLE')
        const attempts = ledger.get(artifact.assignmentId) ?? []
        this.checkArtifact(binding, artifact, attempts, source.publication)
        if (
          !sealed ||
          sealed.artifact_hash !== hashContext(artifact) ||
          sealed.ledger_hash !== hashContext(attempts) ||
          sealed.attempt_count !== attempts.length
        )
          throw new ModelCallError('RECORD_UNAVAILABLE')
        pairs.add(pair)
        assignments.add(artifact.assignmentId)
      }
      return {
        protocol: 'jev-replay-sealed-v1' as const,
        executionId: execution.id as string,
        artifactSetHash: hashContext(
          artifacts
            .map((a) => ({ assignmentId: a.assignmentId, artifactHash: hashContext(a) }))
            .sort((a, b) => a.assignmentId.localeCompare(b.assignmentId))
        ),
        sealedAssignments: artifacts.length,
        centralRecordVerified: true as const,
        releaseAuthorized: false as const
      }
    })
  }

  private async readAttemptRecords(
    db: PoolClient,
    binding: ReplayCallBinding
  ): Promise<ReplayAttempt[]> {
    const records = await db.query(
      `SELECT id,stage,start_json FROM jev_replay_attempts
        WHERE tenant_id=$1 AND account_id=$2 AND assignment_id=$3 ORDER BY reserved_at,attempt_number,id`,
      [binding.tenantId, binding.accountId, binding.assignmentId]
    )
    const results = await db.query(
      `SELECT attempt_id,result_json,result_hash FROM jev_replay_results
        WHERE tenant_id=$1 AND account_id=$2 AND attempt_id=ANY($3::uuid[])`,
      [binding.tenantId, binding.accountId, records.rows.map((row) => row.id)]
    )
    const resultsById = new Map(results.rows.map((row) => [row.attempt_id, row]))
    return records.rows.map((row) => {
      const result = resultsById.get(row.id)
      return this.parseAttempt({
        ...row,
        result_json: result?.result_json ?? null,
        result_hash: result?.result_hash ?? null
      })
    })
  }

  private parseAttempt(row: Record<string, unknown>): ReplayAttempt {
    if (row.result_json !== null && hashContext(row.result_json) !== row.result_hash)
      throw new ModelCallError('RECORD_UNAVAILABLE')
    return ReplayAttemptSchema.parse({
      attemptId: row.id,
      stage: row.stage,
      start: row.start_json,
      result: row.result_json
    })
  }

  private checkArtifact(
    b: ReplayCallBinding,
    a: z.infer<typeof BlindReviewArtifactSchema>,
    attempts: ReplayAttempt[],
    publication: z.infer<typeof PublicationSchema>
  ): void {
    if (
      a.assignmentId !== b.assignmentId ||
      a.runId !== b.runId ||
      a.caseId !== b.caseId ||
      a.arm !== b.arm ||
      a.inputHash !== b.inputHash ||
      a.executionPlanHash !== b.executionPlanHash ||
      a.snapshotHash !== b.snapshotHash ||
      a.attempts === null ||
      hashContext(a.attempts) !== hashContext(attempts) ||
      attempts.some((t) => t.result === null)
    )
      throw new ModelCallError('RECORD_UNAVAILABLE')
    const expected =
      a.arm === 'A' ? ['text'] : a.arm === 'B' ? ['pre', 'text'] : ['pre', 'text', 'post']
    if (
      a.stages.some((s, i) => s.stage !== expected[i]) ||
      (a.status === 'candidate' && a.stages.length !== expected.length) ||
      Math.abs(
        a.latencyMs - a.otherProcessingMs - a.stages.reduce((sum, s) => sum + s.durationMs, 0)
      ) > 0.000001
    )
      throw new ModelCallError('RECORD_UNAVAILABLE')
    for (const stage of a.stages) {
      const records = attempts.filter((t) => t.stage === stage.stage),
        last = records.at(-1)?.result
      if (
        !last ||
        last.outcome !== 'response' ||
        stage.durationMs + 1 < records.reduce((sum, t) => sum + t.result!.durationMs, 0)
      )
        throw new ModelCallError('RECORD_UNAVAILABLE')
      if (stage.stage === 'text') {
        if (
          !a.draft ||
          last.answers !== undefined ||
          !last.textOutput ||
          last.textOutput.draftHash !== a.draft.draftHash ||
          hashContext(last.textOutput.evidenceIds) !== hashContext(a.draft.evidenceIds)
        )
          throw new ModelCallError('RECORD_UNAVAILABLE')
      } else {
        const response = a[stage.stage]
        if (
          !response ||
          last.answers === undefined ||
          last.textOutput !== undefined ||
          last.actualModel !== publication.policy.modelResolved ||
          last.actualModel !== response.model ||
          hashContext(last.answers) !== hashContext(response.answers) ||
          !last.usage ||
          last.usage.inputTokens !== response.usage.input_tokens ||
          last.usage.outputTokens !== response.usage.output_tokens
        )
          throw new ModelCallError('RECORD_UNAVAILABLE')
      }
    }
    if (
      attempts.some((t) => !a.stages.some((s) => s.stage === t.stage)) ||
      Boolean(a.draft) !== a.stages.some((s) => s.stage === 'text') ||
      Boolean(a.pre) !== a.stages.some((s) => s.stage === 'pre') ||
      Boolean(a.post) !== a.stages.some((s) => s.stage === 'post')
    )
      throw new ModelCallError('RECORD_UNAVAILABLE')
    const complete = attempts.every((t) => t.result!.usage !== undefined)
    const total = complete
      ? attempts.reduce(
          (n, t) => ({
            inputTokens: n.inputTokens + t.result!.usage!.inputTokens,
            outputTokens: n.outputTokens + t.result!.usage!.outputTokens
          }),
          { inputTokens: 0, outputTokens: 0 }
        )
      : null
    if (
      hashContext(total) !== hashContext(a.usage) ||
      a.usageSource !== (complete ? 'recorded_http_attempts' : 'unknown')
    )
      throw new ModelCallError('RECORD_UNAVAILABLE')
  }

  private async checkBinding(
    db: PoolClient,
    b: ReplayCallBinding,
    actor: string
  ): Promise<Record<string, unknown>> {
    const record = await db.query(
      `SELECT e.*,s.case_id,s.arm,s.input_hash AS case_input_hash,session_user AS current_login
      FROM jev_replay_assignments s JOIN jev_replay_executions e ON (e.tenant_id,e.account_id,e.id)=(s.tenant_id,s.account_id,s.execution_id)
      WHERE s.tenant_id=$1 AND s.account_id=$2 AND s.id=$3`,
      [b.tenantId, b.accountId, b.assignmentId]
    )
    const row = record.rows[0]
    if (row) this.checkContents(row)
    if (
      !row ||
      row.actor_id !== actor ||
      row.login_name !== row.current_login ||
      row.run_id !== b.runId ||
      row.case_id !== b.caseId ||
      row.arm !== b.arm ||
      row.employee_id !== b.employeeId ||
      row.platform !== b.platform ||
      row.plan_hash !== b.executionPlanHash ||
      row.snapshot_hash !== b.snapshotHash ||
      row.case_input_hash !== b.inputHash
    )
      throw new ModelCallError('CONTEXT_UNAVAILABLE')
    return row
  }

  /** Content verification is independent from admission time: old reservations
   * remain readable/finishable after expiry, but their sealed inputs cannot change. */
  private checkContents(row: Record<string, unknown>): void {
    // Rehash the actual freshly-read JSON and claimed hashes on every check.
    // Only pure schema/content validation of identical bytes is reused, bounded
    // to one fingerprint. Login, account, review, expiry and quota checks remain
    // fresh; retaining hash columns while changing JSON always misses this cache.
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          publication: row.publication_json,
          plan: row.plan_json,
          input: row.input_json,
          inputHash: row.input_hash,
          planHash: row.plan_hash,
          snapshotHash: row.snapshot_hash,
          preQuestionHash: row.pre_question_hash,
          postQuestionHash: row.post_question_hash,
          split: row.split
        })
      )
      .digest('hex')
    if (fingerprint === this.checkedContents) return
    const publication = PublicationSchema.parse(row.publication_json)
    const plan = EvaluationPlanSchema.parse(row.plan_json)
    const input = ReplayInputSchema.parse(row.input_json)
    const expected = new Map(
      plan.assignments.filter((a) => a.split === input.split).map((a) => [a.caseId, a])
    )
    if (
      row.input_hash !== hashContext(input) ||
      row.plan_hash !== hashContext(plan) ||
      row.snapshot_hash !== evaluationSnapshotHash(publication) ||
      row.pre_question_hash !== hashContext(preQuestions()) ||
      row.post_question_hash !== hashContext(auditQuestions()) ||
      plan.replayProtocol !== 'jev-abc-v1' ||
      input.datasetId !== plan.datasetId ||
      input.split !== row.split ||
      input.cases.length !== expected.size ||
      new Set(input.cases.map((c) => c.caseId)).size !== expected.size ||
      input.cases.some((c) => {
        const a = expected.get(c.caseId)
        return (
          !a ||
          a.conversationGroup !== c.conversationGroup ||
          c.split !== input.split ||
          a.inputHash !== replayCaseInputHash(c)
        )
      })
    )
      throw new ModelCallError('CONTEXT_UNAVAILABLE')
    this.checkedContents = fingerprint
  }

  private async authenticate(db: PoolClient, tenantId: string): Promise<string> {
    const result = await db.query('SELECT * FROM autoreply.authenticate_admin($1)', [tenantId])
    if (result.rows[0]?.tenant_id !== tenantId || !result.rows[0]?.actor_id)
      throw new ModelCallError('CONTEXT_UNAVAILABLE')
    return result.rows[0].actor_id
  }

  private async operate<T>(
    tenantId: string,
    accountId: string,
    operation: (db: PoolClient, actor: string) => Promise<T>
  ): Promise<T> {
    Id.parse(tenantId)
    Id.parse(accountId)
    try {
      return await this.db.transaction(tenantId, async (db) => {
        // Reuse only the principal authenticated in this transaction. Every
        // operation still checks the current login and mapping after BEGIN;
        // no identity or authorization survives across commits.
        const actor = await this.authenticate(db, tenantId)
        const account = await db.query(
          'SELECT id FROM accounts WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
          [tenantId, accountId]
        )
        if (!account.rows[0]) throw new ModelCallError('CONTEXT_UNAVAILABLE')
        return operation(db, actor)
      })
    } catch (error) {
      if (error instanceof ModelCallError) throw error
      const message = error instanceof Error ? error.message : ''
      throw new ModelCallError(
        message.includes('jev_replay_limit_unconfigured')
          ? 'LIMIT_UNCONFIGURED'
          : message.includes('jev_replay_limit_reached')
            ? 'LIMIT_REACHED'
            : 'RECORD_UNAVAILABLE'
      )
    }
  }
}
