import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { embeddedPostgres } from '../fixtures/embedded-postgres'
import { AccountAuthority, tokenHash } from '../../server/src/auth/account-authority'
import { EnterpriseLearningRepository } from '../../server/src/learning/learning-repository'
import { EnterpriseLearningQueue } from '../../server/src/learning/learning-queue'

const credential = 'Q'.repeat(43)
let db: Awaited<ReturnType<typeof embeddedPostgres>>,
  repository: EnterpriseLearningRepository,
  queue: EnterpriseLearningQueue,
  now: number
beforeAll(async () => {
  db = await embeddedPostgres()
  await db.adminExec(
    "INSERT INTO tenants(id,name) VALUES('company','合成企业'); INSERT INTO employees(tenant_id,id,role) VALUES('company','employee','employee'); INSERT INTO accounts(tenant_id,id,employee_id,platform,paused) VALUES('company','account','employee','wework',false)"
  )
  await db.adminQuery(
    "INSERT INTO agents(tenant_id,id,account_id,employee_id,token_hash) VALUES('company','agent','account','employee',$1)",
    [tokenHash(credential)]
  )
  const authority = new AccountAuthority(db.db)
  repository = new EnterpriseLearningRepository(authority, { now: () => now })
  queue = new EnterpriseLearningQueue(db.db, authority, { now: () => now })
}, 20000)
afterAll(async () => {
  if (db) await db.db.close()
})
beforeEach(async () => {
  now = Date.now()
  await db.adminExec(
    'TRUNCATE learning_versions,learning_episodes,learning_settings,learning_jobs,learning_attempts,learning_retained_usage,learning_background_leases,learning_foreground_activity,learning_tombstones CASCADE; UPDATE agents SET revoked_at=NULL; UPDATE accounts SET paused=false'
  )
})
async function enqueue(conversationId = 'customer-A', sourceId = 'correction-A') {
  const episode = await repository.recordEpisode(credential, conversationId, {
    sourceId,
    topic: '设备询价',
    startedAt: now,
    messages: [],
    outcome: 'corrected',
    correction: '先确认型号',
    identityStatus: 'verified'
  })
  return queue.enqueue(credential, conversationId, episode.id, 'correction', sourceId)
}
describe('enterprise persistent learning queue and accounting', () => {
  it('deduplicates triggers, respects the complete foreground idle interval and survives a new queue instance', async () => {
    const job = (await enqueue())!
    expect(await enqueue()).toMatchObject({ id: job.id, episodeIds: job.episodeIds })
    expect(await queue.claim(credential, 'worker-A')).toBeNull()
    now += 15000
    await queue.recordForegroundActivity(credential)
    expect(await queue.claim(credential, 'worker-A')).toBeNull()
    now += 14999
    expect(await queue.claim(credential, 'worker-A')).toBeNull()
    now++
    const restarted = new EnterpriseLearningQueue(db.db, repository.authority, { now: () => now })
    const claim = (await restarted.claim(credential, 'worker-B'))!
    expect(claim).toMatchObject({
      id: job.id,
      attempts: 1,
      reservedTokens: 10000,
      state: 'running'
    })
    expect(await queue.claim(credential, 'worker-A')).toBeNull()
    expect(await queue.usage(credential)).toMatchObject({
      reservedTokens: 10000,
      requests: 1,
      estimatedRequests: 1
    })
    await restarted.complete(credential, claim, {
      inputTokens: 200,
      outputTokens: 100,
      measurement: 'reported'
    })
    expect(await queue.list(credential, 'customer-A')).toMatchObject([
      { id: job.id, state: 'completed' }
    ])
    expect(await queue.usage(credential)).toMatchObject({
      reservedTokens: 300,
      requests: 1,
      reportedRequests: 1
    })
  })
  it('shares the account budget between customer queues and retains unknown dispatched fees on retry', async () => {
    await repository.settings(credential, null, { dailyReviewTokenBudget: 10000 })
    await enqueue()
    await enqueue('customer-B', 'correction-B')
    now += 15000
    const claim = (await queue.claim(credential, 'worker-A'))!
    await queue.fail(credential, claim, 'provider_timeout')
    now += 15000
    expect(await queue.claim(credential, 'worker-B')).toBeNull()
    expect(await queue.usage(credential)).toMatchObject({
      reservedTokens: 10000,
      estimatedRequests: 1
    })
    expect(
      await claim.settleUsage({ inputTokens: 300, outputTokens: 50, measurement: 'reported' })
    ).toBe(true)
    // 350 + the next upper-bound reservation exceeds the account cap.
    expect(await queue.claim(credential, 'worker-B')).toBeNull()
    await repository.settings(credential, null, { dailyReviewTokenBudget: 10350 })
    expect(await queue.claim(credential, 'worker-B')).not.toBeNull()
  })
  it('rolls back a failed candidate commit together with job completion and settles consumed fees separately', async () => {
    await enqueue()
    now += 15000
    const claim = (await queue.claim(credential, 'worker-A'))!
    await expect(
      queue.complete(credential, claim, { inputTokens: 100, outputTokens: 20 }, async (client) => {
        await client.query(
          "INSERT INTO learning_settings VALUES('company','account','customer-B','{\"mode\":\"off\"}')"
        )
        throw new Error('candidate_commit_failed')
      })
    ).rejects.toThrow('candidate_commit_failed')
    expect((await queue.list(credential, 'customer-A'))[0].state).toBe('running')
    expect((await repository.settings(credential, 'customer-B')).mode).toBe('suggest')
    await queue.fail(credential, claim, 'candidate_commit_failed', {
      inputTokens: 100,
      outputTokens: 20,
      measurement: 'reported'
    })
    expect(await queue.usage(credential)).toMatchObject({
      reservedTokens: 120,
      reportedRequests: 1
    })
  })
  it('rejects stale leases and cancels without refunding possibly dispatched requests', async () => {
    await enqueue()
    now += 15000
    const old = (await queue.claim(credential, 'worker-A'))!
    now = old.leaseUntil
    const fresh = (await queue.claim(credential, 'worker-B'))!
    expect(fresh.claimToken).not.toBe(old.claimToken)
    await expect(
      queue.complete(credential, old, { inputTokens: 1, outputTokens: 1 })
    ).rejects.toThrow('learning_claim_expired')
    await queue.cancel(credential, 'customer-A', fresh.id)
    await expect(
      queue.complete(credential, fresh, { inputTokens: 1, outputTokens: 1 })
    ).rejects.toThrow('learning_claim_expired')
    expect(await queue.usage(credential)).toMatchObject({
      reservedTokens: 20000,
      estimatedRequests: 2
    })
    expect(
      await old.settleUsage({ inputTokens: 10, outputTokens: 10, measurement: 'reported' })
    ).toBe(true)
    expect((await queue.list(credential, 'customer-A'))[0].state).toBe('cancelled')
  })
  it('does not claim or commit while parent learning is off and only resumes after the parent is enabled', async () => {
    await enqueue()
    now += 15000
    await repository.settings(credential, null, { mode: 'off' })
    await repository.settings(credential, 'customer-A', { mode: 'auto' })
    expect(await queue.claim(credential, 'worker-A')).toBeNull()
    await repository.settings(credential, null, { mode: 'suggest' })
    const claim = (await queue.claim(credential, 'worker-A'))!
    await repository.settings(credential, null, { mode: 'off' })
    await expect(
      queue.complete(credential, claim, { inputTokens: 1, outputTokens: 1 })
    ).rejects.toThrow('learning_disabled')
    await queue.fail(credential, claim, 'learning_disabled', {
      inputTokens: 1,
      outputTokens: 1,
      measurement: 'reported'
    })
  })
  it('forgets job data while retaining anonymous account/day costs and refuses late commit or fee resurrection', async () => {
    await enqueue()
    now += 15000
    const claim = (await queue.claim(credential, 'worker-A'))!
    await repository.forgetScope(credential, 'customer-A')
    expect(await queue.list(credential, 'customer-A')).toEqual([])
    await expect(
      queue.complete(credential, claim, { inputTokens: 1, outputTokens: 1 })
    ).rejects.toThrow('learning_claim_expired')
    expect(
      await claim.settleUsage({ inputTokens: 1, outputTokens: 1, measurement: 'reported' })
    ).toBe(false)
    expect(await queue.usage(credential)).toMatchObject({
      reservedTokens: 10000,
      estimatedRequests: 1
    })
    expect(
      (await db.adminQuery('SELECT count(*)::integer AS n FROM learning_attempts')).rows[0]
    ).toMatchObject({ n: 0 })
    expect(
      (await db.adminQuery('SELECT count(*)::integer AS n FROM learning_job_events')).rows[0]
    ).toMatchObject({ n: 0 })
  })
  it('accepts accounting-only late usage after device revocation without accepting candidate completion', async () => {
    await enqueue()
    now += 15000
    const claim = (await queue.claim(credential, 'worker-A'))!
    await db.adminExec("UPDATE agents SET revoked_at=clock_timestamp() WHERE id='agent'")
    await expect(
      queue.complete(credential, claim, { inputTokens: 1, outputTokens: 1 })
    ).rejects.toThrow('DENIED')
    expect(
      await claim.settleUsage({ inputTokens: 20, outputTokens: 30, measurement: 'reported' })
    ).toBe(true)
    expect(
      (await db.adminQuery('SELECT state,charged_tokens FROM learning_attempts')).rows[0]
    ).toMatchObject({ state: 'running', charged_tokens: 50 })
    expect((await db.adminQuery('SELECT state FROM learning_jobs')).rows[0]).toMatchObject({
      state: 'running'
    })
  })
  it('rejects completion after foreground activity even when it starts and ends within the same millisecond', async () => {
    await enqueue()
    now += 15000
    const claim = (await queue.claim(credential, 'worker-A'))!
    await queue.recordForegroundActivity(credential)
    await expect(
      queue.complete(credential, claim, { inputTokens: 10, outputTokens: 10 })
    ).rejects.toThrow('learning_foreground_preempted')
    await queue.fail(credential, claim, 'learning_foreground_preempted', {
      inputTokens: 10,
      outputTokens: 10,
      measurement: 'reported'
    })
    expect((await queue.list(credential, 'customer-A'))[0].state).toBe('failed')
  })
  it('keeps the original UTC reservation day when consumption arrives after midnight', async () => {
    now = Date.UTC(2026, 9, 3, 23, 59, 30)
    await enqueue()
    now += 15000
    const claim = (await queue.claim(credential, 'worker-A'))!
    const originalDay = (await queue.usage(credential)).day
    now += 20000
    expect((await queue.usage(credential)).day).not.toBe(originalDay)
    await queue.complete(credential, claim, {
      inputTokens: 10,
      outputTokens: 20,
      measurement: 'reported'
    })
    expect(await queue.usage(credential)).toMatchObject({ reservedTokens: 0, requests: 0 })
    expect(
      (await db.adminQuery('SELECT day::text,charged_tokens FROM learning_attempts')).rows[0]
    ).toMatchObject({ day: originalDay, charged_tokens: 30 })
  })
  it('stops background claims and candidate commits while the account is paused', async () => {
    await enqueue()
    now += 15000
    await db.adminExec('UPDATE accounts SET paused=true')
    expect(await queue.claim(credential, 'worker-A')).toBeNull()
    await db.adminExec('UPDATE accounts SET paused=false')
    const claim = (await queue.claim(credential, 'worker-A'))!
    await db.adminExec('UPDATE accounts SET paused=true')
    await expect(
      queue.complete(credential, claim, { inputTokens: 10, outputTokens: 20 })
    ).rejects.toThrow('learning_disabled')
    await queue.fail(credential, claim, 'account_paused', {
      inputTokens: 10,
      outputTokens: 20,
      measurement: 'reported'
    })
    expect(await queue.usage(credential)).toMatchObject({ reservedTokens: 30, reportedRequests: 1 })
  })
})
