import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { embeddedPostgres } from '../fixtures/embedded-postgres'
import { tokenHash } from '../../server/src/auth/account-authority'
import { EnterpriseLearningWorkerAuthority } from '../../server/src/learning/learning-worker-authority'
import { EnterpriseLearningRepository } from '../../server/src/learning/learning-repository'
import { EnterpriseLearningQueue } from '../../server/src/learning/learning-queue'
import { EnterpriseLearningValidationBudget } from '../../server/src/learning/learning-validation-budget'
import { EnterpriseLearningValidationStore } from '../../server/src/learning/learning-validation-store'
import { EnterpriseLearningMaintenanceService } from '../../server/src/learning/learning-maintenance-service'
import { recordLearningForegroundWithin } from '../../server/src/learning/learning-account'
import { EnterpriseLearningMaintenanceWorker } from '../../server/src/learning/learning-maintenance-worker'
import type { PoolClient } from 'pg'
import type { LearningAccountAuthority } from '../../server/src/learning/learning-account'
import type { LearningReviewTransport } from '../../src/core/memory/learning-reviewer'

const DAY = 86400000
const reference = randomUUID()
let db: Awaited<ReturnType<typeof embeddedPostgres>>, now: number
let authority: EnterpriseLearningWorkerAuthority
let repository: EnterpriseLearningRepository<EnterpriseLearningWorkerAuthority>
let maintenance: EnterpriseLearningMaintenanceService
beforeAll(async () => {
  db = await embeddedPostgres('autoreply_learning_worker')
  authority = new EnterpriseLearningWorkerAuthority(db.db)
  repository = new EnterpriseLearningRepository(authority, { now: () => now })
  maintenance = new EnterpriseLearningMaintenanceService(authority, { now: () => now })
}, 20000)
afterAll(async () => {
  if (db) await db.db.close()
})
beforeEach(async () => {
  now = Date.UTC(2026, 9, 4, 12)
  await db.adminExec(
    "TRUNCATE tenants CASCADE; INSERT INTO tenants(id,name) VALUES('company','合成企业'); INSERT INTO employees(tenant_id,id,role) VALUES('company','employee','employee'); INSERT INTO accounts(tenant_id,id,employee_id,platform,paused) VALUES('company','account','employee','wework',false); INSERT INTO agents(tenant_id,id,account_id,employee_id,token_hash) VALUES('company','agent','account','employee','" +
      tokenHash('M'.repeat(43)) +
      "')"
  )
  const login = (await db.adminQuery('SELECT session_user AS login')).rows[0] as { login: string }
  await db.adminQuery(
    'INSERT INTO learning_worker_bindings(id,login_name,tenant_id,account_id,employee_id,agent_id,agent_token_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [reference, login.login, 'company', 'account', 'employee', 'agent', tokenHash('M'.repeat(43))]
  )
})
async function method(
  source: 'review' | 'human' = 'review',
  conversation: string | null = 'customer',
  guidance = '先确认型号和数量'
) {
  const episode = await repository.recordEpisode(reference, conversation, {
    sourceId: randomUUID(),
    topic: '询价',
    startedAt: now,
    messages: [],
    outcome: 'corrected',
    identityStatus: 'verified'
  })
  const memory = await repository.propose(reference, conversation, {
    content: {
      kind: 'lesson',
      scenario: '询价',
      guidance,
      rationale: '',
      steps: [],
      pitfalls: [],
      verification: []
    },
    evidence: [{ episodeId: episode.id }],
    source,
    reason: '合成人工教导'
  })
  await repository.activate(reference, conversation, memory.id, 1)
  return { episode, memory }
}
const mergeResponse = {
  text: JSON.stringify({
    content: {
      kind: 'lesson',
      scenario: '询价',
      guidance: '分别确认型号和数量，再查询有效资料',
      rationale: '合并两个核对步骤',
      steps: [],
      pitfalls: [],
      verification: []
    },
    reason: '同场景方法合并'
  }),
  usage: { inputTokens: 20, outputTokens: 10 }
}
async function merging(
  transport: LearningReviewTransport = { complete: async () => mergeResponse },
  fingerprint: () => string = () => 'host-model-1'
) {
  const originals = [
    await method('review', 'customer', '先确认型号'),
    await method('review', 'customer', '再确认数量')
  ]
  await maintenance.curate(reference, 'customer')
  await repository.settings(reference, 'customer', { curatorMergeEnabled: true })
  now += 14 * DAY
  const budget = new EnterpriseLearningValidationBudget(db.db, authority, { now: () => now })
  const service = new EnterpriseLearningMaintenanceService(authority, {
    now: () => now,
    merge: { budget, transport, workerId: 'synthetic-curator', fingerprint, monitorIntervalMs: 20 }
  })
  return { originals, service }
}
describe('enterprise opt-in model merge', () => {
  it('joins a cancelled merge and its late fee before allowing the worker database to close', async () => {
    let release!: (value: typeof mergeResponse) => void, entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const { service } = await merging({
      complete: () => {
        entered()
        return new Promise((resolve) => {
          release = resolve
        })
      }
    })
    const worker = new EnterpriseLearningMaintenanceWorker(service, {
      references: async () => [reference]
    })
    const running = worker.runOnce(reference)
    await started
    let shutdown: Promise<void> | undefined
    try {
      await worker.stop()
      expect(await running).toBe('cancelled')
      let drained = false
      shutdown = worker.shutdown().then(() => {
        drained = true
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(drained).toBe(false)
      expect(await repository.list(reference, 'customer')).toHaveLength(2)
    } finally {
      release(mergeResponse)
      await shutdown
      await worker.stop()
    }
    expect(
      await new EnterpriseLearningQueue(db.db, authority, { now: () => now }).usage(reference)
    ).toMatchObject({ reservedTokens: 30, reportedRequests: 1 })
    expect(await repository.list(reference, 'customer')).toHaveLength(2)
  })
  it.each([false, true])(
    'preserves a pending merge replacement requirement through human revision and rechecks pinned=%s',
    async (pinned) => {
      const { originals, service } = await merging()
      const id = (await service.curate(reference, 'customer')).items[0].proposedId!
      const old = (await repository.history(reference, 'customer', id))[0]
      await repository.revise(reference, 'customer', id, 1, {
        content: { ...old.content, guidance: '人工完善：先核对已有信息，再确认缺失的型号和数量' },
        source: 'human',
        evidence: old.evidence,
        reason: '人工完善合并步骤'
      })
      expect(await repository.replacements(reference, 'customer', id)).toHaveLength(2)
      if (pinned) {
        await repository.setPinned(reference, 'customer', originals[0].memory.id, 1, true)
        await expect(repository.activate(reference, 'customer', id, 2)).rejects.toThrow(
          'curation_replacement_changed'
        )
        expect((await repository.get(reference, 'customer', id)).activeRevision).toBe(null)
      } else {
        await repository.activate(reference, 'customer', id, 2)
        for (const original of originals)
          expect((await repository.get(reference, 'customer', original.memory.id)).state).toBe(
            'archived'
          )
      }
    }
  )
  it('rejects a human revision of a pending merge that omits one of its required evidence sources', async () => {
    const { service } = await merging()
    const id = (await service.curate(reference, 'customer')).items[0].proposedId!
    const old = (await repository.history(reference, 'customer', id))[0]
    await expect(
      repository.revise(reference, 'customer', id, 1, {
        content: { ...old.content, guidance: '缩减来源的修改' },
        source: 'human',
        evidence: old.evidence.slice(0, 1),
        reason: '合成不完整来源'
      })
    ).rejects.toThrow('curation_merge_evidence_incomplete')
    expect((await repository.get(reference, 'customer', id)).currentRevision).toBe(1)
  })
  it('does not renew exhausted merge attempts just because hourly retention bookkeeping runs again', async () => {
    const { service } = await merging({ complete: async () => ({ ...mergeResponse, text: '{}' }) })
    for (let index = 0; index < 3; index++) {
      await service.runOnce(reference)
      now += 15000
    }
    now += 3600000
    await service.runOnce(reference)
    expect(
      await new EnterpriseLearningQueue(db.db, authority, { now: () => now }).usage(reference)
    ).toMatchObject({ requests: 3 })
  })
  it('reports invalid model output as a failed maintenance worker outcome', async () => {
    const { service } = await merging({ complete: async () => ({ ...mergeResponse, text: '{}' }) })
    const worker = new EnterpriseLearningMaintenanceWorker(service, {
      references: async () => [reference]
    })
    try {
      expect(await worker.runOnce(reference)).toBe('failed')
    } finally {
      await worker.stop()
    }
  })
  it('allows a new host model fingerprint to retry after the old model exhausted its own durable attempts', async () => {
    let fingerprint = 'host-model-1'
    const { service } = await merging(
      {
        complete: async () =>
          fingerprint === 'host-model-1' ? { ...mergeResponse, text: '{}' } : mergeResponse
      },
      () => fingerprint
    )
    for (let index = 0; index < 3; index++) {
      expect(await service.curate(reference, 'customer')).toMatchObject({ status: 'failed' })
      now += 15000
    }
    expect(await service.curate(reference, 'customer')).toMatchObject({
      reason: 'curation_attempts_exhausted'
    })
    fingerprint = 'host-model-2'
    expect(await service.curate(reference, 'customer')).toMatchObject({ status: 'completed' })
  })
  it.each(['foreground', 'forget', 'off_restore', 'revoke', 'model'] as const)(
    'cancels a held merge after %s and settles the late response as fees only',
    async (change) => {
      let entered!: () => void,
        release!: (value: typeof mergeResponse) => void,
        observed: AbortSignal | undefined
      let fingerprint = 'host-model-1'
      const started = new Promise<void>((resolve) => {
        entered = resolve
      })
      const { service } = await merging(
        {
          complete: (_request, signal) => {
            observed = signal
            entered()
            return new Promise((resolve) => {
              release = resolve
            })
          }
        },
        () => fingerprint
      )
      const pending = service.curate(reference, 'customer').then(
        () => 'unexpected_success',
        (error: Error) => error.message
      )
      await started
      const chargedBefore = Number(
        (
          (await db.adminQuery('SELECT SUM(charged_tokens) AS fee FROM learning_attempts'))
            .rows[0] as { fee: number | string | null }
        ).fee
      )
      try {
        if (change === 'foreground')
          await authority.withLockedAccount(reference, (client, scope) =>
            recordLearningForegroundWithin(client, scope, now)
          )
        if (change === 'forget') await repository.forgetScope(reference, 'customer')
        if (change === 'off_restore') {
          await repository.settings(reference, 'customer', { mode: 'off' })
          await repository.settings(reference, 'customer', { mode: 'suggest' })
        }
        if (change === 'revoke')
          await db.adminExec("UPDATE agents SET revoked_at=clock_timestamp() WHERE id='agent'")
        if (change === 'model') fingerprint = 'host-model-2'
        await expect.poll(() => observed?.aborted, { timeout: 3000 }).toBe(true)
        expect(await pending).not.toBe('unexpected_success')
      } finally {
        release(mergeResponse)
      }
      await expect
        .poll(
          async () =>
            Number(
              (
                (
                  await db.adminQuery(
                    `SELECT COALESCE((SELECT SUM(charged_tokens) FROM learning_attempts),0)+COALESCE((SELECT SUM(charged_tokens) FROM learning_retained_usage),0) AS fee`
                  )
                ).rows[0] as { fee: number | string | null }
              ).fee
            ),
          { timeout: 3000 }
        )
        .toBe(change === 'forget' ? chargedBefore : 30)
      if (change === 'forget') {
        expect(
          (
            await db.adminQuery(
              'SELECT estimated_requests,reported_requests FROM learning_retained_usage'
            )
          ).rows[0]
        ).toEqual({ estimated_requests: 1, reported_requests: 0 })
        expect(
          (await db.adminQuery('SELECT count(*)::int AS n FROM learning_attempts')).rows[0]
        ).toEqual({ n: 0 })
      }
      expect(
        (await db.adminQuery('SELECT count(*)::int AS n FROM learning_curation_candidates')).rows[0]
      ).toEqual({ n: 0 })
      expect(
        (await db.adminQuery('SELECT count(*)::int AS n FROM learning_memory_replacements')).rows[0]
      ).toEqual({ n: 0 })
      expect(
        (await db.adminQuery('SELECT count(*)::int AS n FROM learning_memories')).rows[0]
      ).toEqual({ n: change === 'forget' ? 0 : 2 })
    }
  )
  it('activates and archives exact replacement revisions in one transaction and never reapplies consumed replacements', async () => {
    const { originals, service } = await merging()
    const id = (await service.curate(reference, 'customer')).items[0].proposedId!
    await repository.activate(reference, 'customer', id, 1)
    for (const original of originals)
      expect((await repository.get(reference, 'customer', original.memory.id)).state).toBe(
        'archived'
      )
    expect(
      (await db.adminQuery('SELECT applied_at FROM learning_memory_replacements')).rows
    ).toEqual([{ applied_at: now }, { applied_at: now }])
    await repository.restore(reference, 'customer', originals[0].memory.id, 1)
    await repository.activate(reference, 'customer', id, 1)
    expect((await repository.get(reference, 'customer', originals[0].memory.id)).state).toBe(
      'active'
    )
  })
  it.each(['pin', 'forget'] as const)(
    'refuses a candidate after an original is changed by %s without silently losing its replacement requirement',
    async (change) => {
      const { originals, service } = await merging()
      const id = (await service.curate(reference, 'customer')).items[0].proposedId!
      const oldId = originals[0].memory.id
      if (change === 'pin') await repository.setPinned(reference, 'customer', oldId, 1, true)
      else await repository.forget(reference, 'customer', oldId, 1)
      await expect(repository.activate(reference, 'customer', id, 1)).rejects.toThrow(
        'curation_replacement_changed'
      )
      expect((await repository.get(reference, 'customer', id)).activeRevision).toBe(null)
      expect((await repository.get(reference, 'customer', originals[1].memory.id)).state).toBe(
        'active'
      )
    }
  )
  it('rolls back activation, archives and consumed replacements when the replacement audit fails', async () => {
    const { originals, service } = await merging()
    const id = (await service.curate(reference, 'customer')).items[0].proposedId!
    await db.adminExec(
      `CREATE OR REPLACE FUNCTION fail_merge_archive() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='curator_replaced' THEN RAISE EXCEPTION 'synthetic_merge_audit_failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_merge_archive BEFORE INSERT ON learning_mutations FOR EACH ROW EXECUTE FUNCTION fail_merge_archive()`
    )
    try {
      await expect(repository.activate(reference, 'customer', id, 1)).rejects.toThrow(
        'synthetic_merge_audit_failure'
      )
      expect((await repository.get(reference, 'customer', id)).activeRevision).toBe(null)
      for (const original of originals)
        expect((await repository.get(reference, 'customer', original.memory.id)).state).toBe(
          'active'
        )
      expect(
        (await db.adminQuery('SELECT applied_at FROM learning_memory_replacements')).rows
      ).toEqual([{ applied_at: null }, { applied_at: null }])
    } finally {
      await db.adminExec(
        'DROP TRIGGER fail_merge_archive ON learning_mutations; DROP FUNCTION fail_merge_archive()'
      )
    }
  })
  it('previews a merge without model fees or changes and persists a pending candidate with every source and replacement revision', async () => {
    const { originals, service } = await merging()
    const preview = await service.curate(reference, 'customer', { dryRun: true })
    expect(preview.items.map((item) => item.action)).toEqual(['propose_merge', 'propose_merge'])
    expect(await repository.list(reference, 'customer')).toHaveLength(2)
    expect(
      await new EnterpriseLearningQueue(db.db, authority, { now: () => now }).usage(reference)
    ).toMatchObject({ requests: 0 })
    const report = await service.curate(reference, 'customer')
    expect(report.status).toBe('completed')
    const candidateId = report.items[0].proposedId!
    expect(candidateId).toBeTruthy()
    expect(await repository.get(reference, 'customer', candidateId)).toMatchObject({
      state: 'pending',
      activeRevision: null
    })
    expect((await repository.history(reference, 'customer', candidateId))[0]).toMatchObject({
      source: 'curator',
      evidence: expect.arrayContaining(originals.map((item) => ({ episodeId: item.episode.id })))
    })
    expect(await repository.replacements(reference, 'customer', candidateId)).toEqual(
      expect.arrayContaining(originals.map((item) => ({ memoryId: item.memory.id, revision: 1 })))
    )
    for (const item of originals)
      expect((await repository.get(reference, 'customer', item.memory.id)).state).toBe('active')
    expect(
      await new EnterpriseLearningQueue(db.db, authority, { now: () => now }).usage(reference)
    ).toMatchObject({ requests: 1, reservedTokens: 30, reportedRequests: 1 })
    expect((await db.adminQuery('SELECT purpose FROM learning_attempts')).rows).toEqual([
      { purpose: 'curation' }
    ])
    const restarted = new EnterpriseLearningMaintenanceService(authority, { now: () => now })
    expect(await restarted.reports(reference, 'customer')).toHaveLength(2)
  })
  it('refuses the whole candidate when an original is pinned while the model is processing, keeping the actual fee', async () => {
    let oldId = ''
    const { originals, service } = await merging({
      complete: async () => {
        await repository.setPinned(reference, 'customer', oldId, 1, true)
        return mergeResponse
      }
    })
    oldId = originals[0].memory.id
    await expect(service.curate(reference, 'customer')).rejects.toThrow('curation_context_changed')
    expect(await repository.list(reference, 'customer')).toHaveLength(2)
    expect(
      await new EnterpriseLearningQueue(db.db, authority, { now: () => now }).usage(reference)
    ).toMatchObject({ reservedTokens: 30 })
  })
  it('rejects extra model authority fields and caps repeated charged failures with durable backoff', async () => {
    const { service } = await merging({
      complete: async () => ({ ...mergeResponse, text: '{"activate":true,"archiveIds":[]}' })
    })
    for (let index = 0; index < 3; index++) {
      expect(await service.curate(reference, 'customer')).toMatchObject({
        status: 'failed',
        reason: 'curation_merge_response_invalid'
      })
      now += 15000
    }
    expect(await service.curate(reference, 'customer')).toMatchObject({
      status: 'waiting',
      reason: 'curation_attempts_exhausted'
    })
    expect(await repository.list(reference, 'customer')).toHaveLength(2)
    expect(
      await new EnterpriseLearningQueue(db.db, authority, { now: () => now }).usage(reference)
    ).toMatchObject({ requests: 3, reservedTokens: 90 })
  })
})
describe('enterprise durable curation and retention', () => {
  it('runs durable maintenance through a restartable worker and stops subsequent work', async () => {
    const { memory } = await method()
    const worker = new EnterpriseLearningMaintenanceWorker(maintenance, {
      references: () => authority.references()
    })
    expect(await worker.runOnce(reference)).toBe('completed')
    await worker.stop()
    now += 31 * DAY
    expect(await worker.runOnce(reference)).toBe('idle')
    expect((await repository.get(reference, 'customer', memory.id)).state).toBe('active')
    const restarted = new EnterpriseLearningMaintenanceWorker(maintenance, {
      references: () => authority.references()
    })
    try {
      expect(await restarted.runOnce(reference)).toBe('completed')
      expect((await repository.get(reference, 'customer', memory.id)).state).toBe('archived')
    } finally {
      await restarted.stop()
    }
  })
  it('initializes on first observation, then marks old unused methods stale and archives them without resetting the inactivity anchor', async () => {
    const { memory } = await method()
    now += 30 * DAY
    expect(await maintenance.curate(reference, 'customer')).toMatchObject({ status: 'initialized' })
    expect((await repository.get(reference, 'customer', memory.id)).state).toBe('active')
    now += 7 * DAY - 1
    expect(await maintenance.curate(reference, 'customer')).toMatchObject({
      status: 'waiting',
      reason: 'curation_interval_required'
    })
    now++
    const archived = await maintenance.curate(reference, 'customer')
    expect(archived).toMatchObject({
      status: 'completed',
      items: [{ memoryId: memory.id, action: 'archive' }]
    })
    expect((await repository.get(reference, 'customer', memory.id)).state).toBe('archived')
    await repository.restore(reference, 'customer', memory.id, 1)
    expect((await repository.get(reference, 'customer', memory.id)).state).toBe('active')
    expect(
      (await maintenance.reports(reference, 'customer')).map((report) => report.status)
    ).toEqual(['completed', 'initialized'])
  })
  it('uses exact fourteen-day grace and preserves the anchor when a stale transition is made', async () => {
    const { memory } = await method()
    await maintenance.curate(reference, 'customer')
    now += 7 * DAY
    expect((await maintenance.curate(reference, 'customer')).items[0]).toMatchObject({
      action: 'keep',
      reason: 'curation_new_item_grace'
    })
    now += 7 * DAY
    expect((await maintenance.curate(reference, 'customer')).items[0].action).toBe('stale')
    expect((await repository.get(reference, 'customer', memory.id)).updatedAt).toBe(
      Date.UTC(2026, 9, 4, 12)
    )
    now += 16 * DAY
    expect((await maintenance.curate(reference, 'customer')).items[0].action).toBe('archive')
  })
  it('protects human and pinned methods and counts actual use when deciding whether a method is idle', async () => {
    const human = await method('human', 'customer', '先确认型号'),
      pinned = await method('review', 'customer', '先确认数量'),
      used = await method('review', 'customer', '分别回答配送和报价')
    await repository.setPinned(reference, 'customer', pinned.memory.id, 1, true)
    await maintenance.curate(reference, 'customer')
    now += 31 * DAY
    await repository.registerGeneration(
      reference,
      'customer',
      'actual-generation',
      used.episode.id,
      [{ id: used.memory.id, revision: 1 }]
    )
    const report = await maintenance.curate(reference, 'customer')
    expect(report.items.find((item) => item.memoryId === human.memory.id)?.reason).toBe(
      'curation_protected'
    )
    expect(report.items.find((item) => item.memoryId === pinned.memory.id)?.reason).toBe(
      'curation_protected'
    )
    expect(report.items.find((item) => item.memoryId === used.memory.id)?.action).toBe('keep')
    expect((await repository.get(reference, 'customer', used.memory.id)).state).toBe('active')
  })
  it('requires two hours after actual account activity even if the weekly interval is met', async () => {
    await method()
    await maintenance.curate(reference, 'customer')
    now += 15 * DAY
    const activity = now
    await authority.withLockedAccount(reference, (client, scope) =>
      recordLearningForegroundWithin(client, scope, activity)
    )
    expect(await maintenance.curate(reference, 'customer')).toMatchObject({
      status: 'waiting',
      reason: 'curation_idle_required'
    })
    now += 7200000 - 1
    expect(await maintenance.curate(reference, 'customer')).toMatchObject({
      status: 'waiting',
      reason: 'curation_idle_required'
    })
    now++
    expect(await maintenance.curate(reference, 'customer')).toMatchObject({ status: 'completed' })
  })
  it('previews without initializing, changing a method or recording a report', async () => {
    const { memory } = await method()
    expect(await maintenance.curate(reference, 'customer', { dryRun: true })).toMatchObject({
      dryRun: true,
      status: 'initialized'
    })
    expect(await maintenance.reports(reference, 'customer')).toEqual([])
    await maintenance.curate(reference, 'customer')
    now += 31 * DAY
    expect(
      (await maintenance.curate(reference, 'customer', { dryRun: true })).items[0].action
    ).toBe('archive')
    expect((await repository.get(reference, 'customer', memory.id)).state).toBe('active')
    expect(await maintenance.reports(reference, 'customer')).toHaveLength(1)
    expect(
      await new EnterpriseLearningQueue(db.db, authority, { now: () => now }).usage(reference)
    ).toMatchObject({ requests: 0, reservedTokens: 0 })
  })
  it('shares the background slot with validation and reclaims only expired leases', async () => {
    const { memory } = await method()
    await maintenance.curate(reference, 'customer')
    now += 31 * DAY
    const budget = new EnterpriseLearningValidationBudget(db.db, authority, { now: () => now })
    const run = await budget.begin(reference, 'customer', 'validation', 'worker')
    expect(await maintenance.curate(reference, 'customer')).toMatchObject({
      status: 'waiting',
      reason: 'learning_background_busy'
    })
    expect((await repository.get(reference, 'customer', memory.id)).state).toBe('active')
    now += 35000
    expect(await maintenance.curate(reference, 'customer')).toMatchObject({ status: 'completed' })
    await expect(budget.assertCurrent(reference, run)).rejects.toThrow('validation_run_expired')
  })
  it('cleans expired case and calibration bodies while learning is off and invalidates methods with missing evidence', async () => {
    const { memory, episode } = await method()
    const validation = new EnterpriseLearningValidationStore(authority, {
      now: () => now,
      validatorVersion: 'synthetic'
    })
    await validation.importCalibration(reference, 'customer', {
      humanConfirmed: true,
      cases: [
        {
          caseId: 'label',
          conversationId: 'independent',
          input: '询价',
          humanLabelled: true,
          labelOrigin: 'human' as const, // Simulated human declaration for engineering tests only.
          expectedMethod: '确认型号',
          forbiddenClaims: []
        }
      ]
    })
    await repository.settings(reference, null, { mode: 'off' })
    now += 90 * DAY
    const outcome = await maintenance.runOnce(reference)
    expect(outcome.retention.find((report) => report.conversationId === 'customer')).toMatchObject({
      deletedEpisodes: 1,
      deletedCalibrationSets: 1,
      invalidatedMethods: [memory.id]
    })
    expect(await repository.episodes(reference, 'customer')).toEqual([])
    expect((await repository.get(reference, 'customer', memory.id)).state).toBe('stale')
    expect(
      (await repository.history(reference, 'customer', memory.id))[0].redactedEvidenceIds
    ).toEqual([episode.id])
    expect(await validation.calibration(reference, 'customer')).toEqual({ cases: [] })
    expect(await db.adminQuery('SELECT payload FROM learning_calibration_sets')).toMatchObject({
      rowCount: 0
    })
    expect(await maintenance.reports(reference, 'customer')).toEqual([])
  })
  it('persists hourly retention cadence across restart and does not repeatedly report deletion', async () => {
    await method()
    expect(
      (await maintenance.runOnce(reference)).retention.some(
        (report) => report.conversationId === 'customer'
      )
    ).toBe(true)
    const restarted = new EnterpriseLearningMaintenanceService(authority, { now: () => now })
    expect((await restarted.runOnce(reference)).retention).toEqual([])
    now += 3600000
    expect(
      (await restarted.runOnce(reference)).retention.some(
        (report) => report.conversationId === 'customer'
      )
    ).toBe(true)
  })
  it('rolls back method changes and scheduling when the audit write fails', async () => {
    const { memory } = await method()
    await maintenance.curate(reference, 'customer')
    now += 31 * DAY
    await db.adminExec('REVOKE INSERT ON learning_mutations FROM autoreply_app')
    try {
      await expect(maintenance.curate(reference, 'customer')).rejects.toThrow()
      expect((await repository.get(reference, 'customer', memory.id)).state).toBe('active')
      expect(await maintenance.reports(reference, 'customer')).toHaveLength(1)
    } finally {
      await db.adminExec('GRANT INSERT ON learning_mutations TO autoreply_app')
    }
    expect(await maintenance.curate(reference, 'customer')).toMatchObject({ status: 'completed' })
  })
  it('rolls back a completed SQL mutation if shutdown arrives while the final report write is awaiting completion', async () => {
    const { memory } = await method()
    await maintenance.curate(reference, 'customer')
    now += 31 * DAY
    let arrived!: () => void, release!: () => void
    const writingReport = new Promise<void>((resolve) => {
      arrived = resolve
    })
    const finishWrite = new Promise<void>((resolve) => {
      release = resolve
    })
    const guarded: LearningAccountAuthority = {
      withLockedAccount: (credential, operation, allowPaused) =>
        authority.withLockedAccount(
          credential,
          async (client, scope) => {
            const wrapped = {
              query: async (text: string, values?: unknown[]) => {
                const result = await client.query(text, values)
                if (text.startsWith('INSERT INTO learning_curation_reports')) {
                  arrived()
                  await finishWrite
                }
                return result
              }
            } as unknown as PoolClient
            return operation(wrapped, scope)
          },
          allowPaused
        )
    }
    const controller = new AbortController()
    const pending = new EnterpriseLearningMaintenanceService(guarded, { now: () => now }).curate(
      reference,
      'customer',
      {},
      controller.signal
    )
    try {
      await writingReport
      controller.abort('shutdown')
    } finally {
      release()
    }
    await expect(pending).rejects.toThrow('curation_cancelled')
    expect((await repository.get(reference, 'customer', memory.id)).state).toBe('active')
    expect(await maintenance.reports(reference, 'customer')).toHaveLength(1)
  })
  it('forgets maintenance state and reports and rejects revoked or cancelled work', async () => {
    await method()
    await maintenance.curate(reference, 'customer')
    await repository.forgetScope(reference, 'customer')
    expect(await maintenance.reports(reference, 'customer')).toEqual([])
    expect(
      await db.adminQuery("SELECT * FROM learning_curation_state WHERE conversation_id='customer'")
    ).toMatchObject({ rowCount: 0 })
    const signal = AbortSignal.abort('shutdown')
    await expect(maintenance.curate(reference, null, {}, signal)).rejects.toThrow(
      'curation_cancelled'
    )
    await db.adminExec(
      "UPDATE agents SET revoked_at=clock_timestamp() WHERE tenant_id='company' AND id='agent'"
    )
    await expect(maintenance.runOnce(reference)).rejects.toThrow()
  })
})
