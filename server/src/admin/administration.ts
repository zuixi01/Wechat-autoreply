import { randomUUID } from 'node:crypto'
import { readRestoreCompletionAudit } from './restore-completion-audit'
import { recordRestoreHistoryProof, readRestoreHistoryProof } from './restore-history'
import {
  readRestoreExecutionReview,
  readVerifiedRestoreExecutionReview
} from '../recovery/restore-execution-maintenance'
import {
  readRestoreResolutionBasis,
  RestoreResolutionError
} from '../recovery/restore-resolution-basis'
import { readRuntimeStatus, type RuntimeStatusPage } from './runtime-status'
import {
  previewRestoreRecovery,
  readRestoreRecoveryAuthorization
} from '../recovery/restore-recovery-authorization'
import { requestAccountPause, readAccountPause } from './account-pause'
import { requestBulkPause, readBulkPause, readBulkPauseAccounts } from './bulk-pause'
import type { BulkPauseSummary, BulkPausePage } from '../../../src/shared/contracts/bulk-pause'
import {
  readRestoreRulings,
  recordRestoreRuling,
  sealRestoreDecision,
  readRestoreDecision
} from './restore-decisions'
import {
  readRestoreAssessment,
  readCompleteRestoreAssessment,
  recordRestoreEvidence,
  readRestoreEvidence
} from './restore-assessment'
import { readRestoreInventories, readRestoreInventoryItems } from './restore-inventory'
import { readRestorePermitAudit, type RestorePermitAudit } from './restore-permit-audit'
import { ModelCallLimitSchema } from '../generation/model-call-contracts'
import { hasUnappliedRequestSeals } from '../execution/request-seal-state'
import {
  readRestorePauseReceipts,
  readRestorePauseDetail,
  type RestorePauseReceipt,
  type RestorePauseDetail
} from './restore-pause-reports'
import {
  openRestoreReview,
  readRestoreReview,
  readRestorePermits,
  hasRestoreReviews,
  type RestoreReview
} from './restore-review'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { Id } from '../../../src/shared/contracts/identity'
import { Postgres } from '../database/postgres'
import { newCredential, tokenHash } from '../auth/account-authority'
import {
  PublicationSchema,
  storePublication,
  loadPublication,
  type Publication
} from '../generation/publication'
import { writeConfiguration } from '../generation/configuration-store'
import { hashContext } from '../../../src/core/reply/hashes'
import {
  ReconciliationDecisionInputSchema,
  parseReconciliationDecision,
  DeviceReconciliationReportSchema,
  type ReconciliationDecision
} from '../../../src/shared/contracts/reconciliation'
import { evaluationSnapshotHash } from '../generation/evaluation-authorization'
import { loadEnterpriseMemoryCatalog } from '../learning/learning-publication'
import {
  ReconciliationNoteSchema,
  ReconciliationSnapshotSchema,
  type ReconciliationCase
} from './reconciliation'
import {
  FreezeEvaluationSchema,
  EvaluationPlanSchema,
  assessSubmission,
  EvaluationAdmissionError
} from './evaluation-admission'

const Scope = z.strictObject({ tenant_id: Id, actor_id: Id })
type AdminScope = z.infer<typeof Scope>
export interface FrozenEvaluation {
  runId: string
  snapshotHash: string
  createdAt: Date
  expiresAt: Date
}
export interface FrozenEvaluationSnapshot extends FrozenEvaluation {
  authenticatedScope: {
    tenantId: string
    accountId: string
    employeeId: string
    platform: 'wechat' | 'wework'
  }
  publication: Publication
  plan: z.infer<typeof EvaluationPlanSchema>
  serverNow: Date
}
export interface EvaluationApproval {
  evaluationApprovalId: string
  snapshotHash: string
  datasetHash: string
  reportHash: string
}
export interface PreparedLearningPublication {
  publication: Publication
  summary: {
    publicationHash: string
    snapshotHash: string
    configVersion: string
    memoryCorpusVersion: string
    methodCount: number
    requiresIndependentEvaluation: boolean
  }
}
export class AdminError extends Error {
  constructor(
    readonly code:
      | 'DENIED'
      | 'ACCOUNT_NOT_FOUND'
      | 'ACCOUNT_CONFLICT'
      | 'UNRESOLVED_EXECUTION'
      | 'UNRESOLVED_RESTORE'
      | 'CONFIGURATION_UNAVAILABLE'
      | 'PUBLICATION_INVALID'
      | 'AGENT_NOT_FOUND'
      | 'EVALUATION_NOT_FOUND'
      | 'RECONCILIATION_NOT_FOUND'
      | 'RECONCILIATION_CONFLICT'
      | 'RECONCILIATION_LIMIT'
  ) {
    super(code)
    this.name = 'AdminError'
  }
}
/** Dedicated database-login administration, never device-credential authority.
 * The authenticated DB login is mapped by a migration operator to an enabled admin.
 * All changes share the same account lock as lease/permit issuance. */
export class Administration {
  constructor(
    private readonly db: Postgres,
    private readonly expectedGeneratorVersion?: string
  ) {}

  async identity(tenantId: string): Promise<{ tenantId: string; actorId: string }> {
    return this.operate(tenantId, async (_db, scope) => ({
      tenantId: scope.tenant_id,
      actorId: scope.actor_id
    }))
  }

  async setModelLimits(
    tenantId: string,
    accountId: string,
    input: unknown
  ): Promise<Record<string, unknown>> {
    const limits = ModelCallLimitSchema.parse(input)
    accountId = Id.parse(accountId)
    return this.operate(tenantId, async (db, scope) => {
      await this.account(db, scope, accountId)
      const old = await db.query(
        'SELECT daily_attempt_limit,revision FROM model_call_limits WHERE tenant_id=$1 AND account_id=$2',
        [scope.tenant_id, accountId]
      )
      if (old.rows[0]?.daily_attempt_limit === limits.dailyAttemptLimit)
        return {
          accountId,
          dailyAttemptLimit: limits.dailyAttemptLimit,
          revision: String(old.rows[0].revision)
        }
      const saved = await db.query(
        `INSERT INTO model_call_limits(tenant_id,account_id,daily_attempt_limit,revision) VALUES($1,$2,$3,1)
        ON CONFLICT(tenant_id,account_id) DO UPDATE SET daily_attempt_limit=excluded.daily_attempt_limit,revision=model_call_limits.revision+1,updated_at=clock_timestamp() RETURNING revision`,
        [scope.tenant_id, accountId, limits.dailyAttemptLimit]
      )
      const revision = String(saved.rows[0].revision)
      await this.audit(db, scope, accountId, 'model_call_limit_set', {
        dailyAttemptLimit: limits.dailyAttemptLimit,
        revision,
        previousLimit: old.rows[0]?.daily_attempt_limit ?? null
      })
      return { accountId, dailyAttemptLimit: limits.dailyAttemptLimit, revision }
    })
  }

  async modelLimits(tenantId: string, accountId: string): Promise<Record<string, unknown>> {
    accountId = Id.parse(accountId)
    return this.operate(tenantId, async (db, scope) => {
      await this.account(db, scope, accountId)
      const limits = await db.query(
        'SELECT daily_attempt_limit,revision FROM model_call_limits WHERE tenant_id=$1 AND account_id=$2',
        [scope.tenant_id, accountId]
      )
      const used = await db.query(
        `SELECT count(*)::integer AS reserved FROM model_call_attempts WHERE tenant_id=$1 AND account_id=$2 AND usage_day=(clock_timestamp() AT TIME ZONE 'UTC')::date`,
        [scope.tenant_id, accountId]
      )
      return {
        accountId,
        timezone: 'UTC',
        dailyAttemptLimit: limits.rows[0]?.daily_attempt_limit ?? null,
        revision: limits.rows[0] ? String(limits.rows[0].revision) : null,
        reservedToday: used.rows[0].reserved
      }
    })
  }

  async modelRuns(
    tenantId: string,
    accountId: string,
    taskId: string
  ): Promise<Record<string, unknown>[]> {
    accountId = Id.parse(accountId)
    taskId = Id.parse(taskId)
    return this.operate(tenantId, async (db, scope) => {
      await this.account(db, scope, accountId)
      return (
        await db.query(
          `SELECT a.id,a.task_id,a.agent_id,a.task_hash,a.provider,a.stage,a.attempt_number,a.request_hash,a.requested_model,a.question_hash,
        a.config_version,a.policy_version,a.question_set_version,a.knowledge_version,a.limit_revision,a.usage_day,a.started_at,r.completed_at,r.result_json
        FROM model_call_attempts a LEFT JOIN model_call_results r ON (a.tenant_id,a.account_id,a.id)=(r.tenant_id,r.account_id,r.attempt_id)
        WHERE a.tenant_id=$1 AND a.account_id=$2 AND a.task_id=$3 ORDER BY a.started_at,a.id LIMIT 100`,
          [scope.tenant_id, accountId, taskId]
        )
      ).rows
    })
  }

  async modelUsage(
    tenantId: string,
    accountId: string,
    date: string
  ): Promise<Record<string, unknown>[]> {
    accountId = Id.parse(accountId)
    date = z.iso.date().parse(date)
    return this.operate(tenantId, async (db, scope) => {
      await this.account(db, scope, accountId)
      return (
        await db.query(
          `SELECT a.provider,a.stage,count(*)::integer AS reserved_attempts,
        count(*) FILTER(WHERE r.attempt_id IS NULL)::integer AS unfinished_attempts,
        count(*) FILTER(WHERE r.result_json->'usage' IS NULL)::integer AS unknown_usage_attempts,
        count(*) FILTER(WHERE r.result_json->>'outcome'='response')::integer AS schema_valid_responses,
        coalesce(sum((r.result_json->'usage'->>'inputTokens')::numeric),0)::text AS known_input_tokens,
        coalesce(sum((r.result_json->'usage'->>'outputTokens')::numeric),0)::text AS known_output_tokens,
        percentile_cont(0.5) WITHIN GROUP(ORDER BY (r.result_json->>'durationMs')::double precision) AS completed_p50_ms,
        percentile_cont(0.95) WITHIN GROUP(ORDER BY (r.result_json->>'durationMs')::double precision) AS completed_p95_ms
        FROM model_call_attempts a LEFT JOIN model_call_results r ON (a.tenant_id,a.account_id,a.id)=(r.tenant_id,r.account_id,r.attempt_id)
        WHERE a.tenant_id=$1 AND a.account_id=$2 AND a.usage_day=$3::date GROUP BY a.provider,a.stage ORDER BY a.provider,a.stage`,
          [scope.tenant_id, accountId, date]
        )
      ).rows
    })
  }

  async provision(
    tenantId: string,
    input: { employeeId: string; accountId: string; platform: 'wechat' | 'wework' }
  ): Promise<void> {
    const p = z
      .strictObject({ employeeId: Id, accountId: Id, platform: z.enum(['wechat', 'wework']) })
      .parse(input)
    await this.operate(tenantId, async (db, s) => {
      await db.query(
        "INSERT INTO employees(tenant_id,id,role) VALUES($1,$2,'employee') ON CONFLICT DO NOTHING",
        [s.tenant_id, p.employeeId]
      )
      const employee = await db.query(
        'SELECT role,enabled FROM employees WHERE tenant_id=$1 AND id=$2 FOR SHARE',
        [s.tenant_id, p.employeeId]
      )
      if (!employee.rows[0]?.enabled || employee.rows[0].role !== 'employee')
        throw new AdminError('ACCOUNT_CONFLICT')
      await db.query(
        'INSERT INTO accounts(tenant_id,id,employee_id,platform) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [s.tenant_id, p.accountId, p.employeeId, p.platform]
      )
      const account = await this.account(db, s, p.accountId)
      if (
        account.employee_id !== p.employeeId ||
        account.platform !== p.platform ||
        !account.enabled
      )
        throw new AdminError('ACCOUNT_CONFLICT')
      await this.audit(db, s, p.accountId, 'account_provisioned', {
        employeeId: p.employeeId,
        platform: p.platform
      })
    })
  }

  async enroll(
    tenantId: string,
    accountId: string
  ): Promise<{ enrollmentCode: string; validForSeconds: number }> {
    accountId = Id.parse(accountId)
    return this.operate(tenantId, async (db, s) => {
      const account = await this.account(db, s, Id.parse(accountId))
      await this.enabledEmployee(db, s, account.employee_id)
      if (!account.enabled) throw new AdminError('ACCOUNT_CONFLICT')
      const code = newCredential()
      await db.query(
        "INSERT INTO enrollment_codes(code_hash,tenant_id,account_id,employee_id,expires_at) VALUES($1,$2,$3,$4,clock_timestamp()+interval '10 minutes')",
        [tokenHash(code), s.tenant_id, accountId, account.employee_id]
      )
      await this.audit(db, s, accountId, 'enrollment_created', {})
      return { enrollmentCode: code, validForSeconds: 600 }
    })
  }

  async pause(tenantId: string, accountId: string): Promise<void> {
    await this.requestPause(tenantId, accountId)
  }
  async requestPauseAll(tenantId: string, requestId?: string): Promise<BulkPauseSummary> {
    return this.operate(tenantId, (db, s) =>
      requestBulkPause(db, s.tenant_id, s.actor_id, requestId)
    )
  }
  async pauseAllRequest(tenantId: string, requestId: string): Promise<BulkPauseSummary> {
    return this.operate(tenantId, (db, s) => readBulkPause(db, s.tenant_id, requestId))
  }
  async pauseAllAccounts(
    tenantId: string,
    requestId: string,
    input: unknown = {}
  ): Promise<BulkPausePage> {
    return this.operate(tenantId, (db, s) =>
      readBulkPauseAccounts(db, s.tenant_id, requestId, input)
    )
  }

  async requestPause(
    tenantId: string,
    accountId: string,
    requestId?: string
  ): Promise<Record<string, unknown>> {
    accountId = Id.parse(accountId)
    return this.operate(tenantId, async (db, s) => {
      await this.account(db, s, Id.parse(accountId))
      return requestAccountPause(db, s.tenant_id, accountId, s.actor_id, requestId)
    })
  }

  async pauseRequest(
    tenantId: string,
    accountId: string,
    requestId?: string
  ): Promise<Record<string, unknown>> {
    return this.operate(tenantId, (db, s) =>
      readAccountPause(db, s.tenant_id, Id.parse(accountId), requestId)
    )
  }

  async resume(tenantId: string, accountId: string): Promise<void> {
    accountId = Id.parse(accountId)
    await this.operate(tenantId, async (db, s) => {
      const account = await this.account(db, s, Id.parse(accountId))
      if (!account.enabled) throw new AdminError('ACCOUNT_CONFLICT')
      await this.enabledEmployee(db, s, account.employee_id)
      if (await hasRestoreReviews(db, s.tenant_id, accountId))
        throw new AdminError('UNRESOLVED_RESTORE')
      if (await hasUnappliedRequestSeals(db, s.tenant_id, accountId))
        throw new AdminError('UNRESOLVED_EXECUTION')
      const pending = await db.query(
        `SELECT 1 FROM execution_permits p WHERE tenant_id=$1 AND account_id=$2 AND status IN ('issued','unknown')
        AND NOT EXISTS(SELECT 1 FROM reconciliation_decisions d JOIN reconciliation_applied a
        ON (a.tenant_id,a.account_id,a.decision_id)=(d.tenant_id,d.account_id,d.id)
        WHERE (d.tenant_id,d.account_id,d.permit_id)=(p.tenant_id,p.account_id,p.id)) LIMIT 1`,
        [s.tenant_id, accountId]
      )
      if (pending.rowCount) throw new AdminError('UNRESOLVED_EXECUTION')
      const publication = await loadPublication(db, {
        tenant_id: s.tenant_id,
        account_id: accountId
      })
      this.validateGenerator(publication)
      await db.query('UPDATE accounts SET paused=false WHERE tenant_id=$1 AND id=$2', [
        s.tenant_id,
        accountId
      ])
      await this.audit(db, s, accountId, 'account_resume_allowed', {
        configVersion: publication.configuration.configVersion
      })
    })
  }

  async revoke(tenantId: string, accountId: string, agentId: string): Promise<void> {
    accountId = Id.parse(accountId)
    agentId = Id.parse(agentId)
    await this.operate(tenantId, async (db, s) => {
      await this.account(db, s, Id.parse(accountId))
      const result = await db.query(
        'UPDATE agents SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE tenant_id=$1 AND account_id=$2 AND id=$3 RETURNING id',
        [s.tenant_id, accountId, Id.parse(agentId)]
      )
      if (!result.rowCount) throw new AdminError('AGENT_NOT_FOUND')
      await db.query('UPDATE accounts SET paused=true WHERE tenant_id=$1 AND id=$2', [
        s.tenant_id,
        accountId
      ])
      await db.query(
        'UPDATE account_leases SET expires_at=LEAST(expires_at,clock_timestamp()) WHERE tenant_id=$1 AND account_id=$2 AND agent_id=$3',
        [s.tenant_id, accountId, agentId]
      )
      await this.audit(db, s, accountId, 'agent_revoked_account_paused', { agentId })
    })
  }

  async prepareLearningPublication(
    tenantId: string,
    accountId: string,
    input: unknown
  ): Promise<PreparedLearningPublication> {
    accountId = Id.parse(accountId)
    const template = PublicationSchema.parse(structuredClone(input))
    this.validateGenerator(template)
    return this.operate(tenantId, async (db, s) => {
      const account = await this.account(db, s, accountId)
      if (!account.enabled) throw new AdminError('ACCOUNT_CONFLICT')
      if (
        template.evidence.some(
          (e) => e.tenantId !== s.tenant_id || (e.accountId && e.accountId !== accountId)
        )
      )
        throw new AdminError('PUBLICATION_INVALID')
      const catalog = await loadEnterpriseMemoryCatalog(db, {
        tenant_id: s.tenant_id,
        account_id: accountId
      })
      delete template.evaluationApprovalId
      const publication = PublicationSchema.parse({
        ...template,
        ...catalog,
        configuration: {
          ...template.configuration,
          configVersion: randomUUID(),
          memoryCorpusVersion: catalog.memoryCorpusVersion
        }
      })
      const summary = {
        publicationHash: hashContext(publication),
        snapshotHash: evaluationSnapshotHash(publication),
        configVersion: publication.configuration.configVersion,
        memoryCorpusVersion: catalog.memoryCorpusVersion,
        methodCount: catalog.memoryManifest.length,
        requiresIndependentEvaluation: publication.configuration.automaticEnabled
      }
      await this.audit(db, s, accountId, 'learning_publication_prepared', summary)
      return { publication, summary }
    })
  }

  async publish(tenantId: string, accountId: string, input: Publication): Promise<void> {
    accountId = Id.parse(accountId)
    const publication = PublicationSchema.parse(structuredClone(input))
    this.validateGenerator(publication)
    await this.operate(tenantId, async (db, s) => {
      const account = await this.account(db, s, Id.parse(accountId))
      if (!account.enabled) throw new AdminError('ACCOUNT_CONFLICT')
      await storePublication(db, { tenant_id: s.tenant_id, account_id: accountId }, publication)
      await writeConfiguration(
        db,
        { tenant_id: s.tenant_id, account_id: accountId },
        {
          ...publication.configuration,
          memoryCorpusVersion: publication.memoryCorpusVersion ?? 'empty-enterprise-memory-v1'
        }
      )
      await this.audit(db, s, accountId, 'configuration_published', {
        configVersion: publication.configuration.configVersion,
        automaticEnabled: publication.configuration.automaticEnabled
      })
    }) // Immutable contents, active metadata and audit either all commit or all roll back.
  }

  async accounts(tenantId: string): Promise<Record<string, unknown>[]> {
    return this.operate(
      tenantId,
      async (db, s) =>
        (
          await db.query(
            `SELECT a.id AS account_id,a.employee_id,a.platform,a.enabled,a.paused AS server_paused,
      c.config_version,c.automatic_enabled,l.agent_id AS lease_agent_id,l.version AS lease_version,
      l.expires_at AS lease_expires_at,l.expires_at>clock_timestamp() AS lease_live,
      (SELECT count(*)::integer FROM execution_permits p WHERE p.tenant_id=a.tenant_id AND p.account_id=a.id AND p.status IN ('issued','unknown')
        AND NOT EXISTS(SELECT 1 FROM reconciliation_decisions d JOIN reconciliation_applied r ON (r.tenant_id,r.account_id,r.decision_id)=(d.tenant_id,d.account_id,d.id)
        WHERE (d.tenant_id,d.account_id,d.permit_id)=(p.tenant_id,p.account_id,p.id))) AS unresolved_count,
      (SELECT count(*)::integer FROM execution_request_seals s WHERE s.tenant_id=a.tenant_id AND s.account_id=a.id
        AND NOT EXISTS(SELECT 1 FROM execution_request_seal_applications r WHERE
          (r.tenant_id,r.account_id,r.seal_id)=(s.tenant_id,s.account_id,s.id) AND r.seal_hash=s.seal_hash AND r.agent_id=s.agent_id)) AS unapplied_request_seals
      FROM accounts a LEFT JOIN published_configurations c ON (c.tenant_id,c.account_id)=(a.tenant_id,a.id)
      LEFT JOIN account_leases l ON (l.tenant_id,l.account_id)=(a.tenant_id,a.id)
      WHERE a.tenant_id=$1 ORDER BY a.id LIMIT 200`,
            [s.tenant_id]
          )
        ).rows
    )
  }

  async runtimeStatus(tenantId: string, input: unknown = {}): Promise<RuntimeStatusPage> {
    return this.operate(tenantId, (db, scope) => readRuntimeStatus(db, scope.tenant_id, input))
  }

  async freezeEvaluation(
    tenantId: string,
    accountId: string,
    input: unknown
  ): Promise<FrozenEvaluation> {
    accountId = Id.parse(accountId)
    const f = FreezeEvaluationSchema.parse(structuredClone(input))
    this.validateGenerator(f.publication)
    return this.operate(tenantId, async (db, s) => {
      const account = await this.account(db, s, accountId)
      if (!account.enabled) throw new AdminError('ACCOUNT_CONFLICT')
      if (
        f.publication.evidence.some(
          (e) => e.tenantId !== s.tenant_id || (e.accountId && e.accountId !== accountId)
        )
      )
        throw new AdminError('PUBLICATION_INVALID')
      const runId = randomUUID(),
        snapshotHash = evaluationSnapshotHash(f.publication)
      const row = await db.query(
        `INSERT INTO evaluation_runs(tenant_id,account_id,id,snapshot_hash,publication_json,plan_json,created_by)
        VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7) RETURNING created_at,expires_at`,
        [
          s.tenant_id,
          accountId,
          runId,
          snapshotHash,
          JSON.stringify(f.publication),
          JSON.stringify(f.plan),
          s.actor_id
        ]
      )
      await this.audit(db, s, accountId, 'evaluation_frozen', {
        runId,
        snapshotHash,
        datasetId: f.plan.datasetId
      })
      return {
        runId,
        snapshotHash,
        createdAt: row.rows[0].created_at,
        expiresAt: row.rows[0].expires_at
      }
    })
  }

  /** Read the original server freeze for an isolated evaluator. This read does
   * not approve a publication, run a model or create device execution authority. */
  async readFrozenEvaluation(
    tenantId: string,
    accountId: string,
    runId: string
  ): Promise<FrozenEvaluationSnapshot> {
    accountId = Id.parse(accountId)
    runId = Id.parse(runId)
    return this.operate(tenantId, async (db, scope) => {
      const account = await this.account(db, scope, accountId)
      if (!account.enabled) throw new AdminError('ACCOUNT_CONFLICT')
      const result = await db.query(
        `SELECT id,snapshot_hash,publication_json,plan_json,created_at,expires_at,
          clock_timestamp() AS server_now FROM evaluation_runs
        WHERE tenant_id=$1 AND account_id=$2 AND id=$3 AND expires_at>clock_timestamp()`,
        [scope.tenant_id, accountId, runId]
      )
      const row = result.rows[0]
      if (!row) throw new AdminError('EVALUATION_NOT_FOUND')
      const publication = PublicationSchema.parse(row.publication_json)
      const plan = EvaluationPlanSchema.parse(row.plan_json)
      this.validateGenerator(publication)
      if (row.snapshot_hash !== evaluationSnapshotHash(publication))
        throw new EvaluationAdmissionError('frozen_snapshot_invalid')
      return {
        runId: row.id,
        authenticatedScope: {
          tenantId: scope.tenant_id,
          accountId,
          employeeId: Id.parse(account.employee_id),
          platform: z.enum(['wechat', 'wework']).parse(account.platform)
        },
        snapshotHash: row.snapshot_hash,
        publication,
        plan,
        createdAt: new Date(row.created_at),
        expiresAt: new Date(row.expires_at),
        serverNow: new Date(row.server_now)
      }
    })
  }

  async approveEvaluation(
    tenantId: string,
    accountId: string,
    runId: string,
    input: unknown
  ): Promise<EvaluationApproval> {
    accountId = Id.parse(accountId)
    runId = Id.parse(runId)
    // Authenticate before expensive parsing/bootstrap, then release SQL locks during computation.
    const frozen = await this.operate(tenantId, async (db, s) => {
      await this.account(db, s, accountId)
      const row = await db.query(
        `SELECT *,clock_timestamp() AS server_now FROM evaluation_runs
        WHERE tenant_id=$1 AND account_id=$2 AND id=$3 AND expires_at>clock_timestamp()`,
        [s.tenant_id, accountId, runId]
      )
      if (!row.rows[0]) throw new AdminError('EVALUATION_NOT_FOUND')
      // A replay plan needs central call, artifact, blind-review and billing
      // provenance. A hand-written submission with the correct plan hash cannot
      // establish that chain; keep this path closed until it is linked here.
      if (EvaluationPlanSchema.parse(row.rows[0].plan_json).replayProtocol === 'jev-abc-v1')
        throw new EvaluationAdmissionError('central_replay_evidence_required')
      return { run: row.rows[0], actorId: s.actor_id }
    })
    const publication = PublicationSchema.parse(frozen.run.publication_json)
    this.validateGenerator(publication)
    if (frozen.run.snapshot_hash !== evaluationSnapshotHash(publication))
      throw new EvaluationAdmissionError('frozen_snapshot_invalid')
    const assessed = assessSubmission(
      input,
      {
        publication,
        plan: frozen.run.plan_json,
        createdAt: new Date(frozen.run.created_at).getTime(),
        now: new Date(frozen.run.server_now).getTime()
      },
      frozen.actorId
    )
    const datasetHash = hashContext(assessed.submission),
      reportHash = hashContext(assessed.report)
    return this.operate(tenantId, async (db, s) => {
      await this.account(db, s, accountId)
      if (s.actor_id !== frozen.actorId) throw new AdminError('DENIED')
      await this.enabledEmployee(db, s, assessed.submission.dataset.adjudicatedBy)
      const run = await db.query(
        `SELECT snapshot_hash FROM evaluation_runs WHERE tenant_id=$1 AND account_id=$2 AND id=$3
        AND expires_at>clock_timestamp()`,
        [s.tenant_id, accountId, runId]
      )
      if (run.rows[0]?.snapshot_hash !== frozen.run.snapshot_hash)
        throw new AdminError('EVALUATION_NOT_FOUND')
      const old = await db.query(
        'SELECT id,dataset_hash,revoked_at FROM evaluation_approvals WHERE tenant_id=$1 AND account_id=$2 AND run_id=$3',
        [s.tenant_id, accountId, runId]
      )
      if (old.rows[0]) {
        if (old.rows[0].revoked_at || old.rows[0].dataset_hash !== datasetHash)
          throw new EvaluationAdmissionError('run_already_decided')
        return {
          evaluationApprovalId: old.rows[0].id,
          snapshotHash: frozen.run.snapshot_hash,
          datasetHash,
          reportHash
        }
      }
      const evaluationApprovalId = randomUUID()
      await db.query(
        `INSERT INTO evaluation_approvals(tenant_id,account_id,id,run_id,snapshot_hash,dataset_hash,report_hash,report_json,approved_by,adjudicated_by,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)`,
        [
          s.tenant_id,
          accountId,
          evaluationApprovalId,
          runId,
          frozen.run.snapshot_hash,
          datasetHash,
          reportHash,
          JSON.stringify(assessed.report),
          s.actor_id,
          assessed.submission.dataset.adjudicatedBy,
          frozen.run.expires_at
        ]
      )
      await this.audit(db, s, accountId, 'evaluation_approved', {
        evaluationApprovalId,
        runId,
        datasetHash,
        reportHash
      })
      return {
        evaluationApprovalId,
        snapshotHash: frozen.run.snapshot_hash,
        datasetHash,
        reportHash
      }
    })
  }

  async evaluations(tenantId: string, accountId: string): Promise<Record<string, unknown>[]> {
    accountId = Id.parse(accountId)
    return this.operate(tenantId, async (db, s) => {
      await this.account(db, s, accountId)
      return (
        await db.query(
          `SELECT r.id AS run_id,r.snapshot_hash,r.created_by,r.created_at,r.expires_at,
        a.id AS evaluation_approval_id,a.dataset_hash,a.report_hash,a.approved_by,a.adjudicated_by,a.revoked_at
        FROM evaluation_runs r LEFT JOIN evaluation_approvals a ON (a.tenant_id,a.account_id,a.run_id)=(r.tenant_id,r.account_id,r.id)
        WHERE r.tenant_id=$1 AND r.account_id=$2 ORDER BY r.created_at DESC LIMIT 200`,
          [s.tenant_id, accountId]
        )
      ).rows
    })
  }

  async revokeEvaluation(tenantId: string, accountId: string, approvalId: string): Promise<void> {
    accountId = Id.parse(accountId)
    approvalId = Id.parse(approvalId)
    await this.operate(tenantId, async (db, s) => {
      await this.account(db, s, accountId)
      const result = await db.query(
        `UPDATE evaluation_approvals SET revoked_at=COALESCE(revoked_at,clock_timestamp())
        WHERE tenant_id=$1 AND account_id=$2 AND id=$3 RETURNING id`,
        [s.tenant_id, accountId, approvalId]
      )
      if (!result.rowCount) throw new AdminError('EVALUATION_NOT_FOUND')
      await db.query('UPDATE accounts SET paused=true WHERE tenant_id=$1 AND id=$2', [
        s.tenant_id,
        accountId
      ])
      await this.audit(db, s, accountId, 'evaluation_revoked_account_paused', {
        evaluationApprovalId: approvalId
      })
    })
  }

  async unresolved(tenantId: string, accountId: string): Promise<Record<string, unknown>[]> {
    accountId = Id.parse(accountId)
    return this.operate(tenantId, async (db, s) => {
      await this.account(db, s, Id.parse(accountId))
      return (
        await db.query(
          `SELECT id AS permit_id,task_id,agent_id,status,task_hash,draft_hash,lease_version,login_epoch,
        client_instance_id,issued_at,expires_at,settled_at FROM execution_permits p
        WHERE tenant_id=$1 AND account_id=$2 AND status IN ('issued','unknown')
        AND NOT EXISTS(SELECT 1 FROM reconciliation_decisions d JOIN reconciliation_applied r ON (r.tenant_id,r.account_id,r.decision_id)=(d.tenant_id,d.account_id,d.id)
        WHERE (d.tenant_id,d.account_id,d.permit_id)=(p.tenant_id,p.account_id,p.id)) ORDER BY issued_at,id LIMIT 200`,
          [s.tenant_id, accountId]
        )
      ).rows
    })
  }

  async requestSeals(tenantId: string, accountId: string): Promise<Record<string, unknown>[]> {
    accountId = Id.parse(accountId)
    return this.operate(tenantId, async (db, s) => {
      await this.account(db, s, accountId)
      return (
        await db.query(
          `SELECT s.id AS seal_id,s.task_id,s.agent_id,s.request_hash,s.seal_hash,s.sealed_at,
        s.seal_json->'input'->>'executionId' AS execution_id,r.applied_at
        FROM execution_request_seals s LEFT JOIN execution_request_seal_applications r
        ON (r.tenant_id,r.account_id,r.seal_id)=(s.tenant_id,s.account_id,s.id) AND r.seal_hash=s.seal_hash AND r.agent_id=s.agent_id
        WHERE s.tenant_id=$1 AND s.account_id=$2 ORDER BY s.sealed_at,s.id LIMIT 200`,
          [s.tenant_id, accountId]
        )
      ).rows
    })
  }
  async openReconciliation(
    tenantId: string,
    accountId: string,
    permitId: string
  ): Promise<ReconciliationCase> {
    accountId = Id.parse(accountId)
    permitId = Id.parse(permitId)
    return this.operate(tenantId, async (db, s) => {
      await this.account(db, s, accountId)
      const permit = await db.query(
        `SELECT status,jsonb_build_object(
          'tenantId',tenant_id,'accountId',account_id,'permitId',id,'agentId',agent_id,
          'taskId',task_id,'taskHash',task_hash,'draftHash',draft_hash,'draftRevision',draft_revision,
          'leaseVersion',lease_version,'loginEpoch',login_epoch,'clientInstanceId',client_instance_id,
          'conversationId',conversation_id,'purpose',purpose,'confirmationId',confirmation_id,
          'statusAtOpening',status,'issuedAt',floor(extract(epoch FROM issued_at)*1000),
          'expiresAt',floor(extract(epoch FROM expires_at)*1000),
          'settledAt',floor(extract(epoch FROM settled_at)*1000),'settlementHash',settlement_hash
        ) AS snapshot FROM execution_permits
        WHERE tenant_id=$1 AND account_id=$2 AND id=$3`,
        [s.tenant_id, accountId, permitId]
      )
      if (!permit.rows[0]) throw new AdminError('RECONCILIATION_NOT_FOUND')
      if (!['issued', 'unknown'].includes(permit.rows[0].status))
        throw new AdminError('RECONCILIATION_CONFLICT')
      // Server pause prevents new admission. It does not attest physical quiescence.
      const paused = await db.query(
        'UPDATE accounts SET paused=true WHERE tenant_id=$1 AND id=$2 AND NOT paused RETURNING id',
        [s.tenant_id, accountId]
      )
      if (paused.rowCount)
        await this.audit(db, s, accountId, 'reconciliation_account_paused', { permitId })
      const old = await db.query(
        'SELECT id FROM reconciliation_cases WHERE tenant_id=$1 AND account_id=$2 AND permit_id=$3',
        [s.tenant_id, accountId, permitId]
      )
      if (old.rows[0]) return this.readReconciliationCase(db, s, accountId, old.rows[0].id)
      const snapshot = ReconciliationSnapshotSchema.parse(permit.rows[0].snapshot)
      const snapshotHash = hashContext(snapshot),
        caseId = randomUUID()
      await db.query(
        `INSERT INTO reconciliation_cases(tenant_id,account_id,id,permit_id,snapshot_hash,snapshot_json,opened_by)
         VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`,
        [
          s.tenant_id,
          accountId,
          caseId,
          permitId,
          snapshotHash,
          JSON.stringify(snapshot),
          s.actor_id
        ]
      )
      await this.audit(db, s, accountId, 'reconciliation_opened', {
        caseId,
        permitId,
        snapshotHash
      })
      return this.readReconciliationCase(db, s, accountId, caseId)
    })
  }

  async reconciliations(tenantId: string, accountId: string): Promise<Record<string, unknown>[]> {
    accountId = Id.parse(accountId)
    return this.operate(tenantId, async (db, s) => {
      await this.account(db, s, accountId)
      return (
        await db.query(
          `SELECT c.id AS case_id,c.permit_id,c.snapshot_hash,c.opened_by,c.opened_at,
          p.status AS current_permit_status,d.id AS decision_id,d.outcome AS resolution,a.applied_at,
          (SELECT count(*)::integer FROM reconciliation_notes n WHERE (n.tenant_id,n.account_id,n.case_id)=(c.tenant_id,c.account_id,c.id)) AS note_count
         FROM reconciliation_cases c JOIN execution_permits p
           ON (p.tenant_id,p.account_id,p.id)=(c.tenant_id,c.account_id,c.permit_id)
         LEFT JOIN reconciliation_decisions d ON (d.tenant_id,d.account_id,d.case_id)=(c.tenant_id,c.account_id,c.id)
         LEFT JOIN reconciliation_applied a ON (a.tenant_id,a.account_id,a.decision_id)=(d.tenant_id,d.account_id,d.id)
         WHERE c.tenant_id=$1 AND c.account_id=$2 ORDER BY c.opened_at DESC,c.id LIMIT 200`,
          [s.tenant_id, accountId]
        )
      ).rows
    })
  }

  async reconciliation(
    tenantId: string,
    accountId: string,
    caseId: string
  ): Promise<{
    case: ReconciliationCase
    currentPermitStatus: string
    notes: Record<string, unknown>[]
    deviceReport: Record<string, unknown> | null
    decision: Record<string, unknown> | null
  }> {
    accountId = Id.parse(accountId)
    caseId = z.string().uuid().parse(caseId)
    return this.operate(tenantId, async (db, s) => {
      await this.account(db, s, accountId)
      const saved = await this.readReconciliationCase(db, s, accountId, caseId)
      const current = await db.query(
        'SELECT status FROM execution_permits WHERE tenant_id=$1 AND account_id=$2 AND id=$3',
        [s.tenant_id, accountId, saved.snapshot.permitId]
      )
      const notes = await db.query(
        `SELECT id AS note_id,snapshot_hash,reference_id,evidence_hash,observed_at,recorded_by,recorded_at
         FROM reconciliation_notes WHERE tenant_id=$1 AND account_id=$2 AND case_id=$3
         ORDER BY recorded_at,id LIMIT 100`,
        [s.tenant_id, accountId, caseId]
      )
      const evidence = await db.query(
        'SELECT agent_id,snapshot_hash,report_hash,report_json,recorded_at FROM device_reconciliation_reports WHERE tenant_id=$1 AND account_id=$2 AND case_id=$3',
        [s.tenant_id, accountId, caseId]
      )
      const decision = await db.query(
        `SELECT d.decision_json,a.applied_at FROM reconciliation_decisions d
        LEFT JOIN reconciliation_applied a ON (a.tenant_id,a.account_id,a.decision_id)=(d.tenant_id,d.account_id,d.id)
        WHERE d.tenant_id=$1 AND d.account_id=$2 AND d.case_id=$3`,
        [s.tenant_id, accountId, caseId]
      )
      return {
        case: saved,
        currentPermitStatus: current.rows[0].status,
        notes: notes.rows,
        deviceReport: evidence.rows[0] ?? null,
        decision: decision.rows[0] ?? null
      }
    })
  }

  async recordReconciliationNote(
    tenantId: string,
    accountId: string,
    caseId: string,
    input: unknown
  ): Promise<{
    noteId: string
    caseId: string
    snapshotHash: string
    devicePauseAcknowledged: null
  }> {
    accountId = Id.parse(accountId)
    caseId = z.string().uuid().parse(caseId)
    const note = ReconciliationNoteSchema.parse(input)
    return this.operate(tenantId, async (db, s) => {
      await this.account(db, s, accountId)
      const saved = await this.readReconciliationCase(db, s, accountId, caseId)
      if (saved.snapshotHash !== note.snapshotHash) throw new AdminError('RECONCILIATION_CONFLICT')
      const requestHash = hashContext({ caseId, ...note })
      const old = await db.query(
        'SELECT case_id,request_hash FROM reconciliation_notes WHERE tenant_id=$1 AND account_id=$2 AND id=$3',
        [s.tenant_id, accountId, note.noteId]
      )
      if (old.rows[0]) {
        if (old.rows[0].case_id !== caseId || old.rows[0].request_hash !== requestHash)
          throw new AdminError('RECONCILIATION_CONFLICT')
      } else {
        if (saved.noteCount >= 100) throw new AdminError('RECONCILIATION_LIMIT')
        const time = await db.query(
          'SELECT floor(extract(epoch FROM clock_timestamp())*1000) AS now'
        )
        if (note.observedAt < saved.snapshot.issuedAt || note.observedAt > Number(time.rows[0].now))
          throw new AdminError('RECONCILIATION_CONFLICT')
        await db.query(
          `INSERT INTO reconciliation_notes(tenant_id,account_id,id,case_id,snapshot_hash,
             reference_id,evidence_hash,request_hash,observed_at,recorded_by)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            s.tenant_id,
            accountId,
            note.noteId,
            caseId,
            note.snapshotHash,
            note.referenceId,
            note.evidenceHash,
            requestHash,
            new Date(note.observedAt),
            s.actor_id
          ]
        )
        await this.audit(db, s, accountId, 'reconciliation_note_recorded', {
          caseId,
          noteId: note.noteId,
          snapshotHash: note.snapshotHash,
          referenceId: note.referenceId,
          evidenceHash: note.evidenceHash
        })
      }
      return {
        noteId: note.noteId,
        caseId,
        snapshotHash: note.snapshotHash,
        devicePauseAcknowledged: null
      }
    })
  }

  async decideReconciliation(
    tenantId: string,
    accountId: string,
    caseId: string,
    input: unknown
  ): Promise<ReconciliationDecision> {
    accountId = Id.parse(accountId)
    caseId = z.string().uuid().parse(caseId)
    const decision = ReconciliationDecisionInputSchema.parse(structuredClone(input))
    return this.operate(tenantId, async (db, s) => {
      await this.account(db, s, accountId)
      const saved = await this.readReconciliationCase(db, s, accountId, caseId)
      const found = await db.query(
        'SELECT report_hash,report_json FROM device_reconciliation_reports WHERE tenant_id=$1 AND account_id=$2 AND case_id=$3',
        [s.tenant_id, accountId, caseId]
      )
      if (!found.rows[0]) throw new AdminError('RECONCILIATION_NOT_FOUND')
      const report = DeviceReconciliationReportSchema.parse(found.rows[0].report_json)
      if (
        hashContext(report) !== found.rows[0].report_hash ||
        saved.snapshotHash !== decision.snapshotHash ||
        hashContext(report) !== decision.reportHash ||
        report.observation.status !== decision.outcome
      )
        throw new AdminError('RECONCILIATION_CONFLICT')
      try {
        const result = await db.query(
          'SELECT autoreply.decide_reconciliation($1,$2,$3::uuid,$4::uuid,$5,$6,$7::uuid,$8) AS decision',
          [
            s.tenant_id,
            accountId,
            caseId,
            decision.decisionId,
            decision.snapshotHash,
            decision.reportHash,
            decision.noteId,
            decision.outcome
          ]
        )
        return parseReconciliationDecision(result.rows[0].decision, report, hashContext(report))
      } catch {
        throw new AdminError('RECONCILIATION_CONFLICT')
      }
    })
  }

  async openRestoreReview(
    tenantId: string,
    accountId: string,
    input: unknown
  ): Promise<RestoreReview> {
    accountId = Id.parse(accountId)
    return this.operate(tenantId, async (db, s) => {
      const account = await this.account(db, s, accountId)
      if (!account.enabled) throw new AdminError('ACCOUNT_CONFLICT')
      await this.enabledEmployee(db, s, account.employee_id)
      return openRestoreReview(db, s, accountId, input)
    })
  }
  async restoreReviews(tenantId: string, accountId: string): Promise<RestoreReview[]> {
    accountId = Id.parse(accountId)
    return this.operate(tenantId, async (db, s) => {
      await this.account(db, s, accountId)
      const rows = await db.query(
        'SELECT id FROM ledger_restore_reviews WHERE tenant_id=$1 AND account_id=$2 ORDER BY opened_at,id LIMIT 100',
        [s.tenant_id, accountId]
      )
      const results: RestoreReview[] = []
      for (const row of rows.rows) results.push(await readRestoreReview(db, s, accountId, row.id))
      return results
    })
  }
  async restoreReview(tenantId: string, accountId: string, caseId: string): Promise<RestoreReview> {
    accountId = Id.parse(accountId)
    caseId = z.uuid().parse(caseId)
    return this.operate(tenantId, async (db, s) => {
      await this.account(db, s, accountId)
      return readRestoreReview(db, s, accountId, caseId)
    })
  }
  async restoreReviewPermits(
    tenantId: string,
    accountId: string,
    caseId: string,
    input: unknown = {}
  ): Promise<Record<string, unknown>[]> {
    accountId = Id.parse(accountId)
    caseId = z.uuid().parse(caseId)
    return this.operate(tenantId, async (db, s) => {
      await this.account(db, s, accountId)
      return readRestorePermits(db, s, accountId, caseId, input)
    })
  }
  async restorePauseReports(
    tenantId: string,
    accountId: string,
    caseId: string,
    input: unknown = {}
  ): Promise<RestorePauseReceipt[]> {
    accountId = Id.parse(accountId)
    caseId = z.uuid().parse(caseId)
    return this.operate(tenantId, async (db, s) => {
      await this.account(db, s, accountId)
      return readRestorePauseReceipts(db, s, accountId, caseId, input)
    })
  }
  async restoreInventories(
    tenantId: string,
    accountId: string,
    caseId: string,
    input: unknown = {}
  ): ReturnType<typeof readRestoreInventories> {
    accountId = Id.parse(accountId)
    caseId = z.uuid().parse(caseId)
    return this.operate(tenantId, async (db, s) => {
      await this.account(db, s, accountId)
      return readRestoreInventories(db, s, accountId, caseId, input)
    })
  }
  async restoreInventoryItems(
    tenantId: string,
    accountId: string,
    caseId: string,
    uploadId: string,
    input: unknown = {}
  ): ReturnType<typeof readRestoreInventoryItems> {
    accountId = Id.parse(accountId)
    caseId = z.uuid().parse(caseId)
    uploadId = z.uuid().parse(uploadId)
    return this.operate(tenantId, async (db, s) => {
      await this.account(db, s, accountId)
      return readRestoreInventoryItems(db, s, accountId, caseId, uploadId, input)
    })
  }
  async restoreRulings(
    tenantId: string,
    accountId: string,
    caseId: string,
    uploadId: string,
    input: unknown = {}
  ): ReturnType<typeof readRestoreRulings> {
    accountId = Id.parse(accountId)
    caseId = z.uuid().parse(caseId).toLowerCase()
    uploadId = z.uuid().parse(uploadId).toLowerCase()
    return this.operate(tenantId, async (db, s) => {
      await this.account(db, s, accountId)
      return readRestoreRulings(db, s, accountId, caseId, uploadId, input)
    })
  }
  async recordRestoreRuling(
    tenantId: string,
    accountId: string,
    caseId: string,
    uploadId: string,
    input: unknown
  ): ReturnType<typeof recordRestoreRuling> {
    accountId = Id.parse(accountId)
    caseId = z.uuid().parse(caseId).toLowerCase()
    uploadId = z.uuid().parse(uploadId).toLowerCase()
    return this.operate(tenantId, async (db, s) => {
      await this.account(db, s, accountId)
      return recordRestoreRuling(db, s, accountId, caseId, uploadId, input)
    })
  }
  async sealRestoreDecision(
    tenantId: string,
    accountId: string,
    caseId: string,
    uploadId: string,
    input: unknown
  ): ReturnType<typeof sealRestoreDecision> {
    accountId = Id.parse(accountId)
    caseId = z.uuid().parse(caseId).toLowerCase()
    uploadId = z.uuid().parse(uploadId).toLowerCase()
    return this.operate(tenantId, async (db, s) => {
      await this.account(db, s, accountId)
      return sealRestoreDecision(db, s, accountId, caseId, uploadId, input)
    })
  }
  async restoreDecision(
    tenantId: string,
    accountId: string,
    caseId: string,
    uploadId: string,
    decisionId: string
  ): ReturnType<typeof readRestoreDecision> {
    accountId = Id.parse(accountId)
    caseId = z.uuid().parse(caseId).toLowerCase()
    uploadId = z.uuid().parse(uploadId).toLowerCase()
    decisionId = z.uuid().parse(decisionId).toLowerCase()
    return this.operate(tenantId, async (db, s) => {
      await this.account(db, s, accountId)
      return readRestoreDecision(db, s, accountId, caseId, uploadId, decisionId)
    })
  }
  async restoreAssessment(
    tenantId: string,
    accountId: string,
    caseId: string,
    uploadId: string,
    input: unknown = {}
  ): ReturnType<typeof readRestoreAssessment> {
    accountId = Id.parse(accountId)
    caseId = z.uuid().parse(caseId).toLowerCase()
    uploadId = z.uuid().parse(uploadId).toLowerCase()
    return this.operate(tenantId, async (db, s) => {
      await this.account(db, s, accountId)
      return readRestoreAssessment(db, s, accountId, caseId, uploadId, input)
    })
  }
  async recordRestoreHistoryProof(
    tenantId: string,
    accountId: string,
    caseId: string,
    uploadId: string,
    input: unknown
  ): ReturnType<typeof recordRestoreHistoryProof> {
    accountId = Id.parse(accountId)
    caseId = z.uuid().parse(caseId).toLowerCase()
    uploadId = z.uuid().parse(uploadId).toLowerCase()
    return this.operate(tenantId, async (db, s) => {
      await this.account(db, s, accountId)
      return recordRestoreHistoryProof(db, s, accountId, caseId, uploadId, input)
    })
  }
  async restoreCompletionAudit(
    tenantId: string,
    accountId: string
  ): ReturnType<typeof readRestoreCompletionAudit> {
    accountId = Id.parse(accountId)
    return this.operate(tenantId, async (db, s) => {
      await this.account(db, s, accountId)
      return readRestoreCompletionAudit(db, s, accountId)
    })
  }
  async previewRestoreRecovery(
    tenantId: string,
    accountId: string,
    caseId: string,
    uploadId: string,
    reviewId: string
  ): ReturnType<typeof previewRestoreRecovery> {
    accountId = Id.parse(accountId)
    caseId = z.uuid().parse(caseId).toLowerCase()
    uploadId = z.uuid().parse(uploadId).toLowerCase()
    reviewId = z.uuid().parse(reviewId).toLowerCase()
    return this.operate(tenantId, async (db, s) => {
      await this.account(db, s, accountId)
      return previewRestoreRecovery(db, s, accountId, caseId, uploadId, reviewId)
    })
  }
  async restoreRecoveryAuthorization(
    tenantId: string,
    accountId: string,
    caseId: string,
    authorizationId: string
  ): ReturnType<typeof readRestoreRecoveryAuthorization> {
    accountId = Id.parse(accountId)
    caseId = z.uuid().parse(caseId).toLowerCase()
    authorizationId = z.uuid().parse(authorizationId).toLowerCase()
    return this.operate(tenantId, async (db, s) => {
      await this.account(db, s, accountId)
      return readRestoreRecoveryAuthorization(db, s, accountId, caseId, authorizationId)
    })
  }
  async restoreResolutionBasis(
    tenantId: string,
    accountId: string,
    caseId: string,
    reviewId: string
  ): ReturnType<typeof readRestoreResolutionBasis> {
    accountId = Id.parse(accountId)
    caseId = z.uuid().parse(caseId).toLowerCase()
    reviewId = z.uuid().parse(reviewId).toLowerCase()
    return this.operate(tenantId, async (db, s) => {
      await this.account(db, s, accountId)
      const evidence = await readVerifiedRestoreExecutionReview(db, s, accountId, caseId, reviewId)
      if (evidence.record.current.state !== 'current')
        throw new RestoreResolutionError('RESTORE_RESOLUTION_NOT_READY')
      const assessment = await readCompleteRestoreAssessment(
        db,
        s,
        accountId,
        caseId,
        evidence.input.uploadId
      )
      const now = Number(
        (await db.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now'))
          .rows[0].now
      )
      return readRestoreResolutionBasis(db, s, assessment, evidence.input, evidence.history, now)
    })
  }
  async restoreExecutionReview(
    tenantId: string,
    accountId: string,
    caseId: string,
    reviewId: string
  ): ReturnType<typeof readRestoreExecutionReview> {
    accountId = Id.parse(accountId)
    caseId = z.uuid().parse(caseId).toLowerCase()
    reviewId = z.uuid().parse(reviewId).toLowerCase()
    return this.operate(tenantId, async (db, s) => {
      await this.account(db, s, accountId)
      return readRestoreExecutionReview(db, s, accountId, caseId, reviewId)
    })
  }
  async restoreHistoryProof(
    tenantId: string,
    accountId: string,
    caseId: string,
    proofId: string
  ): ReturnType<typeof readRestoreHistoryProof> {
    accountId = Id.parse(accountId)
    caseId = z.uuid().parse(caseId).toLowerCase()
    proofId = z.uuid().parse(proofId).toLowerCase()
    return this.operate(tenantId, async (db, s) => {
      await this.account(db, s, accountId)
      return readRestoreHistoryProof(db, s, accountId, caseId, proofId)
    })
  }
  async recordRestoreEvidence(
    tenantId: string,
    accountId: string,
    caseId: string,
    uploadId: string,
    input: unknown
  ): ReturnType<typeof recordRestoreEvidence> {
    accountId = Id.parse(accountId)
    caseId = z.uuid().parse(caseId).toLowerCase()
    uploadId = z.uuid().parse(uploadId).toLowerCase()
    return this.operate(tenantId, async (db, s) => {
      await this.account(db, s, accountId)
      return recordRestoreEvidence(db, s, accountId, caseId, uploadId, input)
    })
  }
  async restoreEvidence(
    tenantId: string,
    accountId: string,
    caseId: string,
    uploadId: string,
    input: unknown = {}
  ): ReturnType<typeof readRestoreEvidence> {
    accountId = Id.parse(accountId)
    caseId = z.uuid().parse(caseId).toLowerCase()
    uploadId = z.uuid().parse(uploadId).toLowerCase()
    return this.operate(tenantId, async (db, s) => {
      await this.account(db, s, accountId)
      return readRestoreEvidence(db, s, accountId, caseId, uploadId, input)
    })
  }
  async restorePermitAudit(
    tenantId: string,
    accountId: string,
    caseId: string,
    input: unknown = {}
  ): Promise<RestorePermitAudit> {
    accountId = Id.parse(accountId)
    caseId = z.uuid().parse(caseId)
    return this.operate(tenantId, async (db, s) => {
      await this.account(db, s, accountId)
      return readRestorePermitAudit(db, s, accountId, caseId, input)
    })
  }
  async restorePauseReport(
    tenantId: string,
    accountId: string,
    caseId: string,
    challengeId: string
  ): Promise<RestorePauseDetail> {
    accountId = Id.parse(accountId)
    caseId = z.uuid().parse(caseId)
    challengeId = z.uuid().parse(challengeId)
    return this.operate(tenantId, async (db, s) => {
      await this.account(db, s, accountId)
      return readRestorePauseDetail(db, s, accountId, caseId, challengeId)
    })
  }
  private async readReconciliationCase(
    db: PoolClient,
    s: AdminScope,
    accountId: string,
    caseId: string
  ): Promise<ReconciliationCase> {
    const result = await db.query(
      `SELECT c.*,(SELECT count(*) FROM reconciliation_notes n
       WHERE (n.tenant_id,n.account_id,n.case_id)=(c.tenant_id,c.account_id,c.id)) AS note_count
       FROM reconciliation_cases c WHERE c.tenant_id=$1 AND c.account_id=$2 AND c.id=$3`,
      [s.tenant_id, accountId, caseId]
    )
    const row = result.rows[0]
    if (!row) throw new AdminError('RECONCILIATION_NOT_FOUND')
    const snapshot = ReconciliationSnapshotSchema.parse(row.snapshot_json)
    if (
      snapshot.tenantId !== s.tenant_id ||
      snapshot.accountId !== accountId ||
      snapshot.permitId !== row.permit_id ||
      hashContext(snapshot) !== row.snapshot_hash
    )
      throw new AdminError('RECONCILIATION_CONFLICT')
    return {
      caseId: row.id,
      snapshotHash: row.snapshot_hash,
      snapshot,
      openedBy: row.opened_by,
      openedAt: new Date(row.opened_at).getTime(),
      noteCount: Number(row.note_count),
      devicePauseAcknowledged: null
    }
  }

  private validateGenerator(p: Publication): void {
    if (!this.expectedGeneratorVersion) throw new AdminError('CONFIGURATION_UNAVAILABLE')
    if (p.textGeneratorVersion !== this.expectedGeneratorVersion)
      throw new AdminError('PUBLICATION_INVALID')
  }
  private async account(
    db: PoolClient,
    s: AdminScope,
    accountId: string
  ): Promise<{ employee_id: string; platform: string; enabled: boolean }> {
    const account = await db.query(
      'SELECT employee_id,platform,enabled FROM accounts WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
      [s.tenant_id, accountId]
    )
    if (!account.rows[0]) throw new AdminError('ACCOUNT_NOT_FOUND')
    return account.rows[0]
  }
  private async enabledEmployee(db: PoolClient, s: AdminScope, employeeId: string): Promise<void> {
    const employee = await db.query(
      'SELECT enabled FROM employees WHERE tenant_id=$1 AND id=$2 FOR SHARE',
      [s.tenant_id, employeeId]
    )
    if (!employee.rows[0]?.enabled) throw new AdminError('ACCOUNT_CONFLICT')
  }
  private async operate<T>(
    tenantId: string,
    operation: (db: PoolClient, s: AdminScope) => Promise<T>
  ): Promise<T> {
    tenantId = Id.parse(tenantId)
    return this.db.transaction(tenantId, async (db) => {
      let authenticated
      try {
        authenticated = await db.query('SELECT * FROM autoreply.authenticate_admin($1)', [tenantId])
      } catch {
        throw new AdminError('DENIED')
      }
      const s = Scope.safeParse(authenticated.rows[0])
      if (!s.success || s.data.tenant_id !== tenantId) throw new AdminError('DENIED')
      return operation(db, s.data)
    })
  }
  private async audit(
    db: PoolClient,
    s: AdminScope,
    accountId: string,
    kind: string,
    details: Record<string, unknown>
  ): Promise<void> {
    await db.query(
      'INSERT INTO audit_events(tenant_id,id,actor_id,kind,account_id,details_json) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
      [s.tenant_id, randomUUID(), s.actor_id, kind, accountId, JSON.stringify(details)]
    )
  }
}
