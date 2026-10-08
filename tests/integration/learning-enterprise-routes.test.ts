import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { embeddedPostgres } from '../fixtures/embedded-postgres'
import { AccountAuthority, tokenHash } from '../../server/src/auth/account-authority'
import { createApplication } from '../../server/src/http/application'
import { EnterpriseLearningManagement } from '../../server/src/learning/learning-service'
import type { LearningWorkbenchSnapshot } from '../../src/shared/contracts/learning-desktop'
import type { MemoryRecord } from '../../src/shared/contracts/learning-memory'
import { AgentRegistration } from '../../src/main/services/agent-registration'
import { DesktopAgentRuntime } from '../../src/main/services/desktop-agent-runtime'
import { Ledger } from '../../src/core/persistence/ledger'
import { LearningStore } from '../../src/core/memory/learning-store'
import { LearningService } from '../../src/main/services/learning-service'
import { learningHash } from '../../src/core/memory/learning-scope'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath, sep } from 'node:path'
let dropNextManualResponse = false

let db: Awaited<ReturnType<typeof embeddedPostgres>>, server: Server, base: string, now: number
const credentials = ['A'.repeat(43), 'B'.repeat(43)]
let modelDirectory = [{ id: 'host-review', label: '企业复盘模型' }]
const content = {
  kind: 'lesson',
  scenario: '设备询价',
  guidance: '先确认型号和数量',
  rationale: '',
  steps: [],
  pitfalls: [],
  verification: []
}
const manual = {
  conversationId: 'same-customer',
  sourceId: 'employee-teaching',
  content,
  reason: '员工明确教导'
}
beforeAll(async () => {
  db = await embeddedPostgres()
  await db.adminExec(
    "INSERT INTO tenants(id,name) VALUES('company','合成企业'); INSERT INTO employees(tenant_id,id,role) VALUES('company','employee-A','employee'),('company','employee-B','employee'); INSERT INTO accounts(tenant_id,id,employee_id,platform,paused) VALUES('company','account-A','employee-A','wework',false),('company','account-B','employee-B','wework',false)"
  )
  for (const [index, suffix] of ['A', 'B'].entries())
    await db.adminQuery(
      'INSERT INTO agents(tenant_id,id,account_id,employee_id,token_hash) VALUES($1,$2,$3,$4,$5)',
      [
        'company',
        `agent-${suffix}`,
        `account-${suffix}`,
        `employee-${suffix}`,
        tokenHash(credentials[index])
      ]
    )
  const authority = new AccountAuthority(db.db)
  const learning = new EnterpriseLearningManagement(db.db, authority, {
    now: () => now,
    modelDirectory: () => modelDirectory
  })
  const application = createApplication(authority, { learning })
  server = createServer((request, response) => {
    if (dropNextManualResponse && request.url === '/v1/learning/manual') {
      response.end = () => {
        dropNextManualResponse = false
        response.destroy()
        return response
      }
    }
    application(request, response)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 20000)
afterAll(async () => {
  if (server) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  if (db) await db.db.close()
})
beforeEach(async () => {
  dropNextManualResponse = false
  now = Date.now()
  modelDirectory = [{ id: 'host-review', label: '企业复盘模型' }]
  await db.adminExec(
    'TRUNCATE learning_context_epochs,learning_preparations,learning_versions,learning_episodes,learning_memories,learning_settings,learning_feedback,learning_generations,learning_tombstones,learning_mutations,learning_jobs,learning_job_events,learning_attempts,learning_background_leases,learning_retained_usage,learning_calibration_sets,learning_validation_reports,learning_validation_environments,learning_curation_reports,learning_curation_state CASCADE; UPDATE agents SET revoked_at=NULL; UPDATE accounts SET paused=false'
  )
})
function post(operation: string, input: unknown, credential = credentials[0]) {
  return fetch(`${base}/v1/learning/${operation}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credential}` },
    body: JSON.stringify(input)
  })
}
async function teach(input = manual, credential = credentials[0]): Promise<MemoryRecord> {
  const response = await post('manual', input, credential)
  expect(response.status).toBe(200)
  return (await response.json()) as MemoryRecord
}
describe('enterprise learning management over real HTTP and scoped PostgreSQL storage', () => {
  it('recovers a desktop journal after a committed HTTP response is lost and the host restarts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'learning-http-restart-')),
      path = join(root, 'ledger.sqlite')
    const local = new LearningStore(':memory:')
    const service = new LearningService(
      local,
      { review: async () => ({ operations: [], usage: { inputTokens: 0, outputTokens: 0 } }) },
      { workspaceId: 'local' }
    )
    const client = new AgentRegistration(
      {
        load: () => ({
          serverUrl: base,
          encryptedCredential: 'fixture',
          scope: {
            tenant_id: 'company',
            employee_id: 'employee-A',
            account_id: 'account-A',
            agent_id: 'agent-A',
            platform: 'wework'
          }
        }),
        save: () => {}
      },
      { available: () => true, encrypt: () => '', decrypt: () => credentials[0] },
      fetch,
      true
    )
    const scope = {
      workspaceId: `enterprise:${learningHash({ tenant: 'company', account: 'account-A' })}`,
      tenantId: 'company',
      accountId: 'account-A',
      platform: 'wework' as const,
      conversationId: manual.conversationId
    }
    const request = {
      kind: 'manual' as const,
      input: {
        scope,
        sourceId: '11111111-1111-4111-8111-111111111111',
        content: { ...content, kind: 'lesson' as const },
        reason: manual.reason
      }
    }
    if (!resolvePath(root).startsWith(resolvePath(tmpdir()) + sep + 'learning-http-restart-'))
      throw new Error('unexpected_fixture')
    let runtime: DesktopAgentRuntime | undefined
    try {
      runtime = new DesktopAgentRuntime(new Ledger(path), client)
      runtime.configureLearningSubmissions(service)
      dropNextManualResponse = true
      expect(await runtime.submitLearning(request)).toMatchObject({
        state: 'pending',
        errorCode: 'network_unavailable'
      })
      const original = (await (
        await post('snapshot', { conversationId: manual.conversationId })
      ).json()) as LearningWorkbenchSnapshot
      expect(original.memories).toHaveLength(1)
      expect(original.episodes).toHaveLength(1)
      await runtime.close()
      runtime = new DesktopAgentRuntime(new Ledger(path), client)
      runtime.configureLearningSubmissions(service)
      expect(await runtime.submitLearning(request)).toMatchObject({ state: 'saved' })
      const recovered = (await (
        await post('snapshot', { conversationId: manual.conversationId })
      ).json()) as LearningWorkbenchSnapshot
      expect(recovered.memories.map((row) => row.record.id)).toEqual(
        original.memories.map((row) => row.record.id)
      )
      expect(recovered.episodes).toHaveLength(1)
      expect(runtime.learningSubmissions(scope)).toMatchObject([
        { sourceId: request.input.sourceId, state: 'saved' }
      ])
    } finally {
      await runtime?.close()
      service.stop()
      local.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('opens exact scoped evidence and refuses another customer, account, expired or forgotten evidence', async () => {
    const memory = await teach()
    const detail = await (
      await post('detail', { conversationId: manual.conversationId, id: memory.id })
    ).json()
    const input = {
      conversationId: manual.conversationId,
      episodeId: detail.history[0].evidence[0].episodeId
    }
    await post('settings', { conversationId: null, patch: { memoryEnabled: false } })
    const response = await post('episode', input)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      id: input.episodeId,
      topic: content.scenario,
      correctionReason: manual.reason
    })
    expect((await post('episode', { ...input, conversationId: 'other-customer' })).status).toBe(404)
    expect((await post('episode', input, credentials[1])).status).toBe(404)
    const originalTime = now
    now += 91 * 86400000
    expect((await post('episode', input)).status).toBe(404)
    now = originalTime
    await post('forget-scope', { conversationId: manual.conversationId })
    expect((await post('episode', input)).status).toBe(404)
  })
  it('serves an authenticated host model directory and rejects stale or forged model selections atomically', async () => {
    const directory = await post('model-directory', { conversationId: manual.conversationId })
    expect(directory.status).toBe(200)
    expect(await directory.json()).toEqual([{ id: 'host-review', label: '企业复盘模型' }])
    expect((await post('model-directory', { conversationId: null }, '')).status).toBe(401)
    expect(
      (await post('model-directory', { conversationId: null, accountId: 'account-B' })).status
    ).toBe(400)
    const changed = await post('settings', {
      conversationId: null,
      patch: { reviewModelId: 'host-review', dailyReviewTokenBudget: 9000, caseRetentionDays: 7 }
    })
    expect(changed.status).toBe(200)
    expect(await changed.json()).toMatchObject({
      reviewModelId: 'host-review',
      dailyReviewTokenBudget: 9000,
      caseRetentionDays: 7
    })
    modelDirectory = []
    const rejected = await post('settings', {
      conversationId: null,
      patch: { reviewModelId: 'host-review', caseRetentionDays: 30 }
    })
    expect(rejected.status).toBe(409)
    expect(await rejected.json()).toMatchObject({ error: 'review_model_unavailable' })
    expect(await (await post('settings', { conversationId: null })).json()).toMatchObject({
      reviewModelId: 'host-review',
      caseRetentionDays: 7
    })
    expect(
      (await post('settings', { conversationId: null, patch: { reviewModelId: '' } })).status
    ).toBe(200)
    await db.adminQuery('UPDATE agents SET revoked_at=clock_timestamp() WHERE id=$1', ['agent-A'])
    expect((await post('model-directory', { conversationId: null })).status).toBe(401)
  })
  it('supports human activation, pending edits, rollback and pin protection through the shared action contract', async () => {
    const memory = await teach()
    const act = (command: Record<string, unknown>) =>
      post('action', { conversationId: manual.conversationId, command })
    expect(
      await (await act({ action: 'activate', id: memory.id, expectedRevision: 1 })).json()
    ).toMatchObject({ activeRevision: 1, currentRevision: 1 })
    const detail = await (
      await post('detail', { conversationId: manual.conversationId, id: memory.id })
    ).json()
    expect(
      await (
        await act({
          action: 'revise',
          id: memory.id,
          expectedRevision: 1,
          content: { ...content, guidance: '先核对型号，再核对数量' },
          evidence: detail.history[0].evidence,
          reason: '员工修订方法'
        })
      ).json()
    ).toMatchObject({ activeRevision: 1, currentRevision: 2 })
    expect(
      await (await act({ action: 'activate', id: memory.id, expectedRevision: 2 })).json()
    ).toMatchObject({ activeRevision: 2 })
    expect(
      await (
        await act({ action: 'rollback', id: memory.id, expectedRevision: 2, targetRevision: 1 })
      ).json()
    ).toMatchObject({ activeRevision: 3, currentRevision: 3, content })
    expect(
      await (await act({ action: 'pin', id: memory.id, expectedRevision: 3, pinned: true })).json()
    ).toMatchObject({ pinned: true })
    expect(
      (
        await act({
          action: 'revise',
          id: memory.id,
          expectedRevision: 3,
          content,
          evidence: detail.history[0].evidence,
          reason: '不得修改固定项'
        })
      ).status
    ).toBe(409)
  })
  it('derives account identity and consistent snapshots from the credential, including same-named customers', async () => {
    const first = await teach()
    await teach(
      { ...manual, content: { ...content, guidance: '另一个账号的经验' } },
      credentials[1]
    )
    const response = await post('snapshot', { conversationId: manual.conversationId })
    expect(response.status).toBe(200)
    const snapshot = (await response.json()) as LearningWorkbenchSnapshot
    expect(snapshot.scope).toMatchObject({
      tenantId: 'company',
      accountId: 'account-A',
      conversationId: manual.conversationId
    })
    expect(snapshot.memories.map((item) => item.record.id)).toEqual([first.id])
    expect(snapshot.episodes).toHaveLength(1)
    expect(snapshot.usage).toMatchObject({ requests: 0 })
    expect(snapshot.unassigned).toEqual([])
    expect(snapshot.settings.mode).toBe('suggest')
  })
  it('requires bearer authentication and rejects invented scope, source authority and activation proof', async () => {
    expect((await post('snapshot', {}, '')).status).toBe(401)
    for (const bad of [
      { tenantId: 'victim' },
      { scope: { accountId: 'victim' } },
      { workerReference: 'forged' }
    ])
      expect((await post('snapshot', bad)).status).toBe(400)
    expect((await post('manual', { ...manual, source: 'review' })).status).toBe(400)
    const memory = await teach()
    for (const extra of [
      { grantId: 'fake' },
      { source: 'review' },
      { scope: {} },
      { validated: true }
    ])
      expect(
        (
          await post('action', {
            conversationId: manual.conversationId,
            command: { action: 'activate', id: memory.id, expectedRevision: 1, ...extra }
          })
        ).status
      ).toBe(400)
    expect((await post('snapshot', {}, 'X'.repeat(43))).status).toBe(401)
  })
  it('refuses cross-account or cross-customer details and stale revisions without mutation', async () => {
    const memory = await teach()
    expect(
      (
        await post(
          'detail',
          { conversationId: manual.conversationId, id: memory.id },
          credentials[1]
        )
      ).status
    ).toBe(404)
    expect((await post('detail', { conversationId: 'other-customer', id: memory.id })).status).toBe(
      404
    )
    const stale = await post('action', {
      conversationId: manual.conversationId,
      command: { action: 'activate', id: memory.id, expectedRevision: 2 }
    })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toEqual({ error: 'memory_revision_conflict' })
    const response = await post('detail', { conversationId: manual.conversationId, id: memory.id })
    expect(await response.json()).toMatchObject({
      memory: { state: 'pending', currentRevision: 1 }
    })
  })
  it('persists manual provenance atomically and retries teaching idempotently across changed host time', async () => {
    const memory = await teach()
    now += 1000
    expect((await teach()).id).toBe(memory.id)
    expect((await post('manual', { ...manual, reason: 'same source changed' })).status).toBe(409)
    const snapshot = (await (
      await post('snapshot', { conversationId: manual.conversationId })
    ).json()) as LearningWorkbenchSnapshot
    expect(snapshot.episodes).toHaveLength(1)
    expect(snapshot.memories).toHaveLength(1)
    const detail = await (
      await post('detail', { conversationId: manual.conversationId, id: memory.id })
    ).json()
    expect(detail.history[0]).toMatchObject({
      source: 'manual',
      evidence: [{ episodeId: snapshot.episodes[0].id }]
    })
    await db.adminExec('REVOKE INSERT ON learning_mutations FROM autoreply_app')
    try {
      expect(
        (
          await post('manual', {
            ...manual,
            sourceId: 'failed-teaching',
            content: { ...content, guidance: '不得留下部分案例' }
          })
        ).status
      ).toBe(503)
      expect(
        (await (await post('snapshot', { conversationId: manual.conversationId })).json()).episodes
      ).toHaveLength(1)
    } finally {
      await db.adminExec('GRANT INSERT ON learning_mutations TO autoreply_app')
    }
  })
  it('honors parent switches and reauthorizes paused management and revoked devices', async () => {
    expect((await post('settings', { patch: { mode: 'off', memoryEnabled: false } })).status).toBe(
      200
    )
    await post('settings', {
      conversationId: manual.conversationId,
      patch: { mode: 'auto', memoryEnabled: true }
    })
    expect(
      await (await post('settings', { conversationId: manual.conversationId })).json()
    ).toMatchObject({ mode: 'off', memoryEnabled: false })
    await db.adminExec("UPDATE accounts SET paused=true WHERE id='account-A'")
    expect((await post('snapshot', {})).status).toBe(200)
    await db.adminExec("UPDATE agents SET revoked_at=clock_timestamp() WHERE id='agent-A'")
    expect((await post('snapshot', {})).status).toBe(401)
  })
  it('uses authenticated human calibration authors and exposes reports without an issue-grant route', async () => {
    const input = {
      humanConfirmed: true,
      cases: [
        {
          caseId: 'label',
          conversationId: 'independent',
          input: '询价',
          expectedMethod: '核对型号',
          forbiddenClaims: [],
          humanLabelled: true,
          labelOrigin: 'human' as const // Simulated human declaration for engineering tests only.
        }
      ]
    }
    expect(
      (
        await post('calibration', {
          conversationId: manual.conversationId,
          input: { ...input, authorId: 'administrator' }
        })
      ).status
    ).toBe(400)
    const imported = await post('calibration', { conversationId: manual.conversationId, input })
    expect(imported.status).toBe(200)
    expect(await imported.json()).toMatchObject({ authorId: 'employee-A', cases: input.cases })
    expect(await (await post('reports', { conversationId: manual.conversationId })).json()).toEqual(
      { validation: [], curation: [] }
    )
    expect((await post('issue-grant', { result: 'passed' })).status).toBe(404)
    expect(
      (
        await post('validate', {
          conversationId: manual.conversationId,
          id: 'candidate',
          expectedRevision: 1
        })
      ).status
    ).toBe(503)
  })
  it('queues manual reviews once, cancels only owned jobs and reports durable status', async () => {
    await teach()
    const snapshot = (await (
      await post('snapshot', { conversationId: manual.conversationId })
    ).json()) as LearningWorkbenchSnapshot
    const input = {
      conversationId: manual.conversationId,
      episodeId: snapshot.episodes[0].id,
      sourceId: 'manual-review'
    }
    const first = await (await post('review', input)).json()
    expect(await (await post('review', input)).json()).toEqual(first)
    expect(
      (
        await post(
          'cancel',
          { conversationId: manual.conversationId, jobId: first.jobId },
          credentials[1]
        )
      ).status
    ).toBe(404)
    expect(
      (await post('cancel', { conversationId: manual.conversationId, jobId: first.jobId })).status
    ).toBe(200)
    expect(
      (await (await post('snapshot', { conversationId: manual.conversationId })).json()).jobs
    ).toMatchObject([{ state: 'cancelled' }])
  })
  it('orders validation reports by creation time instead of random report UUIDs', async () => {
    const memory = await teach()
    const ids = ['ffffffff-ffff-4fff-8fff-ffffffffffff', '00000000-0000-4000-8000-000000000001']
    for (const [index, id] of ids.entries())
      await db.adminQuery(
        'INSERT INTO learning_validation_reports VALUES($1,$2,$3,$4,$5,1,$6::jsonb)',
        [
          'company',
          'account-A',
          manual.conversationId,
          id,
          memory.id,
          JSON.stringify({
            id,
            memoryId: memory.id,
            revision: 1,
            createdAt: now + index,
            result: { status: 'insufficient', reasons: ['synthetic-report'] }
          })
        ]
      )
    const reports = await (await post('reports', { conversationId: manual.conversationId })).json()
    expect(reports.validation.map((report: { id: string }) => report.id)).toEqual(
      [...ids].reverse()
    )
  })
  it('finds only authorized retained cases and removes all results after forgetting', async () => {
    await teach()
    const search = { conversationId: manual.conversationId, query: '型号', limit: 10 }
    expect(await (await post('search', search)).json()).toHaveLength(1)
    expect(await (await post('search', search, credentials[1])).json()).toEqual([])
    expect(await (await post('search', { ...search, query: '不相关内容' })).json()).toEqual([])
    expect((await post('search', { ...search, limit: 21 })).status).toBe(400)
    now += 90 * 86400000
    expect(await (await post('search', search)).json()).toEqual([])
    now -= 90 * 86400000
    expect((await post('forget-scope', { conversationId: manual.conversationId })).status).toBe(200)
    expect(await (await post('search', search)).json()).toEqual([])
    expect((await post('manual', manual)).status).toBe(409)
  })
})
