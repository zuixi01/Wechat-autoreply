import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import {
  MemoryScopeSchema,
  ReviewUsageSchema,
  type MemoryScope,
  type ReviewUsage
} from '../../shared/contracts/learning-memory'
import type { LearningStore } from './learning-store'
import { LearningReviewFailure, type LearningReviewTransport } from './learning-reviewer'
import { accountMemoryScope, learningHash, memoryScopeKey } from './learning-scope'
import { estimateMemoryTokens } from './learning-retrieval'
import { LearningOperationDrain } from './learning-operation-drain'

type Transaction = <T>(work: () => T) => T
export interface ValidationRunClaim {
  id: string
  token: string
  scope: MemoryScope
  leaseUntil: number
}
interface ValidationCall {
  id: string
  runId: string
  scope: MemoryScope
  inputLimit: number
  outputLimit: number
}
const Identifier = z.string().trim().min(1).max(128)

/** Shared durable lock and accounting for risk checks and calibration HTTP calls. */
export class LearningValidationBudget {
  private readonly operations = new LearningOperationDrain()
  trackRequest<T>(work: Promise<T>): Promise<T> {
    return this.operations.track(work)
  }
  drain(): Promise<void> {
    return this.operations.drain()
  }
  constructor(
    private readonly db: DatabaseSync,
    private readonly transaction: Transaction,
    private readonly store: LearningStore,
    private readonly now: () => number
  ) {}
  begin(rawScope: MemoryScope, sourceId: string): ValidationRunClaim {
    const scope = MemoryScopeSchema.parse(rawScope),
      key = memoryScopeKey(scope)
    Identifier.parse(sourceId)
    return this.transaction(() => {
      const now = this.now(),
        settings = this.store.settings(scope)
      if (settings.mode === 'off') throw new Error('learning_disabled')
      this.db
        .prepare(
          "UPDATE learning_validation_attempts SET state='expired',measurement=CASE WHEN measurement='reported' THEN measurement ELSE 'upper_bound' END WHERE state='running' AND run_id IN (SELECT id FROM learning_validation_runs WHERE state='running' AND lease_until<=?)"
        )
        .run(now)
      this.db
        .prepare(
          "UPDATE learning_validation_runs SET state='expired' WHERE state='running' AND lease_until<=?"
        )
        .run(now)
      if (
        this.db
          .prepare("SELECT 1 FROM learning_jobs WHERE state='running' AND lease_until>? LIMIT 1")
          .get(now) ||
        this.db
          .prepare(
            "SELECT 1 FROM learning_validation_runs WHERE state='running' AND lease_until>? LIMIT 1"
          )
          .get(now)
      )
        throw new Error('learning_background_busy')
      if (
        this.db
          .prepare(
            "SELECT 1 FROM learning_tombstones WHERE scope_key=? AND kind='validation_run' AND fingerprint=?"
          )
          .get(key, learningHash(sourceId))
      )
        throw new Error('validation_run_forgotten')
      const claim: ValidationRunClaim = {
        id: randomUUID(),
        token: randomUUID(),
        scope,
        leaseUntil: now + settings.reviewTimeoutMs * 12 + 5000
      }
      this.db
        .prepare('INSERT INTO learning_validation_runs VALUES(?,?,?,?,?,?,?)')
        .run(
          claim.id,
          key,
          JSON.stringify(scope),
          sourceId,
          'running',
          claim.leaseUntil,
          claim.token
        )
      return claim
    })
  }
  private assertRun(claim: ValidationRunClaim): void {
    if (
      !this.db
        .prepare(
          "SELECT 1 FROM learning_validation_runs WHERE id=? AND scope_key=? AND token=? AND state='running' AND lease_until>?"
        )
        .get(claim.id, memoryScopeKey(claim.scope), claim.token, this.now())
    )
      throw new Error('validation_run_expired')
    if (this.store.settings(claim.scope).mode === 'off') throw new Error('learning_disabled')
  }
  reserve(
    claim: ValidationRunClaim,
    sourceId: string,
    inputLimit: number,
    outputLimit: number
  ): ValidationCall {
    Identifier.parse(sourceId)
    z.number().int().min(1).max(16000).parse(inputLimit)
    z.number().int().min(1).max(2000).parse(outputLimit)
    return this.transaction(() => {
      this.assertRun(claim)
      const settings = this.store.settings(claim.scope),
        account = this.store.settings(accountMemoryScope(claim.scope))
      if (inputLimit > settings.maxReviewInputTokens)
        throw new Error('validation_input_over_budget')
      const reserved = inputLimit + outputLimit
      if (
        this.store.jobs.usage(claim.scope).reservedTokens + reserved >
        Math.min(settings.dailyReviewTokenBudget, account.dailyReviewTokenBudget)
      )
        throw new Error('validation_budget_exhausted')
      const call: ValidationCall = {
        id: randomUUID(),
        runId: claim.id,
        scope: claim.scope,
        inputLimit,
        outputLimit
      }
      this.db
        .prepare(
          `INSERT INTO learning_validation_attempts(id,run_id,scope_key,source_id,budget_key,day,charged_tokens,state,measurement,input_limit,output_limit)
        VALUES(?,?,?,?,?,?,?,'running','unknown',?,?)`
        )
        .run(
          call.id,
          claim.id,
          memoryScopeKey(claim.scope),
          sourceId,
          memoryScopeKey(accountMemoryScope(claim.scope)),
          new Date(this.now()).toISOString().slice(0, 10),
          reserved,
          inputLimit,
          outputLimit
        )
      return call
    })
  }
  settle(call: ValidationCall, raw?: ReviewUsage): void {
    const usage = raw ? ReviewUsageSchema.parse(raw) : undefined
    this.transaction(() => {
      const prior = this.db
        .prepare(
          'SELECT * FROM learning_validation_attempts WHERE id=? AND run_id=? AND scope_key=?'
        )
        .get(call.id, call.runId, memoryScopeKey(call.scope))
      if (!prior) return
      if (!usage && prior.measurement === 'reported') return
      if (
        prior.measurement === 'reported' &&
        usage &&
        (Number(prior.input_tokens) !== usage.inputTokens ||
          Number(prior.output_tokens) !== usage.outputTokens)
      )
        throw new Error('learning_usage_conflict')
      this.db
        .prepare(
          `UPDATE learning_validation_attempts SET state='completed',measurement=?,charged_tokens=?,input_tokens=?,output_tokens=? WHERE id=?`
        )
        .run(
          usage?.measurement ?? (usage ? 'reported' : 'upper_bound'),
          usage ? usage.inputTokens + usage.outputTokens : Number(prior.charged_tokens),
          usage?.inputTokens ?? null,
          usage?.outputTokens ?? null,
          call.id
        )
    })
  }
  end(claim: ValidationRunClaim, state: 'completed' | 'cancelled' | 'failed'): void {
    this.transaction(() => {
      this.db
        .prepare(
          "UPDATE learning_validation_runs SET state=? WHERE id=? AND token=? AND state='running'"
        )
        .run(state, claim.id, claim.token)
      this.db
        .prepare(
          "UPDATE learning_validation_attempts SET state=?,measurement=CASE WHEN measurement='reported' THEN measurement ELSE 'upper_bound' END WHERE run_id=? AND state='running'"
        )
        .run(state, claim.id)
    })
  }
  forgetScope(scope: MemoryScope): void {
    const key = memoryScopeKey(scope)
    this.db
      .prepare(
        `INSERT INTO learning_retained_usage
      SELECT budget_key,day,SUM(charged_tokens),COALESCE(SUM(input_tokens),0),COALESCE(SUM(output_tokens),0),SUM(CASE WHEN measurement!='not_dispatched' THEN 1 ELSE 0 END),
        SUM(CASE WHEN measurement='upper_bound' THEN 1 ELSE 0 END),SUM(CASE WHEN measurement='reported' THEN 1 ELSE 0 END)
      FROM learning_validation_attempts WHERE scope_key=? GROUP BY budget_key,day
      ON CONFLICT(budget_key,day) DO UPDATE SET charged_tokens=charged_tokens+excluded.charged_tokens,input_tokens=input_tokens+excluded.input_tokens,
        output_tokens=output_tokens+excluded.output_tokens,requests=requests+excluded.requests,estimated_requests=estimated_requests+excluded.estimated_requests,reported_requests=reported_requests+excluded.reported_requests`
      )
      .run(key)
    for (const row of this.db
      .prepare('SELECT source_id FROM learning_validation_runs WHERE scope_key=?')
      .all(key))
      this.db
        .prepare("INSERT OR IGNORE INTO learning_tombstones VALUES(?,'validation_run',?,?)")
        .run(key, learningHash(String(row.source_id)), this.now())
    this.db.prepare('DELETE FROM learning_validation_runs WHERE scope_key=?').run(key)
  }
}

/** The transport wraps every actual HTTP request; parsing failure and cancellation still settle fees. */
export class BudgetedLearningValidationTransport implements LearningReviewTransport {
  constructor(
    private readonly store: LearningStore,
    private readonly run: ValidationRunClaim,
    private readonly transport: LearningReviewTransport
  ) {}
  async complete(
    request: Parameters<LearningReviewTransport['complete']>[0],
    signal: AbortSignal
  ): ReturnType<LearningReviewTransport['complete']> {
    if (signal.aborted) throw new Error('validation_cancelled')
    // The byte bound includes a conservative allowance for role/format framing.
    const inputLimit = estimateMemoryTokens(request.system + request.user) + 512
    const call = this.store.validationBudget.reserve(
      this.run,
      randomUUID(),
      inputLimit,
      request.maxOutputTokens
    )
    const settle = (usage?: ReviewUsage): void => {
      try {
        this.store.validationBudget.settle(call, usage)
      } catch {
        /* Deleted scope accounting remains anonymous. */
      }
    }
    let onAbort: (() => void) | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController(),
      effective = AbortSignal.any([signal, controller.signal])
    try {
      timer = setTimeout(
        () => controller.abort('validation_request_timeout'),
        this.store.settings(this.run.scope).reviewTimeoutMs
      )
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(new Error('validation_cancelled'))
        effective.addEventListener('abort', onAbort, { once: true })
      })
      const network = this.store.validationBudget.trackRequest(
        this.transport.complete(request, effective).then(
          (result) => {
            settle(result.usage ? { ...result.usage, measurement: 'reported' } : undefined)
            return result
          },
          (error) => {
            settle(error instanceof LearningReviewFailure ? error.usage : undefined)
            throw error
          }
        )
      )
      const result = await Promise.race([network, aborted])
      if (effective.aborted) throw new Error('validation_cancelled')
      if (
        result.usage &&
        (result.usage.inputTokens > inputLimit ||
          result.usage.outputTokens > request.maxOutputTokens)
      )
        throw new Error('learning_usage_over_budget')
      return result
    } catch (error) {
      settle(error instanceof LearningReviewFailure ? error.usage : undefined)
      throw error
    } finally {
      if (timer) clearTimeout(timer)
      if (onAbort) effective.removeEventListener('abort', onAbort)
    }
  }
}
