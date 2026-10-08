import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { listenFetchLoopback } from '../fixtures/fetch-loopback'
import { embeddedPostgres } from '../fixtures/embedded-postgres'
import { taskFixture } from '../fixtures/task'
import { AccountAuthority, tokenHash } from '../../server/src/auth/account-authority'
import { EnterpriseLearningRepository } from '../../server/src/learning/learning-repository'
import { EnterpriseLearningManagement } from '../../server/src/learning/learning-service'
import { createApplication } from '../../server/src/http/application'
import { enterpriseDraftSource } from '../../server/src/learning/learning-generation-context'
import type { LearningEpisode } from '../../src/shared/contracts/learning-memory'
import { z } from 'zod'
import { AgentRegistration } from '../../src/main/services/agent-registration'
import { Ledger } from '../../src/core/persistence/ledger'
import { DesktopAgentRuntime } from '../../src/main/services/desktop-agent-runtime'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

let db: Awaited<ReturnType<typeof embeddedPostgres>>,
  authority: AccountAuthority,
  server: Server,
  base: string,
  now: number,
  original: LearningEpisode
const token = 'A'.repeat(43),
  other = 'B'.repeat(43)
const fixture = taskFixture()
const reference = {
  taskId: fixture.task.taskId,
  contextHash: fixture.task.contextHash,
  draftHash: fixture.draft.draftHash,
  draftRevision: fixture.draft.draftRevision
}
const correction = {
  reference,
  sourceId: 'correction-1',
  text: '先核对订单状态，再查询当前退款政策。',
  reason: '原回复遗漏订单状态核对'
}
beforeAll(async () => {
  db = await embeddedPostgres()
  await db.adminExec(
    "INSERT INTO tenants(id,name) VALUES('company','合成企业'); INSERT INTO employees(tenant_id,id,role) VALUES('company','employee-A','employee'),('company','employee-B','employee'); INSERT INTO accounts(tenant_id,id,employee_id,platform,paused) VALUES('company','account-A','employee-A','wework',false),('company','account-B','employee-B','wework',false)"
  )
  for (const [credential, suffix] of [
    [token, 'A'],
    [other, 'B']
  ])
    await db.adminQuery(
      'INSERT INTO agents(tenant_id,id,account_id,employee_id,token_hash) VALUES($1,$2,$3,$4,$5)',
      [
        'company',
        `agent-${suffix}`,
        `account-${suffix}`,
        `employee-${suffix}`,
        tokenHash(credential)
      ]
    )
  await db.adminQuery(
    'INSERT INTO agents(tenant_id,id,account_id,employee_id,token_hash) VALUES($1,$2,$3,$4,$5)',
    ['company', 'agent-C', 'account-A', 'employee-A', tokenHash('C'.repeat(43))]
  )
  authority = new AccountAuthority(db.db)
  server = createServer(
    createApplication(authority, {
      learning: new EnterpriseLearningManagement(db.db, authority, { now: () => now })
    })
  )
  base = await listenFetchLoopback(server)
}, 20000)
afterAll(async () => {
  if (server) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  if (db) await db.db.close()
})
beforeEach(async () => {
  now = Date.now()
  fixture.task.createdAt = now - 1000
  fixture.task.expiresAt = now + 10000
  await db.adminExec(
    'TRUNCATE learning_episodes,learning_memories,learning_settings,learning_tombstones,learning_jobs,learning_mutations,generation_tasks,audit_events CASCADE; UPDATE agents SET revoked_at=NULL; UPDATE accounts SET paused=false'
  )
  const repository = new EnterpriseLearningRepository(authority, { now: () => now })
  original = await repository.recordEpisode(token, fixture.task.conversationId, {
    sourceId: enterpriseDraftSource(fixture.task),
    topic: '退款核对',
    startedAt: now,
    messages: [{ sourceId: 'customer-1', role: 'customer', text: '可以退款吗？' }],
    draft: fixture.draft.text,
    outcome: 'unknown',
    identityStatus: 'verified'
  })
  await repository.registerGeneration(
    token,
    fixture.task.conversationId,
    enterpriseDraftSource(fixture.task),
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
        status: 'handoff',
        automaticAllowed: false,
        factsVerified: false,
        reasons: [],
        intents: [],
        draft: fixture.draft,
        usage: { input_tokens: 0, output_tokens: 0 }
      })
    ]
  )
})
const post = (operation: string, input: unknown, credential = token) =>
  fetch(`${base}/v1/learning/${operation}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(input)
  })

it('resolves work-memory episode feedback to the actual saved task, including derived cases', async () => {
  const input = {
    conversationId: fixture.task.conversationId,
    episodeId: original.id,
    sourceId: 'window-correction',
    text: correction.text,
    reason: correction.reason
  }
  const saved = await post('episode-correction', input)
  expect(saved.status).toBe(200)
  const revised = (await saved.json()) as LearningEpisode
  expect(revised).toMatchObject({
    draft: fixture.draft.text,
    correction: correction.text,
    outcome: 'corrected',
    createdAt: original.createdAt
  })
  expect(await (await post('episode-correction', input)).json()).toEqual(revised)
  const client = new AgentRegistration(
    {
      load: () => ({
        serverUrl: base,
        encryptedCredential: 'cipher',
        scope: {
          tenant_id: 'company',
          account_id: 'account-A',
          employee_id: 'employee-A',
          agent_id: 'agent-A',
          platform: 'wework'
        }
      }),
      save: () => {}
    },
    { available: () => true, encrypt: () => '', decrypt: () => token },
    fetch,
    true
  )
  expect(
    await client.learningEpisodeCorrection({
      scope: original.scope,
      episodeId: original.id,
      sourceId: input.sourceId,
      text: input.text,
      reason: input.reason
    })
  ).toEqual(revised)
  await client.learningEpisodeFeedback({
    scope: original.scope,
    episodeId: revised.id,
    sourceId: 'client-adopted',
    kind: 'adopted',
    reason: '员工确认'
  })
  expect(
    await client.learningEpisodeResult({
      scope: original.scope,
      episodeId: revised.id,
      sourceId: 'client-result',
      outcome: 'resolved',
      reason: '员工核实'
    })
  ).toMatchObject({ draft: fixture.draft.text, outcome: 'resolved' })
  const resolved = await post('episode-result', {
    conversationId: fixture.task.conversationId,
    episodeId: revised.id,
    sourceId: 'window-result',
    outcome: 'resolved',
    reason: '员工核实'
  })
  expect(resolved.status).toBe(200)
  expect(await resolved.json()).toMatchObject({
    draft: fixture.draft.text,
    correction: correction.text,
    outcome: 'resolved'
  })
  expect(
    (
      await post('episode-feedback', {
        conversationId: fixture.task.conversationId,
        episodeId: revised.id,
        sourceId: 'window-adopted',
        kind: 'adopted',
        reason: '员工明确采用'
      })
    ).status
  ).toBe(200)
  expect((await post('episode-correction', { ...input, sourceId: 'foreign' }, other)).status).toBe(
    404
  )
  expect(
    (
      await post('episode-correction', {
        ...input,
        conversationId: 'other-customer',
        sourceId: 'wrong-customer'
      })
    ).status
  ).toBe(404)
  expect(
    (await post('episode-correction', { ...input, reference, sourceId: 'forged' })).status
  ).toBe(400)
  expect((await post('episode-correction', { ...input, text: 'changed retry' })).status).toBe(409)
  await post('forget-scope', { conversationId: fixture.task.conversationId })
  expect((await post('episode-correction', input)).status).toBe(404)
  const counts = await db.adminQuery('SELECT count(*)::text AS n FROM execution_permits')
  expect(z.object({ n: z.string() }).parse(counts.rows[0]).n).toBe('0')
})

it('allows another authorized device to correct the exact source but rejects manual cases and changed saved drafts', async () => {
  const input = {
    conversationId: fixture.task.conversationId,
    episodeId: original.id,
    sourceId: 'second-device',
    text: correction.text,
    reason: correction.reason
  }
  expect((await post('episode-correction', input, 'C'.repeat(43))).status).toBe(200)
  const repository = new EnterpriseLearningRepository(authority, { now: () => now })
  const manual = await repository.recordEpisode(token, fixture.task.conversationId, {
    sourceId: 'human-case',
    topic: '退款核对',
    startedAt: now,
    messages: [],
    draft: fixture.draft.text,
    outcome: 'unknown',
    identityStatus: 'verified'
  })
  expect(
    (
      await post('episode-correction', {
        ...input,
        episodeId: manual.id,
        sourceId: 'manual-pretends-task'
      })
    ).status
  ).toBe(404)
  await db.adminQuery(
    "UPDATE generation_tasks SET result_json=jsonb_set(result_json,'{draft,text}',to_jsonb('tampered'::text)) WHERE tenant_id=$1 AND account_id=$2 AND task_id=$3",
    ['company', 'account-A', fixture.task.taskId]
  )
  expect(
    (await post('episode-correction', { ...input, sourceId: 'saved-draft-changed' })).status
  ).toBe(409)
  await db.adminQuery(
    "UPDATE agents SET revoked_at=clock_timestamp() WHERE tenant_id='company' AND id='agent-C'"
  )
  expect((await post('episode-correction', input, 'C'.repeat(43))).status).toBe(401)
})

it('reads nonempty enterprise management state and forgets it through the actual desktop HTTP client', async () => {
  const client = new AgentRegistration(
    {
      load: () => ({
        serverUrl: base,
        encryptedCredential: 'ciphertext',
        scope: {
          tenant_id: 'company',
          account_id: 'account-A',
          employee_id: 'employee-A',
          agent_id: 'agent-A',
          platform: 'wework'
        }
      }),
      save: () => {}
    },
    { available: () => true, encrypt: () => '', decrypt: () => token },
    fetch,
    true
  )
  await client.recordLearningCorrection(fixture.task, fixture.draft, {
    sourceId: correction.sourceId,
    text: correction.text,
    reason: correction.reason
  })
  const snapshot = await client.learningSnapshot(original.scope)
  expect(snapshot.episodes).toHaveLength(2)
  expect(snapshot.jobs).toHaveLength(1)
  expect(snapshot.jobs[0].scope).toEqual(original.scope)
  const content = {
    kind: 'lesson' as const,
    scenario: '退款核对',
    guidance: '先核对订单状态，再查询当前政策。',
    rationale: '避免遗漏核对',
    steps: [],
    pitfalls: [],
    verification: []
  }
  const taught = await client.learningManual(original.scope, {
    sourceId: 'manual-http',
    content,
    reason: '员工教导'
  })
  now += 1
  expect(
    await client.learningManual(original.scope, {
      sourceId: 'manual-http',
      content,
      reason: '员工教导'
    })
  ).toEqual(taught)
  const detail = await client.learningDetail(original.scope, taught.id)
  expect(detail.memory).toEqual(taught)
  expect(detail.history).toHaveLength(1)
  expect((await client.learningSnapshot(original.scope)).memories[0].record.id).toBe(taught.id)
  expect((await client.learningSearch(original.scope, '退款')).length).toBeGreaterThan(0)
  expect(
    await client.learningCalibration(original.scope, { cases: [], humanConfirmed: true })
  ).toMatchObject({ cases: [], authorId: 'employee-A' })
  expect(await client.learningCalibration(original.scope)).toMatchObject({ cases: [] })
  expect(await client.learningReports(original.scope)).toEqual({ validation: [], curation: [] })
  const queued = await client.learningReview(original.scope, {
    episodeId: original.id,
    sourceId: 'manual-review-http'
  })
  expect(queued.jobId).not.toBeNull()
  await client.learningCancel(original.scope, queued.jobId!)
  expect(
    (await client.learningSnapshot(original.scope)).jobs.find((job) => job.id === queued.jobId)
      ?.state
  ).toBe('cancelled')
  expect(
    await client.learningAct({
      scope: original.scope,
      action: 'pin',
      id: taught.id,
      expectedRevision: 1,
      pinned: true
    })
  ).toMatchObject({ pinned: true })
  expect(
    await client.learningAct({
      scope: original.scope,
      action: 'forget',
      id: taught.id,
      expectedRevision: 1
    })
  ).toBeNull()
  expect(await client.learningSettings(original.scope, { caseRetentionDays: 7 })).toMatchObject({
    caseRetentionDays: 7
  })
  const local = new Ledger(':memory:'),
    runtime = new DesktopAgentRuntime(local, client)
  try {
    local.learning.enqueue({
      task: fixture.task,
      draft: fixture.draft,
      kind: 'correction',
      input: { sourceId: 'pending-at-forget', text: correction.text, reason: correction.reason },
      at: now
    })
    await runtime.forgetLearningScope(original.scope)
    expect(local.learning.state(fixture.task.identity, 'pending-at-forget')).toBe('forgotten')
    expect(local.learning.pending(fixture.task.identity)).toEqual([])
  } finally {
    await runtime.close()
  }
  expect((await client.learningSnapshot(original.scope)).episodes).toEqual([])
  await expect(
    client.recordLearningCorrection(fixture.task, fixture.draft, {
      sourceId: 'late-after-forget',
      text: correction.text,
      reason: correction.reason
    })
  ).rejects.toBeDefined()
  expect((await client.learningSnapshot(original.scope)).episodes).toEqual([])
  expect((await db.adminQuery('SELECT * FROM execution_permits')).rows).toEqual([])
})
async function feedbackKinds(): Promise<string[]> {
  return z
    .array(z.object({ payload: z.object({ kind: z.string() }) }))
    .parse(
      (
        await db.adminQuery(
          "SELECT payload FROM learning_feedback ORDER BY payload->>'kind',source_id"
        )
      ).rows
    )
    .map((row) => row.payload.kind)
}
describe('trusted task-bound enterprise learning events', () => {
  it('replays a persisted desktop event after response loss and process restart with one server case and one review job', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'learning-events-')),
      path = join(directory, 'ledger.sqlite')
    const cleanupPath = resolve(directory),
      cleanupPrefix = resolve(tmpdir()) + sep + 'learning-events-'
    if (!cleanupPath.startsWith(cleanupPrefix)) throw new Error('unexpected_learning_fixture')
    const task = fixture.task
    let loseResponse = true,
      requests = 0
    const client = new AgentRegistration(
      {
        load: () => ({
          serverUrl: base,
          scope: {
            tenant_id: 'company',
            account_id: 'account-A',
            employee_id: 'employee-A',
            agent_id: 'agent-A',
            platform: 'wework'
          },
          encryptedCredential: 'synthetic-ciphertext'
        }),
        save: () => {}
      },
      { available: () => true, encrypt: () => '', decrypt: () => token },
      async (url, options) => {
        const correctionRequest = new URL(String(url)).pathname === '/v1/learning/correction'
        if (correctionRequest) requests++
        const response = await fetch(url, options)
        if (loseResponse && correctionRequest) {
          loseResponse = false
          await response.arrayBuffer()
          throw new Error('synthetic response lost after commit')
        }
        return response
      },
      true
    )
    let first: DesktopAgentRuntime | undefined, recovered: DesktopAgentRuntime | undefined
    try {
      const ledger = new Ledger(path)
      ledger.replies.begin(task, ['退款咨询'], now)
      ledger.replies.update(
        task.identity,
        task.taskId,
        { status: 'ready', draft: fixture.draft },
        now
      )
      first = new DesktopAgentRuntime(ledger, client)
      const row = first.workbench().rows[0]
      expect(
        await first.workbenchLearn({
          taskId: row.taskId,
          expectedVersion: row.version,
          kind: 'correction',
          input: { sourceId: correction.sourceId, text: correction.text, reason: correction.reason }
        })
      ).toMatchObject({ success: true, state: 'pending' })
      expect((await db.adminQuery('SELECT * FROM learning_task_events')).rows).toHaveLength(1)
      expect(ledger.learning.pending(task.identity)).toHaveLength(1)
      await first.close()
      const reopened = new Ledger(path)
      recovered = new DesktopAgentRuntime(reopened, client)
      await recovered.flushLearning()
      expect(requests).toBe(2)
      expect(reopened.learning.pending(task.identity)).toEqual([])
      expect(reopened.learning.state(task.identity, correction.sourceId)).toBe('saved')
      expect((await db.adminQuery('SELECT * FROM learning_task_events')).rows).toHaveLength(1)
      expect((await db.adminQuery('SELECT * FROM learning_episodes')).rows).toHaveLength(2)
      expect((await db.adminQuery('SELECT * FROM learning_jobs')).rows).toHaveLength(1)
      expect((await feedbackKinds()).sort()).toEqual(['loaded', 'substantially_corrected'])
      expect((await db.adminQuery('SELECT * FROM execution_permits')).rows).toHaveLength(0)
      await recovered.close()
      const inspection = new DatabaseSync(path, { readOnly: true })
      try {
        expect(inspection.prepare('SELECT payload FROM learning_outbox').get()?.payload).toBeNull()
      } finally {
        inspection.close()
      }
    } finally {
      await first?.close()
      await recovered?.close()
      if (cleanupPath.startsWith(cleanupPrefix))
        rmSync(cleanupPath, { recursive: true, force: true })
    }
  })
  it('accepts the actual desktop main-process correction/result/feedback client over authenticated HTTP', async () => {
    const client = new AgentRegistration(
      {
        load: () => ({
          serverUrl: base,
          scope: {
            tenant_id: 'company',
            account_id: 'account-A',
            employee_id: 'employee-A',
            agent_id: 'agent-A',
            platform: 'wework'
          },
          encryptedCredential: 'synthetic-ciphertext'
        }),
        save: () => {}
      },
      { available: () => true, encrypt: () => '', decrypt: () => token },
      fetch,
      true
    )
    const corrected = await client.recordLearningCorrection(fixture.task, fixture.draft, {
      sourceId: correction.sourceId,
      text: correction.text,
      reason: correction.reason
    })
    expect(corrected).toMatchObject({ outcome: 'corrected', correction: correction.text })
    const resolved = await client.recordLearningResult(fixture.task, fixture.draft, {
      sourceId: 'client-result',
      outcome: 'resolved',
      reason: '员工明确核验结果'
    })
    expect(resolved).toMatchObject({ outcome: 'resolved', correction: correction.text })
    await client.recordLearningFeedback(fixture.task, fixture.draft, {
      sourceId: 'client-adoption',
      kind: 'adopted',
      reason: '员工明确采纳'
    })
    expect(
      (await db.adminQuery('SELECT kind FROM learning_task_events ORDER BY event_sequence')).rows
    ).toEqual([{ kind: 'correction' }, { kind: 'result' }, { kind: 'feedback' }])
    expect((await db.adminQuery('SELECT * FROM execution_permits')).rows).toHaveLength(0)
  })
  it('carries the actual employee correction into a later explicit resolved case', async () => {
    expect((await post('correction', correction)).status).toBe(200)
    const latest = {
      ...correction,
      sourceId: 'correction-2',
      text: '核对订单，再核对政策版本，无法确认时转人工。',
      reason: '追加政策版本核对'
    }
    expect((await post('correction', latest)).status).toBe(200)
    now += 1000
    const response = await post('result', {
      reference,
      sourceId: 'resolved-after-correction',
      outcome: 'resolved',
      reason: '员工核验问题已解决'
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      outcome: 'resolved',
      correction: latest.text,
      correctionReason: latest.reason,
      draft: fixture.draft.text
    })
  })
  it('only queues repeated quality failure after two distinct explicit reports', async () => {
    const input = {
      reference,
      sourceId: 'repeat-1',
      kind: 'repeated_question',
      reason: '仍未回答客户问题'
    }
    expect((await post('feedback', input)).status).toBe(200)
    expect((await db.adminQuery('SELECT * FROM learning_jobs')).rows).toHaveLength(0)
    expect((await post('feedback', input)).status).toBe(200)
    expect((await db.adminQuery('SELECT * FROM learning_jobs')).rows).toHaveLength(0)
    expect((await post('feedback', { ...input, sourceId: 'repeat-2' })).status).toBe(200)
    expect((await db.adminQuery('SELECT payload FROM learning_jobs')).rows).toMatchObject([
      { payload: { triggers: ['repeated_failure'], episodeIds: [original.id] } }
    ])
  })
  it('quarantines the actually loaded method on explicit fact error and queues severe review', async () => {
    const repository = new EnterpriseLearningRepository(authority, { now: () => now })
    const memory = await repository.propose(token, fixture.task.conversationId, {
      content: {
        kind: 'lesson',
        scenario: '退款核对',
        guidance: '先确认订单状态',
        rationale: '',
        steps: [],
        pitfalls: [],
        verification: []
      },
      evidence: [{ episodeId: original.id }],
      source: 'human',
      reason: '合成方法'
    })
    await repository.activate(token, fixture.task.conversationId, memory.id, 1)
    await db.adminExec('DELETE FROM learning_generations; DELETE FROM learning_feedback')
    await repository.registerGeneration(
      token,
      fixture.task.conversationId,
      enterpriseDraftSource(fixture.task),
      original.id,
      [{ id: memory.id, revision: 1 }]
    )
    expect(
      (
        await post('feedback', {
          reference,
          sourceId: 'fact-error',
          kind: 'fact_error',
          reason: '人工核实事实错误',
          memoryId: memory.id
        })
      ).status
    ).toBe(200)
    expect(await repository.get(token, fixture.task.conversationId, memory.id)).toMatchObject({
      state: 'stale'
    })
    expect(
      (await db.adminQuery('SELECT memory_id,revision FROM learning_quarantines')).rows
    ).toEqual([{ memory_id: memory.id, revision: 1 }])
    expect((await db.adminQuery('SELECT payload FROM learning_jobs')).rows).toMatchObject([
      { payload: { triggers: ['severe_error'], episodeIds: [original.id] } }
    ])
  })
  it('records a correction once across clock changes and queues the actual source atomically', async () => {
    const first = await post('correction', correction)
    expect(first.status).toBe(200)
    const episode = await first.json()
    expect(episode).toMatchObject({
      outcome: 'corrected',
      draft: fixture.draft.text,
      correction: correction.text,
      correctionReason: correction.reason,
      scope: { accountId: 'account-A', conversationId: fixture.task.conversationId }
    })
    now += 1000
    expect(await (await post('correction', correction)).json()).toEqual(episode)
    const jobs = z
      .array(
        z.object({
          payload: z.object({ episodeIds: z.array(z.string()), triggers: z.array(z.string()) })
        })
      )
      .parse((await db.adminQuery('SELECT payload FROM learning_jobs')).rows)
    expect(jobs).toHaveLength(1)
    expect(jobs[0].payload.episodeIds).toEqual([episode.id])
    expect(jobs[0].payload.triggers).toEqual(['correction'])
    expect((await db.adminQuery('SELECT * FROM learning_task_events')).rows).toHaveLength(1)
    expect(
      (await db.adminQuery('SELECT payload FROM learning_episodes WHERE id=$1', [original.id]))
        .rows[0]
    ).toMatchObject({ payload: { outcome: 'unknown' } })
    expect((await post('correction', { ...correction, text: '不同纠正' })).status).toBe(409)
  })
  it('rejects forged identity, changed drafts, foreign tasks, missing references and revoked devices without saving', async () => {
    for (const extra of [
      { scope: {} },
      { conversationId: 'someone-else' },
      { problemId: 'forged' },
      { memoryRefs: [] }
    ])
      expect((await post('correction', { ...correction, ...extra })).status).toBe(400)
    expect(
      (
        await post('correction', {
          ...correction,
          reference: { ...reference, draftHash: 'b'.repeat(64) }
        })
      ).status
    ).toBe(409)
    expect((await post('correction', correction, other)).status).toBe(404)
    expect(
      (await post('correction', { ...correction, reference: { ...reference, taskId: 'unknown' } }))
        .status
    ).toBe(404)
    await db.adminExec("UPDATE agents SET revoked_at=clock_timestamp() WHERE id='agent-A'")
    expect((await post('correction', correction)).status).toBe(401)
    expect((await db.adminQuery('SELECT * FROM learning_task_events')).rows).toHaveLength(0)
    expect((await db.adminQuery('SELECT * FROM learning_jobs')).rows).toHaveLength(0)
  })
  it('allows explicit historical results while paused without inferring adoption or sending', async () => {
    await db.adminExec("UPDATE accounts SET paused=true WHERE id='account-A'")
    const response = await post('result', {
      reference,
      sourceId: 'result-1',
      outcome: 'handoff',
      reason: '员工明确转交人工'
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ outcome: 'handoff' })
    expect(await feedbackKinds()).toEqual(['loaded', 'outcome_confirmed'])
    expect((await db.adminQuery('SELECT * FROM execution_permits')).rows).toHaveLength(0)
  })
  it('requires explicit adoption and verifies feedback refers to actually loaded methods', async () => {
    const input = { reference, sourceId: 'adoption-1', kind: 'adopted', reason: '员工明确采纳' }
    expect((await post('feedback', { ...input, memoryId: 'not-loaded' })).status).toBe(409)
    expect((await post('feedback', input)).status).toBe(200)
    now += 1000
    expect((await post('feedback', input)).status).toBe(200)
    expect(
      (
        await db.adminQuery(
          "SELECT payload FROM learning_feedback WHERE payload->>'kind'='adopted'"
        )
      ).rows
    ).toHaveLength(1)
    expect((await db.adminQuery('SELECT * FROM learning_jobs')).rows).toHaveLength(0)
  })
  it('rolls back derived evidence, queue and feedback when event audit persistence fails', async () => {
    await db.adminExec(
      "CREATE FUNCTION autoreply.reject_task_learning_event() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'learning_event_audit_failed';END$$; CREATE TRIGGER reject_task_learning_event BEFORE INSERT ON learning_task_events FOR EACH ROW EXECUTE FUNCTION autoreply.reject_task_learning_event()"
    )
    try {
      expect((await post('correction', correction)).status).toBe(503)
      expect((await db.adminQuery('SELECT * FROM learning_episodes')).rows).toHaveLength(1)
      expect((await db.adminQuery('SELECT * FROM learning_jobs')).rows).toHaveLength(0)
      expect(await feedbackKinds()).toEqual(['loaded'])
    } finally {
      await db.adminExec(
        'DROP TRIGGER reject_task_learning_event ON learning_task_events; DROP FUNCTION autoreply.reject_task_learning_event()'
      )
    }
  })
  it('does not extend original evidence retention or resurrect a forgotten task through delayed feedback', async () => {
    now += 89 * 86400000
    expect((await post('correction', correction)).status).toBe(200)
    now += 2 * 86400000
    const repository = new EnterpriseLearningRepository(authority, { now: () => now })
    expect(
      (await repository.pruneExpired(token, fixture.task.conversationId)).deletedEpisodes
    ).toBe(2)
    expect((await post('correction', correction)).status).toBe(404)
    expect((await db.adminQuery('SELECT * FROM learning_task_events')).rows).toHaveLength(0)
    expect((await db.adminQuery('SELECT * FROM learning_episodes')).rows).toHaveLength(0)
  })
})
