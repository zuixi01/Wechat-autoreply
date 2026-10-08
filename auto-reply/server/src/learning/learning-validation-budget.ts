import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { PoolClient } from 'pg'
import type { Postgres } from '../database/postgres'
import type { Scope } from '../auth/account-authority'
import {
  ReviewUsageSchema,
  type MemoryScope,
  type ReviewUsage
} from '../../../src/shared/contracts/learning-memory'
import {
  LearningReviewFailure,
  type LearningReviewTransport
} from '../../../src/core/memory/learning-reviewer'
import { estimateMemoryTokens } from '../../../src/core/memory/learning-retrieval'
import { learningHash } from '../../../src/core/memory/learning-scope'
import { enterpriseMemoryScope } from './learning-repository'
import {
  effectiveLearningSettings,
  withLearningAccount,
  type LearningAccountAuthority
} from './learning-account'
import {
  learningForegroundWithin,
  learningUsageWithin,
  expireLearningLeaseWithin
} from './learning-background'
import { recordedTransport } from '../generation/model-call-transport'
import { LearningOperationDrain } from '../../../src/core/memory/learning-operation-drain'

export interface EnterpriseValidationRun {
  id: string
  claimToken: string
  scope: MemoryScope
  leaseUntil: number
  timeoutMs: number
}
export interface EnterpriseValidationCall {
  id: string
  /** Accounting only: retains no reference credential or ability to issue/activate memory. */
  settleUsage(usage?: ReviewUsage): Promise<boolean>
}
const Identifier = z.string().trim().min(1).max(128)
type Row = Record<string, unknown>
export type EnterpriseValidationAdmissionGuard = (
  db: PoolClient,
  scope: Scope,
  at: number
) => Promise<void>
/** One durable account slot and the same fee ledger as reviews. No network request holds a transaction. */
export class EnterpriseLearningValidationBudget {
  private readonly operations = new LearningOperationDrain()
  trackRequest<T>(work: Promise<T>): Promise<T> {
    return this.operations.track(work)
  }
  drain(): Promise<void> {
    return this.operations.drain()
  }
  constructor(
    private readonly database: Postgres,
    private readonly authority: LearningAccountAuthority,
    private readonly options: { now?: () => number } = {}
  ) {}
  private locked<T>(
    reference: string,
    conversation: string | null,
    operation: (db: PoolClient, scope: Scope, conversation: string, at: number) => Promise<T>
  ): Promise<T> {
    return withLearningAccount(this.authority, reference, conversation, operation, this.options.now)
  }
  async begin(
    reference: string,
    conversationId: string | null,
    sourceId: string,
    workerId: string,
    expectedCalls = 12,
    purpose: 'validation' | 'curation' | 'evaluation' = 'validation'
  ): Promise<EnterpriseValidationRun> {
    Identifier.parse(sourceId)
    Identifier.parse(workerId)
    z.enum(['validation', 'curation', 'evaluation']).parse(purpose)
    // Three arms each have pre-decision, text and audit. Evaluation supports the 200-case
    // holdout floor in one frozen lease; existing calibration limits and token caps stay intact.
    z.number()
      .int()
      .min(1)
      .max(purpose === 'evaluation' ? 18000 : 1201)
      .parse(expectedCalls)
    return this.locked(reference, conversationId, async (db, scope, conversation, at) => {
      const settings = await effectiveLearningSettings(db, scope, conversation)
      if (settings.mode === 'off') throw new Error('learning_disabled')
      const account = [scope.tenant_id, scope.account_id]
      if (
        (await db.query('SELECT paused FROM accounts WHERE tenant_id=$1 AND id=$2', account))
          .rows[0]?.paused
      )
        throw new Error('account_paused')
      const foreground = await learningForegroundWithin(db, scope)
      if (foreground.running || at < foreground.at + settings.idleDelayMs)
        throw new Error('learning_not_idle')
      const lease = (
        await db.query(
          'SELECT claim_token,lease_until FROM learning_background_leases WHERE tenant_id=$1 AND account_id=$2',
          account
        )
      ).rows[0]
      if (lease && Number(lease.lease_until) > at) throw new Error('learning_background_busy')
      if (lease) {
        await expireLearningLeaseWithin(db, scope, String(lease.claim_token), at)
        await db.query(
          'DELETE FROM learning_background_leases WHERE tenant_id=$1 AND account_id=$2',
          account
        )
      }
      if (
        (
          await db.query(
            "SELECT 1 FROM learning_tombstones WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3 AND kind='validation_run' AND fingerprint=$4",
            [...account, conversation, learningHash(sourceId)]
          )
        ).rowCount
      )
        throw new Error('validation_run_forgotten')
      const previous = (
        await db.query(
          purpose === 'evaluation'
            ? 'SELECT r.state,r.finished_at,c.run_id AS checkpoint_id,COALESCE(c.attempt_count,1) AS attempts FROM learning_validation_runs r LEFT JOIN learning_evaluation_checkpoints c ON (c.tenant_id,c.account_id,c.run_id)=(r.tenant_id,r.account_id,r.id) WHERE r.tenant_id=$1 AND r.account_id=$2 AND r.conversation_id=$3 AND r.source_id=$4 ORDER BY r.created_at DESC,r.id DESC'
            : 'SELECT state,finished_at FROM learning_validation_runs WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3 AND source_id=$4 ORDER BY created_at DESC,id DESC',
          [...account, conversation, sourceId]
        )
      ).rows
      const attempts = previous.reduce((n, r) => n + Number(r.attempts ?? 1), 0)
      if (attempts >= settings.maxAttempts) throw new Error('attempt_limit')
      if (purpose === 'evaluation' && previous.some((r) => r.checkpoint_id))
        throw new Error('evaluation_resume_required')
      if (
        previous[0]?.finished_at !== null &&
        previous[0]?.finished_at !== undefined &&
        previous[0].state !== 'completed' &&
        at < Number(previous[0].finished_at) + Math.min(60000, 5000 * 2 ** (attempts - 1))
      )
        throw new Error('validation_retry_not_ready')
      const run: EnterpriseValidationRun = {
        id: randomUUID(),
        claimToken: randomUUID(),
        scope: enterpriseMemoryScope(scope, conversation || null),
        leaseUntil: at + settings.reviewTimeoutMs + 5000,
        timeoutMs: settings.reviewTimeoutMs
      }
      await db.query(
        "INSERT INTO learning_validation_runs(tenant_id,account_id,conversation_id,id,claim_token,source_id,worker_id,state,lease_until,created_at,foreground_revision,purpose) VALUES($1,$2,$3,$4,$5,$6,$7,'running',$8,$9,$10,$11)",
        [
          ...account,
          conversation,
          run.id,
          run.claimToken,
          sourceId,
          workerId,
          run.leaseUntil,
          at,
          foreground.revision,
          purpose
        ]
      )
      await db.query('INSERT INTO learning_background_leases VALUES($1,$2,$3,$5,$4)', [
        ...account,
        run.claimToken,
        run.leaseUntil,
        purpose
      ])
      return run
    })
  }

  /** Existing immutable evaluation only. The checkpoint owns retry counts and frozen guards. */
  async reclaimEvaluationWithin(
    db: PoolClient,
    scope: Scope,
    id: string,
    workerId: string,
    at: number
  ): Promise<EnterpriseValidationRun> {
    Identifier.parse(workerId)
    const keys = [scope.tenant_id, scope.account_id]
    const row = (
      await db.query(
        'SELECT * FROM learning_validation_runs WHERE tenant_id=$1 AND account_id=$2 AND id=$3',
        [...keys, z.uuid().parse(id)]
      )
    ).rows[0]
    if (
      !row ||
      row.purpose !== 'evaluation' ||
      row.state === 'completed' ||
      row.conversation_id !== ''
    )
      throw new Error('evaluation_checkpoint_unavailable')
    const settings = await effectiveLearningSettings(db, scope, '')
    if (settings.mode === 'off') throw new Error('learning_disabled')
    if (
      (await db.query('SELECT paused FROM accounts WHERE tenant_id=$1 AND id=$2', keys)).rows[0]
        ?.paused
    )
      throw new Error('account_paused')
    const foreground = await learningForegroundWithin(db, scope)
    if (foreground.running || at < foreground.at + settings.idleDelayMs)
      throw new Error('learning_not_idle')
    const lease = (
      await db.query(
        'SELECT claim_token,lease_until FROM learning_background_leases WHERE tenant_id=$1 AND account_id=$2',
        keys
      )
    ).rows[0]
    if (lease && Number(lease.lease_until) > at) throw new Error('learning_background_busy')
    if (row.state === 'running' && Number(row.lease_until) > at)
      throw new Error('learning_background_busy')
    if (lease) {
      await expireLearningLeaseWithin(db, scope, String(lease.claim_token), at)
      await db.query(
        'DELETE FROM learning_background_leases WHERE tenant_id=$1 AND account_id=$2',
        keys
      )
    }
    if (
      (
        await db.query(
          "SELECT 1 FROM learning_tombstones WHERE tenant_id=$1 AND account_id=$2 AND conversation_id='' AND kind='validation_run' AND fingerprint=$3",
          [...keys, learningHash(String(row.source_id))]
        )
      ).rowCount
    )
      throw new Error('validation_run_forgotten')
    const run: EnterpriseValidationRun = {
      id,
      claimToken: randomUUID(),
      scope: enterpriseMemoryScope(scope, null),
      leaseUntil: at + settings.reviewTimeoutMs + 5000,
      timeoutMs: settings.reviewTimeoutMs
    }
    await db.query(
      "UPDATE learning_validation_runs SET claim_token=$4,worker_id=$5,state='running',lease_until=$6,foreground_revision=$7,finished_at=NULL WHERE tenant_id=$1 AND account_id=$2 AND id=$3",
      [...keys, id, run.claimToken, workerId, run.leaseUntil, foreground.revision]
    )
    await db.query("INSERT INTO learning_background_leases VALUES($1,$2,$3,'evaluation',$4)", [
      ...keys,
      run.claimToken,
      run.leaseUntil
    ])
    return run
  }
  async assertCurrentWithin(
    db: PoolClient,
    scope: Scope,
    run: EnterpriseValidationRun,
    at: number
  ): Promise<Row> {
    const row = (
      await db.query(
        `SELECT r.*,l.claim_token AS lease_token,l.lease_until AS active_lease_until FROM learning_validation_runs r
      LEFT JOIN learning_background_leases l ON (l.tenant_id,l.account_id)=(r.tenant_id,r.account_id)
      WHERE r.tenant_id=$1 AND r.account_id=$2 AND r.id=$3`,
        [scope.tenant_id, scope.account_id, z.uuid().parse(run.id)]
      )
    ).rows[0]
    if (
      !row ||
      row.state !== 'running' ||
      row.claim_token !== run.claimToken ||
      row.lease_token !== run.claimToken ||
      Number(row.lease_until) <= at ||
      Number(row.active_lease_until) <= at ||
      learningHash(enterpriseMemoryScope(scope, String(row.conversation_id) || null)) !==
        learningHash(run.scope)
    )
      throw new Error('validation_run_expired')
    const settings = await effectiveLearningSettings(db, scope, String(row.conversation_id))
    if (settings.mode === 'off') throw new Error('learning_disabled')
    if (
      (
        await db.query('SELECT paused FROM accounts WHERE tenant_id=$1 AND id=$2', [
          scope.tenant_id,
          scope.account_id
        ])
      ).rows[0]?.paused
    )
      throw new Error('account_paused')
    const foreground = await learningForegroundWithin(db, scope)
    if (foreground.running || foreground.revision !== Number(row.foreground_revision))
      throw new Error('learning_foreground_preempted')
    return row
  }
  assertCurrent(reference: string, run: EnterpriseValidationRun): Promise<void> {
    return this.locked(reference, null, async (db, scope, _conversation, at) => {
      await this.assertCurrentWithin(db, scope, run, at)
    })
  }
  async reserve(
    reference: string,
    run: EnterpriseValidationRun,
    inputLimit: number,
    outputLimit: number,
    guard?: EnterpriseValidationAdmissionGuard
  ): Promise<EnterpriseValidationCall> {
    z.number().int().min(1).max(16000).parse(inputLimit)
    z.number().int().min(1).max(2000).parse(outputLimit)
    return this.locked(reference, null, async (db, scope, _conversation, at) => {
      const row = await this.assertCurrentWithin(db, scope, run, at)
      await guard?.(db, scope, at)
      const conversation = String(row.conversation_id),
        settings = await effectiveLearningSettings(db, scope, conversation),
        parent = await effectiveLearningSettings(db, scope, '')
      if (inputLimit > settings.maxReviewInputTokens)
        throw new Error('validation_input_over_budget')
      const reserved = inputLimit + outputLimit
      if (
        (await learningUsageWithin(db, scope, at)).reservedTokens + reserved >
        Math.min(settings.dailyReviewTokenBudget, parent.dailyReviewTokenBudget)
      )
        throw new Error('validation_budget_exhausted')
      // Renew only after admission. A crashed process cannot hold an entire large dataset's horizon.
      const renewedUntil = at + run.timeoutMs + 5000
      await db.query(
        'UPDATE learning_validation_runs SET lease_until=$5 WHERE tenant_id=$1 AND account_id=$2 AND id=$3 AND claim_token=$4',
        [scope.tenant_id, scope.account_id, run.id, run.claimToken, renewedUntil]
      )
      await db.query(
        'UPDATE learning_background_leases SET lease_until=$4 WHERE tenant_id=$1 AND account_id=$2 AND claim_token=$3',
        [scope.tenant_id, scope.account_id, run.claimToken, renewedUntil]
      )
      const token = randomUUID()
      await db.query(
        `INSERT INTO learning_attempts(tenant_id,account_id,conversation_id,claim_token,worker_id,purpose,day,reserved_tokens,charged_tokens,state,created_at,foreground_revision,validation_run_id)
        VALUES($1,$2,$3,$4,$5,$11,$6::date,$7,$7,'running',$8,$9,$10)`,
        [
          scope.tenant_id,
          scope.account_id,
          conversation,
          token,
          row.worker_id,
          new Date(at).toISOString().slice(0, 10),
          reserved,
          at,
          row.foreground_revision,
          run.id,
          row.purpose
        ]
      )
      const captured = { scope: structuredClone(scope), token, runId: run.id }
      return { id: token, settleUsage: (usage) => this.settle(captured, usage) }
    })
  }
  private async settle(
    captured: { scope: Scope; token: string; runId: string },
    raw?: ReviewUsage
  ): Promise<boolean> {
    const usage = raw ? ReviewUsageSchema.parse(raw) : undefined
    const { scope, token, runId } = captured
    return this.database.transaction(scope.tenant_id, async (db) => {
      await db.query("SELECT set_config('app.learning_account_id',$1,true)", [scope.account_id])
      await db.query('SELECT 1 FROM accounts WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [
        scope.tenant_id,
        scope.account_id
      ])
      const row = (
        await db.query(
          'SELECT * FROM learning_attempts WHERE tenant_id=$1 AND account_id=$2 AND claim_token=$3 AND validation_run_id=$4',
          [scope.tenant_id, scope.account_id, token, runId]
        )
      ).rows[0]
      if (!row) return false
      if (row.measurement === 'not_dispatched') {
        if (usage && (usage.inputTokens !== 0 || usage.outputTokens !== 0))
          throw new Error('learning_usage_conflict')
        return true
      }
      if (row.measurement === 'reported') {
        if (
          usage &&
          (usage.measurement === 'upper_bound' ||
            Number(row.input_tokens) !== usage.inputTokens ||
            Number(row.output_tokens) !== usage.outputTokens)
        )
          throw new Error('learning_usage_conflict')
        return true
      }
      const measurement = usage?.measurement ?? (usage ? 'reported' : 'upper_bound')
      const charge =
        measurement === 'upper_bound'
          ? Number(row.reserved_tokens)
          : (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)
      await db.query(
        `UPDATE learning_attempts SET charged_tokens=$4,input_tokens=$5,output_tokens=$6,measurement=$7,
        state=CASE WHEN state='running' THEN 'completed' ELSE state END WHERE tenant_id=$1 AND account_id=$2 AND claim_token=$3`,
        [
          scope.tenant_id,
          scope.account_id,
          token,
          charge,
          usage?.inputTokens ?? 0,
          usage?.outputTokens ?? 0,
          measurement
        ]
      )
      return true
    })
  }
  end(
    reference: string,
    run: EnterpriseValidationRun,
    state: 'completed' | 'failed' | 'cancelled'
  ): Promise<void> {
    return this.locked(reference, null, async (db, scope, _conversation, at) => {
      const result = await db.query(
        "UPDATE learning_validation_runs SET state=$5,finished_at=$6 WHERE tenant_id=$1 AND account_id=$2 AND id=$3 AND claim_token=$4 AND state='running' RETURNING id",
        [scope.tenant_id, scope.account_id, run.id, run.claimToken, state, at]
      )
      if (!result.rowCount) return
      await db.query(
        "UPDATE learning_attempts SET state=$4 WHERE tenant_id=$1 AND account_id=$2 AND validation_run_id=$3 AND state='running'",
        [scope.tenant_id, scope.account_id, run.id, state]
      )
      await db.query(
        'DELETE FROM learning_background_leases WHERE tenant_id=$1 AND account_id=$2 AND claim_token=$3',
        [scope.tenant_id, scope.account_id, run.claimToken]
      )
    })
  }
}

/** Reserve before HTTP, race cancellation even for a noncooperative provider, retain late fee receipt. */
export class EnterpriseBudgetedValidationTransport implements LearningReviewTransport {
  constructor(
    private readonly budget: EnterpriseLearningValidationBudget,
    private readonly reference: string,
    private readonly run: EnterpriseValidationRun,
    private readonly upstream: LearningReviewTransport
  ) {}
  async complete(
    request: Parameters<LearningReviewTransport['complete']>[0],
    signal: AbortSignal
  ): ReturnType<LearningReviewTransport['complete']> {
    if (signal.aborted) throw new Error('validation_cancelled')
    const inputLimit = estimateMemoryTokens(request.system + request.user) + 512
    if (inputLimit > (request.maxInputTokens ?? 8000))
      throw new Error('validation_input_over_budget')
    const call = await this.budget.reserve(
      this.reference,
      this.run,
      inputLimit,
      request.maxOutputTokens
    )
    const settle = async (usage?: ReviewUsage): Promise<void> => {
      try {
        await call.settleUsage(usage)
      } catch {
        /* No content write, including after forgetting. */
      }
    }
    const controller = new AbortController(),
      effective = AbortSignal.any([signal, controller.signal])
    let onAbort: (() => void) | undefined
    const timeout = setTimeout(
      () => controller.abort('validation_request_timeout'),
      this.run.timeoutMs
    )
    let dispatched = false
    try {
      if (effective.aborted) {
        await settle({ inputTokens: 0, outputTokens: 0, measurement: 'not_dispatched' })
        throw new Error('validation_cancelled')
      }
      await this.budget.assertCurrent(this.reference, this.run)
      if (effective.aborted) {
        await settle({ inputTokens: 0, outputTokens: 0, measurement: 'not_dispatched' })
        throw new Error('validation_cancelled')
      }
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new Error('validation_cancelled'))
        effective.addEventListener('abort', onAbort, { once: true })
      })
      dispatched = true
      const network = this.budget.trackRequest(
        this.upstream.complete(request, effective).then(
          async (result) => {
            await settle(result.usage ? { ...result.usage, measurement: 'reported' } : undefined)
            return result
          },
          async (error) => {
            await settle(error instanceof LearningReviewFailure ? error.usage : undefined)
            throw error
          }
        )
      )
      const result = await Promise.race([network, aborted])
      if (effective.aborted) throw new Error('validation_cancelled')
      await settle(result.usage ? { ...result.usage, measurement: 'reported' } : undefined)
      if (
        result.usage &&
        (result.usage.inputTokens > inputLimit ||
          result.usage.outputTokens > request.maxOutputTokens)
      )
        throw new Error('learning_usage_over_budget')
      await this.budget.assertCurrent(this.reference, this.run)
      return result
    } catch (error) {
      await settle(
        dispatched
          ? error instanceof LearningReviewFailure
            ? error.usage
            : undefined
          : { inputTokens: 0, outputTokens: 0, measurement: 'not_dispatched' }
      )
      throw error
    } finally {
      clearTimeout(timeout)
      if (onAbort) effective.removeEventListener('abort', onAbort)
    }
  }
}

/** Reuse production HTTP parsing and model checks for paired text/Jev replay. */
export function createEnterpriseValidationFetch(
  provider: 'text' | 'jev',
  budget: EnterpriseLearningValidationBudget,
  reference: string,
  run: EnterpriseValidationRun,
  upstream: typeof fetch = fetch,
  expectedTextModel?: string,
  guard?: EnterpriseValidationAdmissionGuard,
  onBudgetExhausted?: () => void
): typeof fetch {
  return async (url, init) => {
    if (init?.method !== 'POST' || typeof init.body !== 'string')
      throw new Error('validation_request_invalid')
    if (init.signal?.aborted) throw new Error('validation_cancelled')
    const raw = JSON.parse(init.body) as Record<string, unknown>
    const outputLimit = 2000
    if (provider === 'text') {
      if (
        raw.max_tokens !== undefined &&
        (!Number.isInteger(raw.max_tokens) ||
          Number(raw.max_tokens) < 1 ||
          Number(raw.max_tokens) > outputLimit)
      )
        throw new Error('validation_output_over_budget')
      raw.max_tokens ??= outputLimit
    }
    const body = JSON.stringify(raw),
      inputLimit = estimateMemoryTokens(body) + 512
    const controller = new AbortController(),
      signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal
    const timeout = setTimeout(() => controller.abort('model_timeout'), run.timeoutMs)
    let receipt: EnterpriseValidationCall | undefined,
      dispatched = false
    const measured = recordedTransport(
      provider,
      async () => {
        try {
          receipt = await budget.reserve(reference, run, inputLimit, outputLimit, guard)
        } catch (error) {
          if (error instanceof Error && error.message === 'validation_budget_exhausted')
            onBudgetExhausted?.()
          throw error
        }
        await budget.assertCurrent(reference, run)
        return {
          finish: async (result) => {
            await receipt!.settleUsage(
              result.usage
                ? { ...result.usage, measurement: 'reported' }
                : result.outcome === 'not_dispatched'
                  ? { inputTokens: 0, outputTokens: 0, measurement: 'not_dispatched' }
                  : undefined
            )
            if (
              result.usage &&
              (result.usage.inputTokens > inputLimit || result.usage.outputTokens > outputLimit)
            )
              throw new Error('learning_usage_over_budget')
          }
        }
      },
      async (request, options) => {
        dispatched = true
        return budget.trackRequest(upstream(request, options))
      },
      expectedTextModel
    )
    try {
      const response = await budget.trackRequest(
        measured(url, { ...init, body, signal, redirect: 'manual' })
      )
      await budget.assertCurrent(reference, run)
      return response
    } catch (error) {
      if (receipt && !dispatched)
        await receipt.settleUsage({
          inputTokens: 0,
          outputTokens: 0,
          measurement: 'not_dispatched'
        })
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }
}
