import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  MemoryScopeSchema,
  LearningTriggerSchema,
  ReviewUsageSchema,
  type MemoryScope,
  type LearningJob,
  type ClaimedLearningJob,
  type LearningSettings,
  type LearningTrigger,
  type ReviewUsage
} from '../../shared/contracts/learning-memory'
import { accountMemoryScope, learningHash, memoryScopeKey } from './learning-scope'

type Transaction = <T>(operation: () => T) => T
type Row = Record<string, unknown>
const Id = z.string().trim().min(1).max(128)
export const MAX_REVIEW_OUTPUT_TOKENS = 2000

export class LearningJobs {
  constructor(
    private readonly db: DatabaseSync,
    private readonly transaction: Transaction,
    private readonly settings: (scope: MemoryScope) => LearningSettings,
    private readonly now: () => number
  ) {}
  private job(row: Row): LearningJob {
    return JSON.parse(String(row.payload)) as LearningJob
  }
  private write(job: LearningJob): void {
    this.db
      .prepare(
        `INSERT INTO learning_jobs(id,scope_key,state,available_at,lease_until,payload) VALUES(?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET state=excluded.state,available_at=excluded.available_at,lease_until=excluded.lease_until,payload=excluded.payload`
      )
      .run(
        job.id,
        memoryScopeKey(job.scope),
        job.state,
        job.availableAt,
        job.leaseUntil,
        JSON.stringify(job)
      )
  }
  list(scope: MemoryScope): LearningJob[] {
    return this.db
      .prepare('SELECT payload FROM learning_jobs WHERE scope_key=? ORDER BY available_at,id')
      .all(memoryScopeKey(scope))
      .map((row) => this.job(row))
  }
  enqueue(
    scopeInput: MemoryScope,
    episodeId: string,
    triggerInput: LearningTrigger,
    sourceId: string
  ): LearningJob | null {
    const scope = MemoryScopeSchema.parse(scopeInput),
      trigger = LearningTriggerSchema.parse(triggerInput),
      source = Id.parse(sourceId)
    const key = memoryScopeKey(scope),
      hash = learningHash({ episodeId, trigger })
    return this.transaction(() => {
      if (
        !this.db
          .prepare('SELECT 1 FROM learning_episodes WHERE id=? AND scope_key=?')
          .get(episodeId, key)
      )
        throw new Error('evidence_scope_mismatch')
      const event = this.db
        .prepare('SELECT * FROM learning_job_events WHERE scope_key=? AND source_id=?')
        .get(key, source)
      if (event) {
        if (event.input_hash !== hash) throw new Error('learning_event_conflict')
        const row = this.db
          .prepare('SELECT payload FROM learning_jobs WHERE id=?')
          .get(String(event.job_id))
        return row ? this.job(row) : null
      }
      const settings = this.settings(scope)
      if (settings.mode === 'off') return null
      const candidate = this.db
        .prepare(
          "SELECT payload FROM learning_jobs WHERE scope_key=? AND state='pending' ORDER BY available_at LIMIT 1"
        )
        .get(key)
      let job = candidate ? this.job(candidate) : null
      if (job && job.episodeIds.length >= 20 && !job.episodeIds.includes(episodeId)) job = null
      const at = this.now()
      job ??= {
        id: randomUUID(),
        scope,
        episodeIds: [],
        triggers: [],
        state: 'pending',
        attempts: 0,
        availableAt: at + settings.idleDelayMs,
        createdAt: at,
        updatedAt: at,
        lastError: null,
        leaseUntil: null,
        claimToken: null,
        proposedIds: []
      }
      job.episodeIds = [...new Set([...job.episodeIds, episodeId])]
      job.triggers = [...new Set([...job.triggers, trigger])]
      job.updatedAt = at
      job.availableAt = at + settings.idleDelayMs
      this.write(job)
      this.db
        .prepare('INSERT INTO learning_job_events VALUES(?,?,?,?)')
        .run(key, source, hash, job.id)
      return job
    })
  }
  /** UTC billing day is explicit; requests reserve worst-case tokens before dispatch. */
  private billingDay(): string {
    return new Date(this.now()).toISOString().slice(0, 10)
  }
  usage(scope: MemoryScope): {
    reservedTokens: number
    inputTokens: number
    outputTokens: number
    requests: number
    estimatedRequests: number
    reportedRequests: number
    day: string
  } {
    const day = this.billingDay(),
      key = memoryScopeKey(accountMemoryScope(scope))
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(charged_tokens),0) AS reserved,COALESCE(SUM(input_tokens),0) AS input,
      COALESCE(SUM(output_tokens),0) AS output,SUM(CASE WHEN measurement!='not_dispatched' THEN 1 ELSE 0 END) AS requests,
      SUM(CASE WHEN measurement='upper_bound' THEN 1 ELSE 0 END) AS estimated,
      SUM(CASE WHEN measurement='reported' THEN 1 ELSE 0 END) AS reported
      FROM (SELECT charged_tokens,input_tokens,output_tokens,measurement,budget_key,day FROM learning_review_attempts
        UNION ALL SELECT charged_tokens,input_tokens,output_tokens,measurement,budget_key,day FROM learning_validation_attempts)
      WHERE budget_key=? AND day=?`
      )
      .get(key, day)!
    const retained = this.db
      .prepare('SELECT * FROM learning_retained_usage WHERE budget_key=? AND day=?')
      .get(key, day)
    return {
      reservedTokens: Number(row.reserved) + Number(retained?.charged_tokens ?? 0),
      inputTokens: Number(row.input) + Number(retained?.input_tokens ?? 0),
      outputTokens: Number(row.output) + Number(retained?.output_tokens ?? 0),
      requests: Number(row.requests) + Number(retained?.requests ?? 0),
      estimatedRequests: Number(row.estimated ?? 0) + Number(retained?.estimated_requests ?? 0),
      reportedRequests: Number(row.reported ?? 0) + Number(retained?.reported_requests ?? 0),
      day
    }
  }
  claim(worker: string, foregroundEndedAt?: number): ClaimedLearningJob | null {
    Id.parse(worker)
    return this.transaction(() => {
      const at = this.now()
      if (
        this.db
          .prepare("SELECT 1 FROM learning_jobs WHERE state='running' AND lease_until>? LIMIT 1")
          .get(at)
      )
        return null
      if (
        this.db
          .prepare(
            "SELECT 1 FROM learning_validation_runs WHERE state='running' AND lease_until>? LIMIT 1"
          )
          .get(at)
      )
        return null
      const rows = this.db
        .prepare(
          "SELECT payload FROM learning_jobs WHERE (state IN ('pending','failed') AND available_at<=?) OR (state='running' AND lease_until<=?) ORDER BY available_at,id"
        )
        .all(at, at)
      for (const row of rows) {
        const job = this.job(row),
          settings = this.settings(job.scope)
        if (foregroundEndedAt !== undefined && at < foregroundEndedAt + settings.idleDelayMs)
          continue
        if (settings.mode === 'off') continue
        if (job.attempts >= settings.maxAttempts) {
          job.state = 'cancelled'
          job.lastError = 'attempt_limit'
          job.leaseUntil = null
          job.claimToken = null
          this.write(job)
          continue
        }
        const reserve = settings.maxReviewInputTokens + MAX_REVIEW_OUTPUT_TOKENS
        // Account settings cap all customer queues; a customer may impose an even smaller budget.
        const budget = Math.min(
          settings.dailyReviewTokenBudget,
          this.settings(accountMemoryScope(job.scope)).dailyReviewTokenBudget
        )
        if (this.usage(job.scope).reservedTokens + reserve > budget) continue
        if (job.claimToken)
          this.db
            .prepare(
              "UPDATE learning_review_attempts SET state='timed_out',failure_code='lease_expired',measurement=CASE WHEN measurement='reported' THEN measurement ELSE 'upper_bound' END WHERE claim_token=?"
            )
            .run(job.claimToken)
        const claimToken = randomUUID()
        job.attempts++
        job.state = 'running'
        job.updatedAt = at
        job.leaseUntil = at + settings.reviewTimeoutMs + 5000
        job.claimToken = claimToken
        this.db
          .prepare(
            'INSERT INTO learning_review_attempts(claim_token,job_id,budget_key,day,charged_tokens,state,reserved_tokens) VALUES(?,?,?,?,?,?,?)'
          )
          .run(
            claimToken,
            job.id,
            memoryScopeKey(accountMemoryScope(job.scope)),
            this.billingDay(),
            reserve,
            'running',
            reserve
          )
        this.write(job)
        return { ...job, claimToken, leaseUntil: job.leaseUntil, reservedTokens: reserve }
      }
      return null
    })
  }
  assertClaim(claim: ClaimedLearningJob): LearningJob {
    const row = this.db.prepare('SELECT payload FROM learning_jobs WHERE id=?').get(claim.id)
    const job = row ? this.job(row) : null
    if (
      !job ||
      job.state !== 'running' ||
      job.claimToken !== claim.claimToken ||
      !job.leaseUntil ||
      job.leaseUntil <= this.now() ||
      memoryScopeKey(job.scope) !== memoryScopeKey(claim.scope)
    )
      throw new Error('learning_claim_expired')
    return job
  }
  complete(claim: ClaimedLearningJob, usageInput: ReviewUsage, proposedIds: string[]): void {
    const usage = ReviewUsageSchema.parse(usageInput)
    z.array(Id).max(100).parse(proposedIds)
    this.transaction(() => {
      const job = this.assertClaim(claim)
      const attempt = this.db
        .prepare('SELECT reserved_tokens FROM learning_review_attempts WHERE claim_token=?')
        .get(job.claimToken!)!
      const reserve = Number(attempt.reserved_tokens)
      if (
        usage.inputTokens > reserve - MAX_REVIEW_OUTPUT_TOKENS ||
        usage.outputTokens > MAX_REVIEW_OUTPUT_TOKENS
      )
        throw new Error('learning_usage_over_budget')
      this.db
        .prepare(
          "UPDATE learning_review_attempts SET charged_tokens=?,state='completed',input_tokens=?,output_tokens=?,measurement=? WHERE claim_token=?"
        )
        .run(
          usage.inputTokens + usage.outputTokens,
          usage.inputTokens,
          usage.outputTokens,
          usage.measurement ?? 'reported',
          claim.claimToken
        )
      job.state = 'completed'
      job.updatedAt = this.now()
      job.proposedIds = [...new Set(proposedIds)]
      job.lastError = null
      job.leaseUntil = null
      job.claimToken = null
      this.write(job)
    })
  }
  fail(claim: ClaimedLearningJob, reason: string, usageInput?: ReviewUsage): void {
    z.string().min(1).max(100).parse(reason)
    this.transaction(() => {
      const job = this.assertClaim(claim),
        settings = this.settings(job.scope)
      const usage = usageInput ? ReviewUsageSchema.parse(usageInput) : undefined
      // Reject over-limit proposals in complete(), but never discard a provider's
      // reported consumption while settling the failed attempt.
      const prior = this.db
        .prepare('SELECT measurement FROM learning_review_attempts WHERE claim_token=?')
        .get(claim.claimToken)!
      this.db
        .prepare(
          "UPDATE learning_review_attempts SET state='failed',failure_code=?,measurement=? WHERE claim_token=?"
        )
        .run(
          reason,
          usage?.measurement ??
            (usage ? 'reported' : prior.measurement === 'reported' ? 'reported' : 'upper_bound'),
          claim.claimToken
        )
      if (usage)
        this.db
          .prepare(
            'UPDATE learning_review_attempts SET charged_tokens=?,input_tokens=?,output_tokens=? WHERE claim_token=?'
          )
          .run(
            usage.inputTokens + usage.outputTokens,
            usage.inputTokens,
            usage.outputTokens,
            claim.claimToken
          )
      job.state = job.attempts >= settings.maxAttempts ? 'cancelled' : 'failed'
      job.updatedAt = this.now()
      job.availableAt = this.now() + Math.min(60000, 5000 * 2 ** (job.attempts - 1))
      job.lastError = reason
      job.leaseUntil = null
      job.claimToken = null
      this.write(job)
    })
  }
  /** Accounting-only settlement accepts late reports; it never updates job state or candidates. */
  settleAttemptUsage(claim: ClaimedLearningJob, raw: ReviewUsage): boolean {
    const usage = ReviewUsageSchema.parse(raw)
    if (usage.measurement !== 'reported') return false
    return this.transaction(() => {
      const row = this.db
        .prepare(
          'SELECT * FROM learning_review_attempts WHERE claim_token=? AND job_id=? AND budget_key=?'
        )
        .get(claim.claimToken, claim.id, memoryScopeKey(accountMemoryScope(claim.scope)))
      // Forgotten customer IDs have been replaced by anonymous account/day totals.
      if (!row) return false
      if (
        row.measurement === 'reported' &&
        (Number(row.input_tokens) !== usage.inputTokens ||
          Number(row.output_tokens) !== usage.outputTokens)
      )
        throw new Error('learning_usage_conflict')
      this.db
        .prepare(
          "UPDATE learning_review_attempts SET charged_tokens=?,input_tokens=?,output_tokens=?,measurement='reported' WHERE claim_token=?"
        )
        .run(
          usage.inputTokens + usage.outputTokens,
          usage.inputTokens,
          usage.outputTokens,
          claim.claimToken
        )
      return true
    })
  }
  cancel(scope: MemoryScope, id: string): void {
    this.transaction(() => {
      const row = this.db
        .prepare('SELECT payload FROM learning_jobs WHERE scope_key=? AND id=?')
        .get(memoryScopeKey(scope), id)
      if (!row) throw new Error('learning_job_not_found')
      const job = this.job(row)
      if (job.state === 'completed') return
      if (job.claimToken)
        this.db
          .prepare(
            "UPDATE learning_review_attempts SET state='cancelled',measurement=CASE WHEN measurement='reported' THEN measurement ELSE 'upper_bound' END WHERE claim_token=?"
          )
          .run(job.claimToken)
      job.state = 'cancelled'
      job.updatedAt = this.now()
      job.lastError = 'user_cancelled'
      job.leaseUntil = null
      job.claimToken = null
      this.write(job)
    })
  }
  forgetScope(scope: MemoryScope): void {
    const key = memoryScopeKey(scope)
    // Keep account/day totals without job IDs, customer scope or any customer content.
    this.db
      .prepare(
        `INSERT INTO learning_retained_usage
      SELECT budget_key,day,SUM(charged_tokens),COALESCE(SUM(input_tokens),0),COALESCE(SUM(output_tokens),0),SUM(CASE WHEN measurement!='not_dispatched' THEN 1 ELSE 0 END),
        SUM(CASE WHEN measurement='upper_bound' THEN 1 ELSE 0 END),SUM(CASE WHEN measurement='reported' THEN 1 ELSE 0 END)
      FROM learning_review_attempts WHERE job_id IN (SELECT id FROM learning_jobs WHERE scope_key=?) GROUP BY budget_key,day
      ON CONFLICT(budget_key,day) DO UPDATE SET charged_tokens=charged_tokens+excluded.charged_tokens,
        input_tokens=input_tokens+excluded.input_tokens,output_tokens=output_tokens+excluded.output_tokens,requests=requests+excluded.requests,
        estimated_requests=estimated_requests+excluded.estimated_requests,reported_requests=reported_requests+excluded.reported_requests`
      )
      .run(key)
    this.db
      .prepare(
        'DELETE FROM learning_review_attempts WHERE job_id IN (SELECT id FROM learning_jobs WHERE scope_key=?)'
      )
      .run(key)
    this.db.prepare('DELETE FROM learning_job_events WHERE scope_key=?').run(key)
    this.db.prepare('DELETE FROM learning_jobs WHERE scope_key=?').run(key)
  }
}
