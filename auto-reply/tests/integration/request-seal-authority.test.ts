import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { embeddedPostgres } from '../fixtures/embedded-postgres'
import { taskFixture } from '../fixtures/task'
import { AccountAuthority, tokenHash } from '../../server/src/auth/account-authority'
import { Administration } from '../../server/src/admin/administration'
import { ExecutionAuthority } from '../../server/src/execution/execution-authority'
import { RequestSealAuthority } from '../../server/src/execution/request-seal-authority'
import { createApplication } from '../../server/src/http/application'
import { AgentRegistration } from '../../src/main/services/agent-registration'
import { DesktopAgentRuntime } from '../../src/main/services/desktop-agent-runtime'
import { Ledger } from '../../src/core/persistence/ledger'
import { hashContext } from '../../src/core/reply/hashes'
import { requestNonDispatchProof } from '../../src/core/sending/request-seal-proof'
import type { RequestSealInput } from '../../src/shared/contracts/request-seal'
import { WorkbenchReconciliationResultSchema } from '../../src/shared/contracts/workbench'

const f = taskFixture(),
  i = f.task.identity,
  token = 'A'.repeat(43),
  otherToken = 'B'.repeat(43)
const request = {
  taskId: f.task.taskId,
  taskHash: hashContext(f.task),
  draftHash: f.draft.draftHash,
  draftRevision: f.draft.draftRevision,
  loginEpoch: i.loginEpoch,
  clientInstanceId: i.clientInstanceId,
  leaseVersion: 7
}
let pg: Awaited<ReturnType<typeof embeddedPostgres>>,
  service: RequestSealAuthority,
  authority: AccountAuthority,
  admin: Administration,
  execution: ExecutionAuthority,
  server: Server,
  origin: string
const runtimes: DesktopAgentRuntime[] = []
async function privileged(text: string) {
  await pg.sql.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE')
  await pg.sql.exec(text)
}
async function login(name = 'autoreply_app') {
  await pg.sql.exec(
    `SET SESSION AUTHORIZATION postgres; RESET ROLE; SET SESSION AUTHORIZATION ${name}`
  )
}
function input(): RequestSealInput {
  const base = { executionId: randomUUID(), identity: i, request }
  return {
    ...base,
    verificationProofHash: requestNonDispatchProof(base),
    stopped: {
      stoppedAt: Date.now(),
      observerStopped: true,
      senderQuiescent: true,
      settlementQuiescent: true,
      leaseStopped: true,
      verifiedDriverStopped: true
    }
  }
}
function client(transport: typeof fetch = fetch) {
  return new AgentRegistration(
    {
      load: () => ({
        serverUrl: origin,
        encryptedCredential: 'cipher',
        scope: {
          tenant_id: i.tenantId,
          employee_id: i.employeeId,
          account_id: i.accountId,
          agent_id: i.agentId,
          platform: i.platform
        }
      }),
      save: () => {}
    },
    { available: () => true, encrypt: () => '', decrypt: () => token },
    transport,
    true
  )
}
async function post(path: string, value: unknown, bearer = token) {
  return fetch(origin + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
    body: JSON.stringify(value)
  })
}
async function seedPermit(status = 'issued', agent = i.agentId) {
  await privileged(`INSERT INTO execution_permits(tenant_id,account_id,id,agent_id,lease_version,task_id,draft_hash,status,task_hash,conversation_id,draft_revision,login_epoch,client_instance_id,issued_at,expires_at)
    VALUES('${i.tenantId}','${i.accountId}','permit-A','${agent}',7,'${request.taskId}','${request.draftHash}','${status}','${request.taskHash}','${f.task.conversationId}',${request.draftRevision},${i.loginEpoch},'${i.clientInstanceId}',clock_timestamp()-interval '4 seconds',clock_timestamp()-interval '1 second')`)
  await login()
}
function local() {
  const ledger = new Ledger(':memory:', Date.now())
  for (const sourceMessageId of ['m1', 'm2'])
    ledger.observe({
      identity: i,
      conversationId: f.task.conversationId,
      sourceMessageId,
      direction: 'inbound',
      kind: 'text',
      text: '合成问题',
      observedAt: Date.now(),
      identityVerified: true,
      messageIdVerified: true
    })
  ledger.replies.begin(f.task, ['合成问题'], Date.now())
  ledger.replies.update(i, f.task.taskId, { status: 'not_sent', draft: f.draft }, Date.now())
  const send = ledger.prepare(f.task, f.draft.draftHash, Date.now()).record
  ledger.transition(send.executionId, 'prepared', 'dispatching', Date.now())
  ledger.central.begin(send.executionId, request, Date.now())
  ledger.central.unresolved(send.executionId, Date.now())
  ledger.transition(send.executionId, 'dispatching', 'cancelled', Date.now())
  return { ledger, send }
}
beforeAll(async () => {
  pg = await embeddedPostgres()
  await privileged(`CREATE ROLE synthetic_admin LOGIN NOSUPERUSER NOBYPASSRLS; GRANT autoreply_admin TO synthetic_admin;
    INSERT INTO tenants(id,name) VALUES('${i.tenantId}','合成企业');
    INSERT INTO employees(tenant_id,id,role) VALUES('${i.tenantId}','admin-A','admin');
    INSERT INTO admin_database_principals(login_name,tenant_id,employee_id) VALUES('synthetic_admin','${i.tenantId}','admin-A')`)
  authority = new AccountAuthority(pg.db)
  admin = new Administration(pg.db)
  service = new RequestSealAuthority(authority)
  execution = new ExecutionAuthority(authority, async () => {})
  server = createServer(createApplication(authority, { execution, requestSeals: service }))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing_port')
  origin = `http://127.0.0.1:${address.port}`
}, 20000)
beforeEach(async () => {
  await privileged(`TRUNCATE learning_versions,learning_episodes,learning_memories,learning_revisions,learning_settings,learning_generations,learning_feedback,learning_quarantines,learning_tombstones,learning_mutations,
    model_call_results,model_call_attempts,model_call_limits,execution_request_seal_applications,execution_request_seals,reconciliation_applied,reconciliation_decisions,device_reconciliation_reports,reconciliation_notes,reconciliation_cases,evaluation_approvals,evaluation_runs,
    enrollment_codes,account_leases,execution_permits,human_confirmations,reviewed_replies,generation_tasks,generation_publications,published_configurations,agents,accounts,audit_events CASCADE;
    DELETE FROM employees WHERE role='employee';
    INSERT INTO employees(tenant_id,id,role) VALUES('${i.tenantId}','${i.employeeId}','employee');
    INSERT INTO accounts(tenant_id,id,employee_id,platform,paused) VALUES('${i.tenantId}','${i.accountId}','${i.employeeId}','${i.platform}',true);
    INSERT INTO agents(tenant_id,id,account_id,employee_id,token_hash) VALUES('${i.tenantId}','${i.agentId}','${i.accountId}','${i.employeeId}','${tokenHash(token)}'),
      ('${i.tenantId}','other-agent','${i.accountId}','${i.employeeId}','${tokenHash(otherToken)}');
    INSERT INTO account_leases(tenant_id,account_id,agent_id,login_epoch,client_instance_id,version,expires_at)
      VALUES('${i.tenantId}','${i.accountId}','${i.agentId}',${i.loginEpoch},'${i.clientInstanceId}',7,clock_timestamp()-interval '1 second')`)
  await login()
})
afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.close()
})
afterAll(async () => {
  if (server) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  if (pg) await pg.db.close()
})

describe('lost issuance request sealing over real HTTP/private client/PostgreSQL/SQLite', () => {
  it('atomically resolves only a proven never-dispatched request, leaves human ownership and never starts a device', async () => {
    const l = local(),
      c = client(),
      runtime = new DesktopAgentRuntime(l.ledger, c)
    runtimes.push(runtime)
    const lease = vi.spyOn(c, 'acquireLease'),
      issue = vi.spyOn(c, 'issueExecution'),
      settle = vi.spyOn(c, 'settleExecution')
    const row = runtime.workbench().rows[0]
    expect(row).toMatchObject({
      canReconcile: true,
      reconciliationRequired: true,
      canRelease: false
    })
    const result = WorkbenchReconciliationResultSchema.parse(
      await runtime.workbenchReconcile({ taskId: row.taskId, expectedVersion: row.version })
    )
    expect(result).toMatchObject({
      success: true,
      status: 'request_sealed',
      resolution: 'not_sent',
      applicationAcknowledged: true
    })
    expect(runtime.status()).toMatchObject({ state: 'paused', pauseAcknowledged: true })
    expect(l.ledger.central.get(l.send.executionId)).toMatchObject({
      phase: 'unresolved',
      permit: undefined,
      receipt: undefined
    })
    expect(l.ledger.central.requiresReconciliation()).toBe(false)
    expect(l.ledger.snapshot(i, f.task.conversationId).humanOwned).toBe(true)
    expect(l.ledger.snapshot(i, f.task.conversationId).messages.map((m) => m.handledBy)).toEqual([
      l.send.executionId,
      l.send.executionId
    ])
    expect(l.ledger.getSend(l.send.executionId)).toMatchObject({
      status: 'cancelled',
      reason: 'request_sealed_not_dispatched'
    })
    expect(lease).not.toHaveBeenCalled()
    expect(issue).not.toHaveBeenCalled()
    expect(settle).not.toHaveBeenCalled()
    await login('synthetic_admin')
    expect((await admin.accounts(i.tenantId))[0]).toMatchObject({
      server_paused: true,
      unapplied_request_seals: 0
    })
    expect(await admin.requestSeals(i.tenantId, i.accountId)).toMatchObject([
      { task_id: request.taskId, execution_id: l.send.executionId }
    ])
    await login()
  })

  it('keeps both barriers until application acknowledgment; a lost acknowledgment retries exact data without resealing', async () => {
    const l = local()
    let lost = true,
      sealCalls = 0
    const calls: string[] = []
    const c = client(async (url, options) => {
      if (String(url).endsWith('/seal')) sealCalls++
      const r = await fetch(url, options)
      if (String(url).endsWith('/seal-applied')) {
        calls.push(String(options?.body))
        if (lost) {
          lost = false
          throw new Error('synthetic_lost_response')
        }
      }
      return r
    })
    const runtime = new DesktopAgentRuntime(l.ledger, c)
    runtimes.push(runtime)
    const row = runtime.workbench().rows[0]
    expect(
      await runtime.workbenchReconcile({ taskId: row.taskId, expectedVersion: row.version })
    ).toMatchObject({ success: true, applicationAcknowledged: false })
    expect(l.ledger.central.requiresReconciliation()).toBe(true)
    // Server committed the acknowledgment, but local success is not invented.
    expect(runtime.workbench().rows[0]).toMatchObject({
      canRelease: false,
      reconciliationRequired: true
    })
    await runtime.synchronize()
    expect(calls).toHaveLength(2)
    expect(calls[1]).toBe(calls[0])
    expect(sealCalls).toBe(1)
    expect(l.ledger.central.requiresReconciliation()).toBe(false)
    expect(runtime.status()).toMatchObject({
      state: 'blocked',
      reason: 'configuration_unavailable',
      pauseAcknowledged: true
    })
  })

  it('records one immutable seal; later automatic, human, changed lease and raw SQL issuance remain rejected', async () => {
    const original = input(),
      c = client(),
      result = await c.sealExecutionRequest(original)
    expect(result.status).toBe('request_sealed')
    expect(await c.sealExecutionRequest(original)).toEqual(result)
    if (result.status !== 'request_sealed') throw new Error('seal_missing')
    await login('synthetic_admin')
    await expect(admin.resume(i.tenantId, i.accountId)).rejects.toMatchObject({
      code: 'UNRESOLVED_EXECUTION'
    })
    expect((await admin.accounts(i.tenantId))[0]).toMatchObject({ unapplied_request_seals: 1 })
    await privileged(`UPDATE accounts SET paused=false WHERE id='${i.accountId}'`)
    await login()
    await expect(authority.acquireLease(token, 2, 'other-session')).rejects.toMatchObject({
      code: 'UNRESOLVED_EXECUTION'
    })
    await expect(execution.issue(token, request)).rejects.toMatchObject({ code: 'REQUEST_SEALED' })
    await expect(
      execution.issue(token, {
        ...request,
        leaseVersion: 99,
        draftHash: hashContext('other-draft')
      })
    ).rejects.toMatchObject({ code: 'REQUEST_SEALED' })
    const now = Date.now()
    await expect(
      execution.issueHuman(token, {
        task: f.task,
        draft: f.draft,
        leaseVersion: 99,
        confirmation: {
          confirmationId: randomUUID(),
          taskId: f.task.taskId,
          sourceTaskId: 'source-task',
          taskHash: hashContext(f.task),
          draftHash: f.draft.draftHash,
          draftRevision: f.draft.draftRevision,
          employeeId: i.employeeId,
          modelResolved: 'synthetic-model',
          confirmedAt: now,
          expiresAt: now + 5000
        }
      })
    ).rejects.toMatchObject({ code: 'REQUEST_SEALED' })
    await privileged(`UPDATE accounts SET paused=true WHERE id='${i.accountId}'`)
    await login()
    await c.requestSealApplied(result.seal)
    await privileged(`UPDATE accounts SET paused=false WHERE id='${i.accountId}'`)
    await login()
    expect(await c.sealExecutionRequest(original)).toEqual(result)
    await c.requestSealApplied(result.seal)
    await expect(execution.issue(token, request)).rejects.toMatchObject({ code: 'REQUEST_SEALED' })
    await expect(
      pg.db.transaction(i.tenantId, (db) =>
        db.query(
          `INSERT INTO execution_permits(tenant_id,account_id,id,agent_id,lease_version,task_id,draft_hash,status)
      VALUES($1,$2,'forbidden',$3,99,$4,$5,'issued')`,
          [i.tenantId, i.accountId, i.agentId, request.taskId, request.draftHash]
        )
      )
    ).rejects.toThrow('execution_request_sealed')
    await expect(
      pg.db.transaction(i.tenantId, (db) =>
        db.query('DELETE FROM execution_request_seals WHERE account_id=$1', [i.accountId])
      )
    ).rejects.toThrow('permission denied')
    await expect(
      pg.db.transaction(i.tenantId, (db) =>
        db.query("UPDATE execution_request_seals SET task_id='other' WHERE account_id=$1", [
          i.accountId
        ])
      )
    ).rejects.toThrow('permission denied')
  })

  it('returns an expired original permit as read-only instead of creating a contradictory seal', async () => {
    await seedPermit('unknown')
    const result = await client().sealExecutionRequest(input())
    expect(result).toMatchObject({
      status: 'existing_permit',
      permit: { permitId: 'permit-A', newlyIssued: false, status: 'unknown' }
    })
    expect(
      (
        await pg.db.transaction(i.tenantId, (db) =>
          db.query('SELECT * FROM execution_request_seals')
        )
      ).rowCount
    ).toBe(0)
  })

  it('rejects changed request, forged proof, wrong device/customer scope, live lease and unpaused account', async () => {
    const original = input(),
      result = await client().sealExecutionRequest(original)
    expect(result.status).toBe('request_sealed')
    const changed = {
      ...original,
      request: { ...request, draftRevision: request.draftRevision + 1 }
    }
    changed.verificationProofHash = requestNonDispatchProof({
      executionId: changed.executionId,
      identity: changed.identity,
      request: changed.request
    })
    expect((await post('/v1/reconciliation/seal', changed)).status).toBe(409)
    expect(
      (
        await post('/v1/reconciliation/seal', {
          ...original,
          verificationProofHash: hashContext('forged')
        })
      ).status
    ).toBe(409)
    expect((await post('/v1/reconciliation/seal', original, otherToken)).status).toBe(409)
    expect(
      (
        await post('/v1/reconciliation/seal', {
          ...original,
          identity: { ...i, accountId: 'other-account' }
        })
      ).status
    ).toBe(409)
    expect(
      (await post('/v1/reconciliation/seal', { ...original, dispatchStarted: false })).status
    ).toBe(400)
    expect((await post('/v1/reconciliation/seal', original, 'C'.repeat(43))).status).toBe(401)
    const fresh = input()
    fresh.request = { ...request, taskId: 'new-task' }
    fresh.verificationProofHash = requestNonDispatchProof({
      executionId: fresh.executionId,
      identity: fresh.identity,
      request: fresh.request
    })
    await privileged(`UPDATE account_leases SET expires_at=clock_timestamp()+interval '30 seconds'`)
    await login()
    expect((await post('/v1/reconciliation/seal', fresh)).status).toBe(409)
    await privileged(
      `UPDATE account_leases SET expires_at=clock_timestamp()-interval '1 second';UPDATE accounts SET paused=false`
    )
    await login()
    expect((await post('/v1/reconciliation/seal', fresh)).status).toBe(409)
  })

  it('rejects extra fields, substituted proof and mismatched server acknowledgments in the private client', async () => {
    const original = input(),
      valid = await client().sealExecutionRequest(original)
    if (valid.status !== 'request_sealed') throw new Error('seal_missing')
    for (const bad of [
      { ...valid, credential: token },
      { ...valid, seal: { ...valid.seal, requestHash: hashContext('wrong') } },
      { ...valid, seal: { ...valid.seal, input: { ...original, executionId: 'other' } } },
      {
        ...valid,
        seal: {
          ...valid.seal,
          input: { ...original, verificationProofHash: hashContext('forged') }
        }
      },
      { ...valid, seal: { ...valid.seal, sealedAt: original.stopped.stoppedAt - 1 } }
    ])
      await expect(
        client(async () => Response.json(bad)).sealExecutionRequest(original)
      ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    const ack = {
      sealId: valid.seal.sealId,
      sealHash: hashContext(valid.seal),
      requestHash: valid.seal.requestHash,
      executionId: original.executionId,
      status: 'request_seal_applied'
    }
    for (const bad of [
      { ...ack, sealHash: hashContext('wrong') },
      { ...ack, executionId: 'other' },
      { ...ack, extra: true }
    ])
      await expect(
        client(async () => Response.json(bad)).requestSealApplied(valid.seal)
      ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    const lookup = {
      sealId: ack.sealId,
      sealHash: ack.sealHash,
      requestHash: ack.requestHash,
      executionId: ack.executionId
    }
    expect(
      (await post('/v1/reconciliation/seal-applied', { ...lookup, executionId: 'other' })).status
    ).toBe(409)
    expect((await post('/v1/reconciliation/seal-applied', lookup, otherToken)).status).toBe(409)
    expect(
      (
        await pg.db.transaction(i.tenantId, (db) =>
          db.query('SELECT * FROM execution_request_seal_applications')
        )
      ).rowCount
    ).toBe(0)
  })
  it('rolls back the seal and application together with failing audit writes', async () => {
    const original = input()
    await privileged(
      "ALTER TABLE audit_events ADD CONSTRAINT synthetic_seal_audit CHECK(kind<>'execution_request_sealed')"
    )
    await login()
    try {
      await expect(service.seal(token, original)).rejects.toThrow('synthetic_seal_audit')
      expect(
        (
          await pg.db.transaction(i.tenantId, (db) =>
            db.query('SELECT * FROM execution_request_seals')
          )
        ).rowCount
      ).toBe(0)
    } finally {
      await privileged('ALTER TABLE audit_events DROP CONSTRAINT synthetic_seal_audit')
      await login()
    }
    const result = await client().sealExecutionRequest(original)
    if (result.status !== 'request_sealed') throw new Error('seal_missing')
    await privileged(
      "ALTER TABLE audit_events ADD CONSTRAINT synthetic_apply_audit CHECK(kind<>'execution_request_seal_applied')"
    )
    await login()
    try {
      await expect(client().requestSealApplied(result.seal)).rejects.toMatchObject({
        code: 'UNAVAILABLE'
      })
      expect(
        (
          await pg.db.transaction(i.tenantId, (db) =>
            db.query('SELECT * FROM execution_request_seal_applications')
          )
        ).rowCount
      ).toBe(0)
    } finally {
      await privileged('ALTER TABLE audit_events DROP CONSTRAINT synthetic_apply_audit')
      await login()
    }
  })
})
