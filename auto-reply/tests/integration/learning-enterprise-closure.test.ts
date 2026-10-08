import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { embeddedPostgres } from '../fixtures/embedded-postgres'
import { taskFixture } from '../fixtures/task'
import { AccountAuthority, tokenHash } from '../../server/src/auth/account-authority'
import { EnterpriseLearningWorkerAuthority } from '../../server/src/learning/learning-worker-authority'
import { EnterpriseLearningRepository } from '../../server/src/learning/learning-repository'
import { EnterpriseLearningMaintenanceService } from '../../server/src/learning/learning-maintenance-service'
import { EnterpriseLearningManagement } from '../../server/src/learning/learning-service'
import {
  enterpriseDraftSource,
  prepareEnterpriseLearningTask,
  assertEnterpriseLearningTaskCurrent
} from '../../server/src/learning/learning-generation-context'
import { recordLearningForegroundWithin } from '../../server/src/learning/learning-account'
import type { LearningEpisode } from '../../src/shared/contracts/learning-memory'

const IDLE = 30 * 60 * 1000
const token = 'C'.repeat(43),
  reference = randomUUID()
let db: Awaited<ReturnType<typeof embeddedPostgres>>, now: number, original: LearningEpisode
let device: AccountAuthority, worker: EnterpriseLearningWorkerAuthority
let repository: EnterpriseLearningRepository<EnterpriseLearningWorkerAuthority>
let maintenance: EnterpriseLearningMaintenanceService
let fixture: ReturnType<typeof taskFixture>
beforeAll(async () => {
  db = await embeddedPostgres('autoreply_learning_worker')
  device = new AccountAuthority(db.db)
  worker = new EnterpriseLearningWorkerAuthority(db.db)
  repository = new EnterpriseLearningRepository(worker, { now: () => now })
  maintenance = new EnterpriseLearningMaintenanceService(worker, { now: () => now })
}, 20000)
afterAll(async () => {
  if (db) await db.db.close()
})
beforeEach(async () => {
  now = Date.now()
  fixture = taskFixture()
  fixture.task.createdAt = now
  fixture.task.expiresAt = now + 10000
  await db.adminExec(
    "TRUNCATE tenants CASCADE; INSERT INTO tenants(id,name) VALUES('company','合成企业'); INSERT INTO employees(tenant_id,id,role) VALUES('company','employee-A','employee'); INSERT INTO accounts(tenant_id,id,employee_id,platform,paused) VALUES('company','account-A','employee-A','wework',false)"
  )
  await db.adminQuery(
    "INSERT INTO agents(tenant_id,id,account_id,employee_id,token_hash) VALUES('company','agent-A','account-A','employee-A',$1)",
    [tokenHash(token)]
  )
  const login = z
    .object({ login: z.string() })
    .parse((await db.adminQuery('SELECT session_user AS login')).rows[0]).login
  await db.adminQuery(
    'INSERT INTO learning_worker_bindings(id,login_name,tenant_id,account_id,employee_id,agent_id,agent_token_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [reference, login, 'company', 'account-A', 'employee-A', 'agent-A', tokenHash(token)]
  )
  original = await repository.recordEpisode(reference, fixture.task.conversationId, {
    sourceId: enterpriseDraftSource(fixture.task),
    identityStatus: 'verified',
    topic: '订单核对',
    startedAt: now,
    messages: [{ sourceId: 'inbound-1', role: 'customer', text: '请核对订单。' }],
    draft: fixture.draft.text,
    outcome: 'unknown'
  })
  await repository.registerGeneration(
    reference,
    fixture.task.conversationId,
    original.sourceId,
    original.id,
    []
  )
  await db.adminQuery(
    "INSERT INTO generation_tasks(tenant_id,account_id,task_id,agent_id,request_hash,task_json,status,expires_at,result_json) VALUES('company','account-A',$1,'agent-A',$2,$3::jsonb,'completed',to_timestamp($4/1000.0),$5::jsonb)",
    [
      fixture.task.taskId,
      'a'.repeat(64),
      JSON.stringify(fixture.task),
      fixture.task.expiresAt,
      JSON.stringify({
        task: fixture.task,
        draft: fixture.draft,
        status: 'handoff',
        automaticAllowed: false,
        factsVerified: false,
        reasons: [],
        intents: [],
        usage: { input_tokens: 0, output_tokens: 0 }
      })
    ]
  )
})
async function closed(): Promise<LearningEpisode[]> {
  return (await repository.episodes(reference, fixture.task.conversationId)).filter(
    (episode) => episode.endedAt !== undefined
  )
}
async function generationContext(taskId = 'next') {
  const prepared = await device.withLockedAccount(token, (client, scope) =>
    prepareEnterpriseLearningTask(
      client,
      scope,
      { ...fixture.task, taskId, createdAt: Date.now(), expiresAt: Date.now() + 10000 },
      '订单核对'
    )
  )
  return device.withLockedAccount(token, (client, scope) =>
    assertEnterpriseLearningTaskCurrent(client, scope, prepared)
  )
}
const correctionInput = () => ({
  reference: {
    taskId: fixture.task.taskId,
    contextHash: fixture.task.contextHash,
    draftHash: fixture.draft.draftHash,
    draftRevision: fixture.draft.draftRevision
  },
  sourceId: 'correction',
  text: '先核对订单，再查政策。',
  reason: '缺少核对'
})
describe('enterprise idle problem closure', () => {
  it('closes an actual unknown fragment at exactly thirty minutes, survives restart and never claims success or queues learning', async () => {
    now += IDLE - 1
    await maintenance.runOnce(reference)
    expect(await closed()).toEqual([])
    now++
    const result = await maintenance.runOnce(reference)
    expect(result.closedEpisodes).toEqual([
      {
        conversationId: fixture.task.conversationId,
        sourceEpisodeId: original.id,
        episodeId: expect.any(String)
      }
    ])
    expect(await closed()).toMatchObject([
      {
        outcome: 'unknown',
        endedAt: now,
        startedAt: original.startedAt,
        createdAt: original.createdAt,
        draft: original.draft,
        messages: original.messages
      }
    ])
    expect((await db.adminQuery('SELECT * FROM learning_jobs')).rows).toEqual([])
    expect(
      (
        await db.adminQuery(
          "SELECT payload FROM learning_feedback WHERE payload->>'kind'<>'loaded'"
        )
      ).rows
    ).toEqual([])
    const first = await closed()
    const restarted = new EnterpriseLearningMaintenanceService(worker, { now: () => now })
    now += IDLE
    expect((await restarted.runOnce(reference)).closedEpisodes).toEqual([])
    expect(await closed()).toEqual(first)
    expect(
      (await repository.episodes(reference, fixture.task.conversationId)).find(
        (e) => e.id === original.id
      )
    ).toEqual(original)
  })
  it('does not merge independent topics merely because they share a customer', async () => {
    const second = await repository.recordEpisode(reference, fixture.task.conversationId, {
      sourceId: 'other-independent-generation',
      identityStatus: 'verified',
      topic: '配送地址',
      startedAt: now,
      messages: [{ sourceId: 'inbound-2', role: 'customer', text: '配送到哪里？' }],
      draft: '请确认地址。',
      outcome: 'unknown'
    })
    await repository.registerGeneration(
      reference,
      fixture.task.conversationId,
      second.sourceId,
      second.id,
      []
    )
    now += IDLE
    await maintenance.runOnce(reference)
    expect(await closed()).toHaveLength(2)
    expect((await closed()).map((e) => e.messages[0].text).sort()).toEqual(
      ['配送到哪里？', '请核对订单。'].sort()
    )
  })
  it('keeps the explicit corrected/result evidence instead of producing another unknown closure', async () => {
    const management = new EnterpriseLearningManagement(db.db, device, { now: () => now })
    await management.request(token, 'correction', correctionInput())
    now += IDLE
    expect((await maintenance.runOnce(reference)).closedEpisodes).toEqual([])
    expect(await closed()).toMatchObject([{ outcome: 'corrected' }])
  })
  it('uses later explicit correction instead of also retrieving its earlier unknown closure', async () => {
    now += IDLE
    await maintenance.runOnce(reference)
    const idleCase = (await closed())[0]
    expect((await generationContext('before-correction')).caseIds).toEqual([idleCase.id])
    now++
    const management = new EnterpriseLearningManagement(db.db, device, { now: () => now })
    const corrected = (await management.request(
      token,
      'correction',
      correctionInput()
    )) as LearningEpisode
    const context = await generationContext('after-correction')
    expect(context.caseIds).toEqual([corrected.id])
    expect(context.caseIds).not.toContain(idleCase.id)
    // History remains immutable and reviewable even after more precise feedback arrives.
    expect((await closed()).find((e) => e.id === idleCase.id)).toEqual(idleCase)
  })
  it('cancels the whole account transaction when shutdown arrives during closure provenance persistence', async () => {
    now += IDLE
    const controller = new AbortController()
    const cancelling = new EnterpriseLearningMaintenanceService(
      {
        withLockedAccount: (credential, run, checkLease) =>
          worker.withLockedAccount(
            credential,
            (client, scope) =>
              run(
                {
                  query: async (sql: string, values?: unknown[]) => {
                    const result = await client.query(sql, values)
                    if (sql.startsWith('INSERT INTO learning_episode_closures')) controller.abort()
                    return result
                  }
                } as typeof client,
                scope
              ),
            checkLease
          )
      },
      { now: () => now }
    )
    await expect(cancelling.runOnce(reference, controller.signal)).rejects.toThrow(
      'curation_cancelled'
    )
    expect(await closed()).toEqual([])
    expect((await db.adminQuery('SELECT * FROM learning_episode_closures')).rows).toEqual([])
  })
  it('waits for foreground quiescence, including activity recorded at the closure boundary', async () => {
    now += IDLE
    await worker.withLockedAccount(reference, (client, scope) =>
      recordLearningForegroundWithin(client, scope, now)
    )
    expect((await maintenance.runOnce(reference)).closedEpisodes).toEqual([])
    now += 15000
    expect((await maintenance.runOnce(reference)).closedEpisodes).toHaveLength(1)
  })
  it('closes unknown evidence while learning is off without scheduling a model or renewing retention', async () => {
    await repository.settings(reference, null, { mode: 'off', caseRetentionDays: 7 })
    now += IDLE
    await maintenance.runOnce(reference)
    expect(await closed()).toMatchObject([{ outcome: 'unknown', createdAt: original.createdAt }])
    now = original.createdAt + 7 * 86400000
    await maintenance.runOnce(reference)
    expect(await repository.episodes(reference, fixture.task.conversationId)).toEqual([])
    expect((await db.adminQuery('SELECT * FROM learning_episode_closures')).rows).toEqual([])
    expect((await db.adminQuery('SELECT * FROM learning_jobs')).rows).toEqual([])
  })
  it('forgets closure bodies and provenance and cannot restore them on a later maintenance pass', async () => {
    now += IDLE
    await maintenance.runOnce(reference)
    await repository.forgetScope(reference, fixture.task.conversationId)
    now += IDLE
    await maintenance.runOnce(reference)
    expect(await closed()).toEqual([])
    expect((await db.adminQuery('SELECT * FROM learning_episode_closures')).rows).toEqual([])
  })
  it('rolls back derived evidence if closure provenance cannot be committed', async () => {
    now += IDLE
    await db.adminExec(
      "CREATE FUNCTION autoreply.reject_idle_closure() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'closure_failed';END$$;CREATE TRIGGER reject_idle_closure BEFORE INSERT ON learning_episode_closures FOR EACH ROW EXECUTE FUNCTION autoreply.reject_idle_closure()"
    )
    try {
      await expect(maintenance.runOnce(reference)).rejects.toThrow('closure_failed')
      expect(await closed()).toEqual([])
    } finally {
      await db.adminExec(
        'DROP TRIGGER reject_idle_closure ON learning_episode_closures; DROP FUNCTION autoreply.reject_idle_closure()'
      )
    }
  })
  it('makes only the closed historical fragment available to actual generation context retrieval', async () => {
    now += IDLE
    await maintenance.runOnce(reference)
    const context = await generationContext()
    expect(context.caseIds).toEqual((await closed()).map((e) => e.id))
    expect(context.caseIds).not.toContain(original.id)
    expect(context.text).toContain('unknown')
  })
})
