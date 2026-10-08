import { randomUUID } from 'node:crypto'
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest'
import { embeddedPostgres } from '../fixtures/embedded-postgres'
import { tokenHash } from '../../server/src/auth/account-authority'
import { EnterpriseLearningWorkerAuthority } from '../../server/src/learning/learning-worker-authority'
import { EnterpriseLearningRepository } from '../../server/src/learning/learning-repository'
import { EnterpriseLearningQueue } from '../../server/src/learning/learning-queue'
import {
  EnterpriseLearningValidationBudget,
  EnterpriseBudgetedValidationTransport,
  createEnterpriseValidationFetch
} from '../../server/src/learning/learning-validation-budget'
import { HttpTextGenerator } from '../../server/src/generation/text-generator'
import { TypeSafeClient } from '../../server/src/decision/typesafe-client'
import { jevRequest, jevResponse } from '../fixtures/jev'
import { taskFixture } from '../fixtures/task'
import { EnterpriseLearningValidationStore } from '../../server/src/learning/learning-validation-store'

let db: Awaited<ReturnType<typeof embeddedPostgres>>, now: number
let budget: EnterpriseLearningValidationBudget, queue: EnterpriseLearningQueue
let repository: EnterpriseLearningRepository<EnterpriseLearningWorkerAuthority>
const reference = randomUUID()
beforeAll(async () => {
  db = await embeddedPostgres('autoreply_learning_worker')
  const authority = new EnterpriseLearningWorkerAuthority(db.db)
  budget = new EnterpriseLearningValidationBudget(db.db, authority, { now: () => now })
  queue = new EnterpriseLearningQueue(db.db, authority, { now: () => now })
  repository = new EnterpriseLearningRepository(authority, { now: () => now })
}, 20000)
afterAll(async () => {
  if (db) await db.db.close()
})
beforeEach(async () => {
  now = Date.UTC(2026, 9, 4, 12)
  await db.adminExec(
    "TRUNCATE tenants CASCADE; INSERT INTO tenants(id,name) VALUES('company','合成企业'); INSERT INTO employees(tenant_id,id,role) VALUES('company','employee','employee'); INSERT INTO accounts(tenant_id,id,employee_id,platform,paused) VALUES('company','account-A','employee','wework',false); INSERT INTO agents(tenant_id,id,account_id,employee_id,token_hash) VALUES('company','agent-A','account-A','employee','" +
      tokenHash('V'.repeat(43)) +
      "')"
  )
  const login = ((await db.adminQuery('SELECT session_user AS login')).rows[0] as { login: string })
    .login
  await db.adminQuery(
    'INSERT INTO learning_worker_bindings(id,login_name,tenant_id,account_id,employee_id,agent_id,agent_token_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [reference, login, 'company', 'account-A', 'employee', 'agent-A', tokenHash('V'.repeat(43))]
  )
})
async function enqueue() {
  const source = await repository.recordEpisode(reference, 'customer', {
    sourceId: 'case',
    topic: '报价',
    startedAt: now,
    messages: [],
    outcome: 'corrected',
    correction: '先确认型号'
  })
  await queue.enqueue(reference, 'customer', source.id, 'correction', 'review-event')
  now += 15000
}
describe('enterprise validation shared lease and fee authority', () => {
  it('renews a short lease per admitted request instead of holding the account for hours after a crashed large calibration', async () => {
    const startedAt = now
    const run = await budget.begin(reference, 'customer', 'large-calibration', 'worker', 1201)
    expect(run.leaseUntil).toBe(startedAt + 35000)
    now += 30000
    await budget.reserve(reference, run, 100, 200)
    now = startedAt + 35000
    await expect(budget.assertCurrent(reference, run)).resolves.toBeUndefined()
    now = startedAt + 65000
    await expect(budget.assertCurrent(reference, run)).rejects.toThrow('validation_run_expired')
  })
  it('backs off failed validation runs and caps attempts for the same candidate source', async () => {
    const first = await budget.begin(reference, 'customer', 'retry-source', 'worker')
    await budget.end(reference, first, 'failed')
    now += 4999
    await expect(budget.begin(reference, 'customer', 'retry-source', 'worker')).rejects.toThrow(
      'validation_retry_not_ready'
    )
    now++
    const second = await budget.begin(reference, 'customer', 'retry-source', 'worker')
    await budget.end(reference, second, 'failed')
    now += 10000
    const third = await budget.begin(reference, 'customer', 'retry-source', 'worker')
    await budget.end(reference, third, 'failed')
    now += 60000
    await expect(budget.begin(reference, 'customer', 'retry-source', 'worker')).rejects.toThrow(
      'attempt_limit'
    )
  })
  it('accounts for the actual text generator and Jev HTTP contracts', async () => {
    const run = await budget.begin(reference, 'customer', 'production-protocols', 'worker')
    const upstream = vi.fn(async () =>
      Response.json({
        model: 'synthetic-text',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: JSON.stringify({ text: '请提供型号', evidenceIds: ['faq-1'] })
            }
          }
        ],
        usage: { prompt_tokens: 15, completion_tokens: 10 }
      })
    )
    const textFetch = createEnterpriseValidationFetch(
      'text',
      budget,
      reference,
      run,
      upstream,
      'synthetic-text'
    )
    const generator = new HttpTextGenerator({
      apiKey: 'synthetic-key',
      baseUrl: 'https://model.example/v1/',
      model: 'synthetic-text',
      expectedModel: 'synthetic-text',
      fetch: textFetch
    })
    const draft = await generator.generate({
      identity: taskFixture().task.identity,
      conversationId: 'customer',
      inbound: ['我要询价'],
      intents: ['price'],
      evidence: [
        {
          evidenceId: 'faq-1',
          tenantId: 'company',
          accountId: 'account-A',
          intent: 'price',
          knowledgeVersion: 'knowledge-1',
          kind: 'approved_faq',
          content: '报价前需要型号',
          source: '合成 FAQ',
          approvedBy: 'employee',
          validFrom: now - 1000,
          expiresAt: now + 60000
        }
      ],
      processReference: '先询问型号'
    })
    expect(draft).toEqual({ text: '请提供型号', evidenceIds: ['faq-1'] })
    expect(await queue.usage(reference)).toMatchObject({ reservedTokens: 25, reportedRequests: 1 })
    const jevFetch = createEnterpriseValidationFetch('jev', budget, reference, run, async () =>
      Response.json(jevResponse)
    )
    expect(
      await new TypeSafeClient({
        apiKey: 'synthetic-jev-key',
        fetch: jevFetch,
        maxAttempts: 1
      }).evaluate(jevRequest)
    ).toEqual(jevResponse)
    expect(await queue.usage(reference)).toMatchObject({ reservedTokens: 240, reportedRequests: 2 })
  })
  it('marks a request not dispatched when authority checking fails after reservation', async () => {
    const run = await budget.begin(reference, 'customer', 'not-dispatched', 'worker')
    const upstream = { complete: vi.fn(async () => ({ text: '不应调用' })) }
    const transport = new EnterpriseBudgetedValidationTransport(budget, reference, run, upstream)
    const check = vi
      .spyOn(budget, 'assertCurrent')
      .mockRejectedValueOnce(new Error('learning_foreground_preempted'))
    try {
      await expect(
        transport.complete(
          { system: '系统', user: '测试', maxInputTokens: 8000, maxOutputTokens: 100 },
          new AbortController().signal
        )
      ).rejects.toThrow('learning_foreground_preempted')
      expect(upstream.complete).not.toHaveBeenCalled()
      expect(await queue.usage(reference)).toMatchObject({ reservedTokens: 0, requests: 0 })
    } finally {
      check.mockRestore()
    }
  })
  it('checks the validation lease inside the grant transaction rather than before it', async () => {
    const authority = new EnterpriseLearningWorkerAuthority(db.db)
    const store = new EnterpriseLearningValidationStore(authority, {
      now: () => now,
      validatorVersion: 'synthetic-guard'
    })
    await db.adminExec(
      "INSERT INTO published_configurations(tenant_id,account_id,config_version,knowledge_version,policy_version,questions_version,model_resolved) VALUES('company','account-A','config','knowledge','policy','questions','synthetic')"
    )
    const source = await repository.recordEpisode(reference, 'customer', {
      sourceId: 'guard-case',
      topic: '报价',
      startedAt: now,
      messages: [],
      correction: '先询问型号',
      outcome: 'corrected',
      identityStatus: 'verified'
    })
    const memory = await repository.propose(reference, 'customer', {
      source: 'review',
      content: {
        kind: 'lesson',
        scenario: '报价前',
        guidance: '先询问型号',
        rationale: '',
        steps: [],
        pitfalls: [],
        verification: []
      },
      evidence: [{ episodeId: source.id }],
      reason: '纠正'
    })
    const cases = Array.from({ length: 5 }, (_, index) => ({
      caseId: `case-${index}`,
      conversationId: `held-${index}`,
      input: '报价',
      expectedMethod: '型号',
      forbiddenClaims: [],
      humanLabelled: true,
      labelOrigin: 'human' as const // Simulated human declaration for engineering tests only.
    }))
    await store.importCalibration(reference, 'customer', { cases, humanConfirmed: true })
    const run = await budget.begin(reference, 'customer', 'guard-run', 'worker')
    const port = await store.bind(reference, 'customer', async (client, scope, at) => {
      await budget.assertCurrentWithin(client, scope, run, at)
    })
    const snapshot = await port.validation.capture(port.scope, memory.id, 1)
    await queue.recordForegroundActivity(reference)
    await expect(
      port.validation.issue(snapshot, {
        baselineCovered: 0,
        candidateCovered: 5,
        caseIds: cases.map((entry) => entry.caseId)
      })
    ).rejects.toThrow('learning_foreground_preempted')
    expect(await store.grants(reference, 'customer', memory.id)).toEqual([])
  })
  it('shares one account lease with reviewer and reserves each actual call against the common budget', async () => {
    await enqueue()
    const run = await budget.begin(reference, 'customer', 'validation-source', 'worker')
    expect(await queue.claim(reference, 'reviewer')).toBeNull()
    await expect(budget.begin(reference, 'customer', 'other-source', 'worker-2')).rejects.toThrow(
      'learning_background_busy'
    )
    const call = await budget.reserve(reference, run, 100, 50)
    expect(await queue.usage(reference)).toMatchObject({
      reservedTokens: 150,
      estimatedRequests: 1
    })
    expect(
      await call.settleUsage({ inputTokens: 20, outputTokens: 10, measurement: 'reported' })
    ).toBe(true)
    expect(await queue.usage(reference)).toMatchObject({ reservedTokens: 30, reportedRequests: 1 })
    await budget.end(reference, run, 'completed')
    expect(await queue.claim(reference, 'reviewer')).not.toBeNull()
  })
  it('records request-start UTC day, retains failure bounds, and cannot overspend with a new validation call', async () => {
    await repository.settings(reference, 'customer', { dailyReviewTokenBudget: 1000 })
    now = Date.UTC(2026, 9, 4, 23, 59, 59)
    const run = await budget.begin(reference, 'customer', 'utc-run', 'worker')
    const call = await budget.reserve(reference, run, 800, 200)
    await expect(budget.reserve(reference, run, 1, 1)).rejects.toThrow(
      'validation_budget_exhausted'
    )
    now += 2000
    await call.settleUsage({ inputTokens: 25, outputTokens: 10, measurement: 'reported' })
    expect(await queue.usage(reference)).toMatchObject({ reservedTokens: 0, requests: 0 })
    expect(
      (
        await db.adminQuery(
          "SELECT to_char(day,'YYYY-MM-DD') AS day,charged_tokens::int AS tokens FROM learning_attempts"
        )
      ).rows
    ).toEqual([{ day: '2026-10-04', tokens: 35 }])
    await budget.end(reference, run, 'completed')
  })
  it('detects foreground start/end at the same clock and does not dispatch a reserved late call', async () => {
    const run = await budget.begin(reference, 'customer', 'preempt', 'worker')
    await queue.recordForegroundActivity(reference)
    await expect(budget.reserve(reference, run, 100, 50)).rejects.toThrow(
      'learning_foreground_preempted'
    )
    await budget.end(reference, run, 'cancelled')
    await expect(budget.begin(reference, 'customer', 'fresh', 'worker')).rejects.toThrow(
      'learning_not_idle'
    )
    now += 15000
    expect(await budget.begin(reference, 'customer', 'fresh', 'worker')).toBeDefined()
  })
  it('reclaims a crashed validation lease before review and keeps its dispatched calls charged', async () => {
    await enqueue()
    const run = await budget.begin(reference, 'customer', 'crashed', 'worker')
    await budget.reserve(reference, run, 100, 50)
    now = run.leaseUntil
    expect(await queue.claim(reference, 'reviewer')).not.toBeNull()
    expect((await db.adminQuery('SELECT state FROM learning_validation_runs')).rows).toEqual([
      { state: 'timed_out' }
    ])
    expect(
      (
        await db.adminQuery(
          "SELECT state,charged_tokens::int AS charged FROM learning_attempts WHERE purpose='validation'"
        )
      ).rows
    ).toEqual([{ state: 'timed_out', charged: 150 }])
    await expect(budget.assertCurrent(reference, run)).rejects.toThrow('validation_run_expired')
  })
  it('keeps accounting-only settlement after revocation but forgetting retains only anonymous bounds', async () => {
    const run = await budget.begin(reference, 'customer', 'forget-me', 'worker')
    const call = await budget.reserve(reference, run, 100, 50)
    await db.adminExec('UPDATE agents SET revoked_at=clock_timestamp()')
    await expect(budget.assertCurrent(reference, run)).rejects.toThrow('DENIED')
    expect(
      await call.settleUsage({ inputTokens: 20, outputTokens: 10, measurement: 'reported' })
    ).toBe(true)
    await db.adminExec('UPDATE agents SET revoked_at=NULL')
    await repository.forgetScope(reference, 'customer')
    expect(
      await call.settleUsage({ inputTokens: 20, outputTokens: 10, measurement: 'reported' })
    ).toBe(false)
    expect(await queue.usage(reference)).toMatchObject({ reservedTokens: 30, requests: 1 })
    await expect(budget.begin(reference, 'customer', 'forget-me', 'worker')).rejects.toThrow(
      'validation_run_forgotten'
    )
    expect(
      (await db.adminQuery('SELECT count(*)::int AS n FROM learning_validation_runs')).rows
    ).toEqual([{ n: 0 }])
  })
  it('cancels a noncooperative transport promptly and only settles its late usage', async () => {
    const run = await budget.begin(reference, 'customer', 'late-response', 'worker')
    let resolve!: (result: {
      text: string
      usage: { inputTokens: number; outputTokens: number }
    }) => void
    const upstream = {
      complete: async () =>
        new Promise<{ text: string; usage: { inputTokens: number; outputTokens: number } }>(
          (done) => {
            resolve = done
          }
        )
    }
    const transport = new EnterpriseBudgetedValidationTransport(budget, reference, run, upstream)
    const controller = new AbortController()
    const pending = transport.complete(
      {
        system: '系统',
        user: '测试',
        maxInputTokens: 8000,
        maxOutputTokens: 100,
        reviewModelId: ''
      },
      controller.signal
    )
    while (!resolve) await new Promise((done) => setTimeout(done, 5))
    controller.abort()
    await expect(pending).rejects.toThrow('validation_cancelled')
    await budget.end(reference, run, 'cancelled')
    resolve({ text: '迟到', usage: { inputTokens: 10, outputTokens: 5 } })
    for (
      let count = 0;
      count < 100 && (await queue.usage(reference)).reservedTokens !== 15;
      count++
    )
      await new Promise((done) => setTimeout(done, 5))
    expect(await queue.usage(reference)).toMatchObject({ reservedTokens: 15, reportedRequests: 1 })
    expect((await db.adminQuery('SELECT state FROM learning_validation_runs')).rows).toEqual([
      { state: 'cancelled' }
    ])
  })
})
