import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { PoolClient } from 'pg'
import type { Postgres } from '../database/postgres'
import type { Scope } from '../auth/account-authority'
import {
  LearningTriggerSchema,
  ReviewUsageSchema,
  type LearningJob,
  type ClaimedLearningJob,
  type LearningTrigger,
  type ReviewUsage
} from '../../../src/shared/contracts/learning-memory'
import { learningHash } from '../../../src/core/memory/learning-scope'
import { MAX_REVIEW_OUTPUT_TOKENS } from '../../../src/core/memory/learning-jobs'
import { enterpriseMemoryScope } from './learning-repository'
import {
  withLearningAccount,
  effectiveLearningSettings,
  recordLearningForegroundWithin,
  type LearningAccountAuthority
} from './learning-account'
import {
  learningForegroundWithin,
  learningUsageWithin,
  expireLearningLeaseWithin
} from './learning-background'

const Id = z.string().trim().min(1).max(128)
type Row = Record<string, unknown>
type Commit = (
  db: PoolClient,
  scope: Scope,
  conversation: string,
  at: number
) => Promise<string[] | void>
export interface EnterpriseLearningClaim extends ClaimedLearningJob {
  /** Host-held, accounting-only receipt. This callback is never serialized to a device or model. */
  settleUsage(usage: ReviewUsage): Promise<boolean>
}
export interface EnterpriseLearningUsage {
  day: string
  reservedTokens: number
  inputTokens: number
  outputTokens: number
  requests: number
  estimatedRequests: number
  reportedRequests: number
}

/** Account row locks serialize claims and worst-case reservations across independent workers. */
export class EnterpriseLearningQueue {
  constructor(
    private readonly db: Postgres,
    private readonly authority: LearningAccountAuthority,
    private readonly options: { now?: () => number } = {}
  ) {}
  private locked<T>(
    credential: string,
    conversation: string | null,
    operation: (db: PoolClient, scope: Scope, conversation: string, at: number) => Promise<T>
  ): Promise<T> {
    return withLearningAccount(
      this.authority,
      credential,
      conversation,
      operation,
      this.options.now
    )
  }
  private keys(scope: Scope, conversation: string): [string, string, string] {
    return [scope.tenant_id, scope.account_id, conversation]
  }
  private job(scope: Scope, row: Row): LearningJob {
    const payload = structuredClone(row.payload) as LearningJob
    return { ...payload, scope: enterpriseMemoryScope(scope, String(row.conversation_id) || null) }
  }
  private async write(
    db: PoolClient,
    scope: Scope,
    conversation: string,
    job: LearningJob
  ): Promise<void> {
    await db.query(
      `INSERT INTO learning_jobs(tenant_id,account_id,conversation_id,id,state,available_at,lease_until,claim_token,payload)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT(tenant_id,account_id,id) DO UPDATE SET
      state=excluded.state,available_at=excluded.available_at,lease_until=excluded.lease_until,claim_token=excluded.claim_token,payload=excluded.payload`,
      [
        ...this.keys(scope, conversation),
        job.id,
        job.state,
        job.availableAt,
        job.leaseUntil,
        job.claimToken,
        JSON.stringify(job)
      ]
    )
  }
  private async foreground(
    db: PoolClient,
    scope: Scope
  ): Promise<{ at: number; revision: number; running: boolean }> {
    return learningForegroundWithin(db, scope)
  }
  recordForegroundActivity(credential: string): Promise<void> {
    return this.locked(credential, null, async (db, scope, _conversation, at) => {
      await recordLearningForegroundWithin(db, scope, at)
    })
  }
  async enqueue(
    credential: string,
    conversationId: string | null,
    episodeId: string,
    triggerInput: LearningTrigger,
    sourceId: string
  ): Promise<LearningJob | null> {
    const trigger = LearningTriggerSchema.parse(triggerInput),
      source = Id.parse(sourceId)
    return this.locked(credential, conversationId, async (db, scope, conversation, at) => {
      const keys = this.keys(scope, conversation),
        settings = await effectiveLearningSettings(db, scope, conversation)
      const episode = (
        await db.query(
          'SELECT 1 FROM learning_episodes WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3 AND id=$4 AND created_at>$5',
          [...keys, episodeId, at - settings.caseRetentionDays * 86400000]
        )
      ).rows[0]
      if (!episode) throw new Error('memory_evidence_unavailable')
      const hash = learningHash({ episodeId, trigger })
      const event = (
        await db.query(
          'SELECT input_hash,job_id FROM learning_job_events WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3 AND source_id=$4',
          [...keys, source]
        )
      ).rows[0]
      if (event) {
        if (event.input_hash !== hash) throw new Error('learning_event_conflict')
        const old = (
          await db.query(
            'SELECT * FROM learning_jobs WHERE tenant_id=$1 AND account_id=$2 AND id=$3',
            [scope.tenant_id, scope.account_id, event.job_id]
          )
        ).rows[0]
        return old ? this.job(scope, old) : null
      }
      if (settings.mode === 'off') return null
      const old = (
        await db.query(
          "SELECT * FROM learning_jobs WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3 AND state='pending' ORDER BY available_at,id LIMIT 1",
          keys
        )
      ).rows[0]
      let job = old ? this.job(scope, old) : null
      if (job && job.episodeIds.length >= 20 && !job.episodeIds.includes(episodeId)) job = null
      job ??= {
        id: randomUUID(),
        scope: enterpriseMemoryScope(scope, conversation || null),
        episodeIds: [],
        triggers: [],
        state: 'pending',
        attempts: 0,
        availableAt: at,
        createdAt: at,
        updatedAt: at,
        lastError: null,
        leaseUntil: null,
        claimToken: null,
        proposedIds: []
      }
      job.episodeIds = [...new Set([...job.episodeIds, episodeId])]
      job.triggers = [...new Set([...job.triggers, trigger])]
      job.availableAt = at + settings.idleDelayMs
      job.updatedAt = at
      await this.write(db, scope, conversation, job)
      await db.query('INSERT INTO learning_job_events VALUES($1,$2,$3,$4,$5,$6)', [
        ...keys,
        source,
        hash,
        job.id
      ])
      return job
    })
  }
  list(credential: string, conversationId: string | null): Promise<LearningJob[]> {
    return this.locked(credential, conversationId, async (db, scope, conversation) =>
      (
        await db.query(
          'SELECT * FROM learning_jobs WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3 ORDER BY available_at,id',
          this.keys(scope, conversation)
        )
      ).rows.map((row) => this.job(scope, row))
    )
  }
  private async usageWithin(
    db: PoolClient,
    scope: Scope,
    at: number
  ): Promise<EnterpriseLearningUsage> {
    return learningUsageWithin(db, scope, at)
  }
  usage(credential: string): Promise<EnterpriseLearningUsage> {
    return this.locked(credential, null, (db, scope, _conversation, at) =>
      this.usageWithin(db, scope, at)
    )
  }
  async claim(credential: string, workerInput: string): Promise<EnterpriseLearningClaim | null> {
    const worker = Id.parse(workerInput)
    return this.locked(credential, null, async (db, scope, _conversation, at) => {
      const account = [scope.tenant_id, scope.account_id],
        foreground = await this.foreground(db, scope)
      if (
        (await db.query('SELECT paused FROM accounts WHERE tenant_id=$1 AND id=$2', account))
          .rows[0]?.paused
      )
        return null
      if (foreground.running) return null
      const lease = (
        await db.query(
          'SELECT claim_token,lease_until FROM learning_background_leases WHERE tenant_id=$1 AND account_id=$2',
          account
        )
      ).rows[0]
      if (lease && Number(lease.lease_until) > at) return null
      if (lease) {
        await expireLearningLeaseWithin(db, scope, String(lease.claim_token), at)
        await db.query(
          'DELETE FROM learning_background_leases WHERE tenant_id=$1 AND account_id=$2',
          account
        )
      }
      const rows = (
        await db.query(
          "SELECT * FROM learning_jobs WHERE tenant_id=$1 AND account_id=$2 AND ((state IN ('pending','failed') AND available_at<=$3) OR (state='running' AND lease_until<=$3)) ORDER BY available_at,id",
          [...account, at]
        )
      ).rows
      const parent = await effectiveLearningSettings(db, scope, '')
      for (const row of rows) {
        const conversation = String(row.conversation_id),
          job = this.job(scope, row),
          settings = await effectiveLearningSettings(db, scope, conversation)
        if (settings.mode === 'off' || at < foreground.at + settings.idleDelayMs) continue
        const sources = (
          await db.query(
            'SELECT id::text FROM learning_episodes WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3 AND id=ANY($4::uuid[]) AND created_at>$5',
            [
              ...this.keys(scope, conversation),
              job.episodeIds,
              at - settings.caseRetentionDays * 86400000
            ]
          )
        ).rows
        if (job.attempts >= settings.maxAttempts || sources.length !== job.episodeIds.length) {
          job.state = 'cancelled'
          job.lastError =
            job.attempts >= settings.maxAttempts ? 'attempt_limit' : 'memory_evidence_unavailable'
          job.leaseUntil = null
          job.claimToken = null
          job.updatedAt = at
          await this.write(db, scope, conversation, job)
          continue
        }
        const reserve = settings.maxReviewInputTokens + MAX_REVIEW_OUTPUT_TOKENS
        if (
          (await this.usageWithin(db, scope, at)).reservedTokens + reserve >
          Math.min(settings.dailyReviewTokenBudget, parent.dailyReviewTokenBudget)
        )
          continue
        const token = randomUUID()
        job.attempts++
        job.state = 'running'
        job.updatedAt = at
        job.leaseUntil = at + settings.reviewTimeoutMs + 5000
        job.claimToken = token
        await db.query(
          `INSERT INTO learning_attempts(tenant_id,account_id,conversation_id,claim_token,job_id,worker_id,purpose,day,reserved_tokens,charged_tokens,state,created_at,foreground_revision)
          VALUES($1,$2,$3,$4,$5,$6,'review',$7::date,$8,$8,'running',$9,$10)`,
          [
            ...this.keys(scope, conversation),
            token,
            job.id,
            worker,
            new Date(at).toISOString().slice(0, 10),
            reserve,
            at,
            foreground.revision
          ]
        )
        await db.query("INSERT INTO learning_background_leases VALUES($1,$2,$3,'review',$4)", [
          ...account,
          token,
          job.leaseUntil
        ])
        await this.write(db, scope, conversation, job)
        const captured = { scope: structuredClone(scope), token, jobId: job.id }
        return {
          ...job,
          claimToken: token,
          leaseUntil: job.leaseUntil,
          reservedTokens: reserve,
          settleUsage: (usage) => this.settleUsage(captured, usage)
        }
      }
      return null
    })
  }
  private async assertClaim(
    db: PoolClient,
    scope: Scope,
    claim: ClaimedLearningJob,
    at: number
  ): Promise<{ job: LearningJob; attempt: Row; conversation: string }> {
    const row = (
      await db.query('SELECT * FROM learning_jobs WHERE tenant_id=$1 AND account_id=$2 AND id=$3', [
        scope.tenant_id,
        scope.account_id,
        claim.id
      ])
    ).rows[0]
    const conversation = String(row?.conversation_id ?? ''),
      job = row ? this.job(scope, row) : null
    const slot = (
      await db.query(
        'SELECT claim_token,lease_until FROM learning_background_leases WHERE tenant_id=$1 AND account_id=$2',
        [scope.tenant_id, scope.account_id]
      )
    ).rows[0]
    if (
      !job ||
      job.state !== 'running' ||
      job.claimToken !== claim.claimToken ||
      !job.leaseUntil ||
      job.leaseUntil <= at ||
      slot?.claim_token !== claim.claimToken ||
      Number(slot.lease_until) <= at ||
      learningHash(job.scope) !== learningHash(claim.scope)
    )
      throw new Error('learning_claim_expired')
    const attempt = (
      await db.query(
        'SELECT * FROM learning_attempts WHERE tenant_id=$1 AND account_id=$2 AND claim_token=$3 AND job_id=$4',
        [scope.tenant_id, scope.account_id, claim.claimToken, claim.id]
      )
    ).rows[0]
    if (!attempt || attempt.state !== 'running') throw new Error('learning_claim_expired')
    return { job, attempt, conversation }
  }
  private async updateUsage(
    db: PoolClient,
    scope: Scope,
    token: string,
    attempt: Row,
    usage?: ReviewUsage
  ): Promise<void> {
    if (!usage) return
    const measurement = usage.measurement ?? 'reported'
    if (
      attempt.measurement === 'reported' &&
      (measurement !== 'reported' ||
        Number(attempt.input_tokens) !== usage.inputTokens ||
        Number(attempt.output_tokens) !== usage.outputTokens)
    )
      throw new Error('learning_usage_conflict')
    const charged =
      measurement === 'upper_bound'
        ? Number(attempt.reserved_tokens)
        : usage.inputTokens + usage.outputTokens
    await db.query(
      'UPDATE learning_attempts SET charged_tokens=$4,input_tokens=$5,output_tokens=$6,measurement=$7 WHERE tenant_id=$1 AND account_id=$2 AND claim_token=$3',
      [
        scope.tenant_id,
        scope.account_id,
        token,
        charged,
        usage.inputTokens,
        usage.outputTokens,
        measurement
      ]
    )
  }
  /** Pollable authority check used to abort work before a stale model result can be committed. */
  assertCurrentClaim(credential: string, claim: ClaimedLearningJob): Promise<void> {
    return this.locked(credential, null, async (db, scope, _conversation, at) => {
      const { job, attempt, conversation } = await this.assertClaim(db, scope, claim, at)
      const settings = await effectiveLearningSettings(db, scope, conversation)
      if (
        settings.mode === 'off' ||
        (
          await db.query('SELECT paused FROM accounts WHERE tenant_id=$1 AND id=$2', [
            scope.tenant_id,
            scope.account_id
          ])
        ).rows[0]?.paused
      )
        throw new Error('learning_disabled')
      const foreground = await this.foreground(db, scope)
      if (foreground.running || foreground.revision !== Number(attempt.foreground_revision))
        throw new Error('learning_foreground_preempted')
      const sources = await db.query(
        'SELECT id FROM learning_episodes WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3 AND id=ANY($4::uuid[]) AND created_at>$5',
        [
          ...this.keys(scope, conversation),
          job.episodeIds,
          at - settings.caseRetentionDays * 86400000
        ]
      )
      if (sources.rows.length !== job.episodeIds.length)
        throw new Error('memory_evidence_unavailable')
    })
  }
  private async release(db: PoolClient, scope: Scope, token: string): Promise<void> {
    await db.query(
      'DELETE FROM learning_background_leases WHERE tenant_id=$1 AND account_id=$2 AND claim_token=$3',
      [scope.tenant_id, scope.account_id, token]
    )
  }
  async complete(
    credential: string,
    claim: ClaimedLearningJob,
    usageInput: ReviewUsage,
    commit?: Commit
  ): Promise<void> {
    const usage = ReviewUsageSchema.parse(usageInput)
    return this.locked(credential, null, async (db, scope, _conversation, at) => {
      const { job, attempt, conversation } = await this.assertClaim(db, scope, claim, at)
      const settings = await effectiveLearningSettings(db, scope, conversation),
        foreground = await this.foreground(db, scope)
      if (
        settings.mode === 'off' ||
        (
          await db.query('SELECT paused FROM accounts WHERE tenant_id=$1 AND id=$2', [
            scope.tenant_id,
            scope.account_id
          ])
        ).rows[0]?.paused
      )
        throw new Error('learning_disabled')
      if (foreground.running || foreground.revision !== Number(attempt.foreground_revision))
        throw new Error('learning_foreground_preempted')
      if (
        usage.inputTokens > Number(attempt.reserved_tokens) - MAX_REVIEW_OUTPUT_TOKENS ||
        usage.outputTokens > MAX_REVIEW_OUTPUT_TOKENS
      )
        throw new Error('learning_usage_over_budget')
      const sources = (
        await db.query(
          'SELECT id FROM learning_episodes WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3 AND id=ANY($4::uuid[]) AND created_at>$5',
          [
            ...this.keys(scope, conversation),
            job.episodeIds,
            at - settings.caseRetentionDays * 86400000
          ]
        )
      ).rows
      if (sources.length !== job.episodeIds.length) throw new Error('memory_evidence_unavailable')
      const proposed = commit ? await commit(db, scope, conversation, at) : []
      job.proposedIds = z
        .array(Id)
        .max(100)
        .parse(proposed ?? [])
      await this.updateUsage(db, scope, claim.claimToken, attempt, usage)
      await db.query(
        "UPDATE learning_attempts SET state='completed' WHERE tenant_id=$1 AND account_id=$2 AND claim_token=$3",
        [scope.tenant_id, scope.account_id, claim.claimToken]
      )
      job.state = 'completed'
      job.updatedAt = at
      job.leaseUntil = null
      job.claimToken = null
      job.lastError = null
      await this.write(db, scope, conversation, job)
      await this.release(db, scope, claim.claimToken)
    })
  }
  async fail(
    credential: string,
    claim: ClaimedLearningJob,
    reason: string,
    usageInput?: ReviewUsage
  ): Promise<void> {
    z.string().min(1).max(100).parse(reason)
    const usage = usageInput ? ReviewUsageSchema.parse(usageInput) : undefined
    return this.locked(credential, null, async (db, scope, _conversation, at) => {
      const { job, attempt, conversation } = await this.assertClaim(db, scope, claim, at),
        settings = await effectiveLearningSettings(db, scope, conversation)
      await this.updateUsage(db, scope, claim.claimToken, attempt, usage)
      await db.query(
        "UPDATE learning_attempts SET state='failed',failure_code=$4 WHERE tenant_id=$1 AND account_id=$2 AND claim_token=$3",
        [scope.tenant_id, scope.account_id, claim.claimToken, reason]
      )
      job.state = job.attempts >= settings.maxAttempts ? 'cancelled' : 'failed'
      job.updatedAt = at
      job.availableAt = at + Math.min(60000, 5000 * 2 ** (job.attempts - 1))
      job.lastError = reason
      job.leaseUntil = null
      job.claimToken = null
      await this.write(db, scope, conversation, job)
      await this.release(db, scope, claim.claimToken)
    })
  }
  cancel(credential: string, conversationId: string | null, id: string): Promise<void> {
    return this.locked(credential, conversationId, async (db, scope, conversation, at) => {
      const row = (
        await db.query(
          'SELECT * FROM learning_jobs WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3 AND id=$4',
          [...this.keys(scope, conversation), id]
        )
      ).rows[0]
      if (!row) throw new Error('learning_job_not_found')
      const job = this.job(scope, row)
      if (job.state === 'completed') return
      if (job.claimToken) {
        await db.query(
          "UPDATE learning_attempts SET state='cancelled',failure_code='user_cancelled' WHERE tenant_id=$1 AND account_id=$2 AND claim_token=$3",
          [scope.tenant_id, scope.account_id, job.claimToken]
        )
        await this.release(db, scope, job.claimToken)
      }
      job.state = 'cancelled'
      job.updatedAt = at
      job.lastError = 'user_cancelled'
      job.leaseUntil = null
      job.claimToken = null
      await this.write(db, scope, conversation, job)
    })
  }
  private async settleUsage(
    captured: { scope: Scope; token: string; jobId: string },
    raw: ReviewUsage
  ): Promise<boolean> {
    const usage = ReviewUsageSchema.parse(raw)
    if (usage.measurement !== 'reported') return false
    const { scope, token, jobId } = captured
    // This host-held receipt can settle the original reservation after revocation. It grants no content authority.
    return this.db.transaction(scope.tenant_id, async (db) => {
      await db.query("SELECT set_config('app.learning_account_id',$1,true)", [scope.account_id])
      await db.query('SELECT 1 FROM accounts WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [
        scope.tenant_id,
        scope.account_id
      ])
      const attempt = (
        await db.query(
          'SELECT * FROM learning_attempts WHERE tenant_id=$1 AND account_id=$2 AND claim_token=$3 AND job_id=$4',
          [scope.tenant_id, scope.account_id, token, jobId]
        )
      ).rows[0]
      if (!attempt) return false
      await this.updateUsage(db, scope, token, attempt, usage)
      return true
    })
  }
}
