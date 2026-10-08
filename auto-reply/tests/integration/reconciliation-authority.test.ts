import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { embeddedPostgres } from '../fixtures/embedded-postgres'
import { taskFixture } from '../fixtures/task'
import { AccountAuthority, tokenHash } from '../../server/src/auth/account-authority'
import { Administration } from '../../server/src/admin/administration'
import { ReconciliationAuthority } from '../../server/src/execution/reconciliation-authority'
import { ExecutionAuthority } from '../../server/src/execution/execution-authority'
import { createApplication } from '../../server/src/http/application'
import { AgentRegistration } from '../../src/main/services/agent-registration'
import { hashContext } from '../../src/core/reply/hashes'
import type {
  DeviceReconciliationReport,
  ReconciliationChallenge
} from '../../src/shared/contracts/reconciliation'
import type { ReconciliationDecision } from '../../src/shared/contracts/reconciliation'
import type { PermitRequest } from '../../src/shared/contracts/execution'
import { Ledger } from '../../src/core/persistence/ledger'
import {
  DesktopAgentRuntime,
  type RuntimePlatform
} from '../../src/main/services/desktop-agent-runtime'

const f = taskFixture(),
  token = 'A'.repeat(43),
  otherToken = 'B'.repeat(43)
let pg: Awaited<ReturnType<typeof embeddedPostgres>>,
  admin: Administration,
  authority: AccountAuthority,
  service: ReconciliationAuthority,
  execution: ExecutionAuthority,
  server: Server,
  origin: string,
  client: AgentRegistration
const request: PermitRequest = {
  taskId: f.task.taskId,
  taskHash: hashContext(f.task),
  draftHash: f.draft.draftHash,
  draftRevision: f.draft.draftRevision,
  loginEpoch: f.task.identity.loginEpoch,
  clientInstanceId: f.task.identity.clientInstanceId,
  leaseVersion: 7
}
async function privileged(text: string) {
  await pg.sql.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE')
  await pg.sql.exec(text)
}
async function login(name = 'autoreply_app') {
  await pg.sql.exec(
    `SET SESSION AUTHORIZATION postgres; RESET ROLE; SET SESSION AUTHORIZATION ${name}`
  )
}
async function open() {
  await login('synthetic_admin')
  const result = await admin.openReconciliation(
    f.task.identity.tenantId,
    f.task.identity.accountId,
    'permit-A'
  )
  await login()
  return result
}
async function challenge() {
  await open()
  return client.reconciliationChallenge(f.task.identity, request)
}
function report(c: ReconciliationChallenge): DeviceReconciliationReport {
  const now = Date.now()
  return {
    caseId: c.caseId,
    snapshotHash: c.snapshotHash,
    request,
    stopped: {
      stoppedAt: now,
      observerStopped: true,
      senderQuiescent: true,
      settlementQuiescent: true,
      leaseStopped: true,
      verifiedDriverStopped: true
    },
    observation: {
      executionId: randomUUID(),
      identity: f.task.identity,
      conversationId: f.task.conversationId,
      permitId: 'permit-A',
      taskHash: request.taskHash,
      draftHash: request.draftHash,
      draftRevision: request.draftRevision,
      leaseVersion: 7,
      observedAt: now,
      verificationProofHash: hashContext('synthetic-new-echo-proof'),
      status: 'confirmed',
      sourceMessageId: 'synthetic-new-outbound'
    }
  }
}
async function post(path: string, value: unknown, bearer = token) {
  return fetch(origin + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
    body: JSON.stringify(value)
  })
}
async function reviewed(evidence: DeviceReconciliationReport) {
  await client.reportReconciliation(evidence)
  await login('synthetic_admin')
  const noteId = randomUUID()
  await admin.recordReconciliationNote(
    f.task.identity.tenantId,
    f.task.identity.accountId,
    evidence.caseId,
    {
      noteId,
      snapshotHash: evidence.snapshotHash,
      referenceId: 'synthetic-reviewed-record',
      evidenceHash: hashContext('synthetic-private-review'),
      observedAt: Date.now()
    }
  )
  return {
    decisionId: randomUUID(),
    snapshotHash: evidence.snapshotHash,
    reportHash: hashContext(evidence),
    noteId,
    outcome: evidence.observation.status
  }
}
async function decided(evidence: DeviceReconciliationReport): Promise<ReconciliationDecision> {
  const input = await reviewed(evidence)
  const decision = await admin.decideReconciliation(
    f.task.identity.tenantId,
    f.task.identity.accountId,
    evidence.caseId,
    input
  )
  await login()
  return decision
}
beforeAll(async () => {
  pg = await embeddedPostgres()
  const i = f.task.identity
  await privileged(`CREATE ROLE synthetic_admin LOGIN NOSUPERUSER NOBYPASSRLS;GRANT autoreply_admin TO synthetic_admin;
    INSERT INTO tenants(id,name) VALUES('${i.tenantId}','合成企业');
    INSERT INTO employees(tenant_id,id,role) VALUES('${i.tenantId}','admin-A','admin');
    INSERT INTO admin_database_principals(login_name,tenant_id,employee_id) VALUES('synthetic_admin','${i.tenantId}','admin-A')`)
  admin = new Administration(pg.db)
  authority = new AccountAuthority(pg.db)
  service = new ReconciliationAuthority(authority)
  execution = new ExecutionAuthority(authority, async () => {})
  server = createServer(createApplication(authority, { execution, reconciliation: service }))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing_test_port')
  origin = `http://127.0.0.1:${address.port}`
  client = new AgentRegistration(
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
    fetch,
    true
  )
}, 20000)
beforeEach(async () => {
  const i = f.task.identity
  await privileged(`TRUNCATE learning_versions,learning_episodes,learning_memories,learning_revisions,learning_settings,learning_generations,learning_feedback,learning_quarantines,learning_tombstones,learning_mutations,
    model_call_results,model_call_attempts,model_call_limits,execution_request_seal_applications,execution_request_seals,reconciliation_applied,reconciliation_decisions,device_reconciliation_reports,reconciliation_notes,reconciliation_cases,evaluation_approvals,evaluation_runs,
    enrollment_codes,account_leases,execution_permits,human_confirmations,reviewed_replies,generation_tasks,generation_publications,published_configurations,agents,accounts,audit_events CASCADE;
    DELETE FROM employees WHERE role='employee';
    INSERT INTO employees(tenant_id,id,role) VALUES('${i.tenantId}','${i.employeeId}','employee');
    INSERT INTO accounts(tenant_id,id,employee_id,platform,paused) VALUES('${i.tenantId}','${i.accountId}','${i.employeeId}','${i.platform}',false);
    INSERT INTO agents(tenant_id,id,account_id,employee_id,token_hash) VALUES('${i.tenantId}','${i.agentId}','${i.accountId}','${i.employeeId}','${tokenHash(token)}'),
      ('${i.tenantId}','other-agent','${i.accountId}','${i.employeeId}','${tokenHash(otherToken)}');
    INSERT INTO account_leases(tenant_id,account_id,agent_id,login_epoch,client_instance_id,version,expires_at)
      VALUES('${i.tenantId}','${i.accountId}','${i.agentId}',${i.loginEpoch},'${i.clientInstanceId}',7,clock_timestamp()-interval '1 second');
    INSERT INTO execution_permits(tenant_id,account_id,id,agent_id,lease_version,task_id,draft_hash,status,task_hash,conversation_id,draft_revision,login_epoch,client_instance_id,issued_at,expires_at,settlement_hash)
      VALUES('${i.tenantId}','${i.accountId}','permit-A','${i.agentId}',7,'${request.taskId}','${request.draftHash}','unknown','${request.taskHash}',
        '${f.task.conversationId}',${request.draftRevision},${i.loginEpoch},'${i.clientInstanceId}',clock_timestamp()-interval '4 seconds',clock_timestamp()-interval '1 second',
        '${hashContext({ permitId: 'permit-A', draftHash: request.draftHash, status: 'unknown' })}')`)
  await login()
})
afterAll(async () => {
  if (server) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  if (pg) await pg.db.close()
})
describe('device evidence over actual HTTP/private transport/embedded PostgreSQL', () => {
  it('records an immutable administrator decision without clearing central or local barriers prematurely', async () => {
    const c = await challenge(),
      evidence = report(c)
    await client.reportReconciliation(evidence)
    expect(await client.reconciliationDecision(evidence)).toBeNull()
    const input = await reviewed(evidence)
    const first = await admin.decideReconciliation(
      f.task.identity.tenantId,
      f.task.identity.accountId,
      c.caseId,
      input
    )
    expect(first).toMatchObject({ ...input, caseId: c.caseId, decidedBy: 'admin-A' })
    expect(
      await admin.decideReconciliation(
        f.task.identity.tenantId,
        f.task.identity.accountId,
        c.caseId,
        input
      )
    ).toEqual(first)
    await expect(
      admin.decideReconciliation(f.task.identity.tenantId, f.task.identity.accountId, c.caseId, {
        ...input,
        decisionId: randomUUID()
      })
    ).rejects.toThrow('RECONCILIATION_CONFLICT')
    await expect(admin.resume(f.task.identity.tenantId, f.task.identity.accountId)).rejects.toThrow(
      'UNRESOLVED_EXECUTION'
    )
    for (const sql of [
      'DELETE FROM reconciliation_decisions',
      "UPDATE reconciliation_decisions SET outcome='not_sent'",
      "UPDATE execution_permits SET status='confirmed'"
    ])
      await expect(
        pg.db.transaction(f.task.identity.tenantId, (db) => db.query(sql))
      ).rejects.toThrow(/permission denied/i)
    const details = await admin.reconciliation(
      f.task.identity.tenantId,
      f.task.identity.accountId,
      c.caseId
    )
    expect(details.decision).toMatchObject({ decision_json: first, applied_at: null })
    expect(details.currentPermitStatus).toBe('unknown')
    expect(
      await admin.unresolved(f.task.identity.tenantId, f.task.identity.accountId)
    ).toHaveLength(1)
    await login()
    expect(await client.reconciliationDecision(evidence)).toEqual(first)
    await expect(
      pg.db.transaction(f.task.identity.tenantId, (db) =>
        db.query(
          'SELECT autoreply.decide_reconciliation($1,$2,$3::uuid,$4::uuid,$5,$6,$7::uuid,$8)',
          [
            f.task.identity.tenantId,
            f.task.identity.accountId,
            c.caseId,
            input.decisionId,
            input.snapshotHash,
            input.reportHash,
            input.noteId,
            input.outcome
          ]
        )
      )
    ).rejects.toThrow(/permission denied/i)
  })
  it('rejects mismatched review, result and missing evidence through CLI and the narrow database function', async () => {
    const c = await challenge(),
      evidence = report(c),
      input = await reviewed(evidence)
    for (const bad of [
      { ...input, outcome: 'not_sent' },
      { ...input, reportHash: 'f'.repeat(64) },
      { ...input, snapshotHash: 'f'.repeat(64) },
      { ...input, noteId: randomUUID() },
      { ...input, decidedBy: 'admin-A' }
    ])
      await expect(
        admin.decideReconciliation(
          f.task.identity.tenantId,
          f.task.identity.accountId,
          c.caseId,
          bad
        )
      ).rejects.toThrow()
    await privileged('UPDATE accounts SET paused=false')
    await login('synthetic_admin')
    await expect(
      admin.decideReconciliation(
        f.task.identity.tenantId,
        f.task.identity.accountId,
        c.caseId,
        input
      )
    ).rejects.toThrow('RECONCILIATION_CONFLICT')
    await privileged(
      "UPDATE accounts SET paused=true;UPDATE account_leases SET expires_at=clock_timestamp()+interval '1 minute'"
    )
    await login('synthetic_admin')
    await expect(
      admin.decideReconciliation(
        f.task.identity.tenantId,
        f.task.identity.accountId,
        c.caseId,
        input
      )
    ).rejects.toThrow('RECONCILIATION_CONFLICT')
    expect(
      (
        await pg.db.transaction(f.task.identity.tenantId, (db) =>
          db.query('SELECT 1 FROM reconciliation_decisions')
        )
      ).rowCount
    ).toBe(0)
  })
  it('retries only the exact applied acknowledgment, then permits a new lease while keeping original unknown history', async () => {
    const c = await challenge(),
      evidence = report(c),
      decision = await decided(evidence)
    expect(
      (
        await post('/v1/reconciliation/applied', {
          caseId: c.caseId,
          snapshotHash: c.snapshotHash,
          reportHash: hashContext(evidence),
          request,
          decisionId: decision.decisionId,
          decisionHash: 'f'.repeat(64)
        })
      ).status
    ).toBe(409)
    expect(
      (
        await post(
          '/v1/reconciliation/decision',
          {
            caseId: c.caseId,
            snapshotHash: c.snapshotHash,
            reportHash: hashContext(evidence),
            request
          },
          otherToken
        )
      ).status
    ).toBe(409)
    const ack = await client.reconciliationApplied(evidence, decision)
    expect(await client.reconciliationApplied(evidence, decision)).toEqual(ack)
    await login('synthetic_admin')
    expect(await admin.unresolved(f.task.identity.tenantId, f.task.identity.accountId)).toEqual([])
    expect((await admin.accounts(f.task.identity.tenantId))[0]).toMatchObject({
      server_paused: true,
      unresolved_count: 0
    })
    await privileged('UPDATE accounts SET paused=false')
    await login()
    // Lost acknowledgment remains retryable after an explicit later resume.
    expect(await client.reconciliationApplied(evidence, decision)).toEqual(ack)
    expect(await client.reconciliationDecision(evidence)).toEqual(decision)
    expect((await authority.acquireLease(token, 1, f.task.identity.clientInstanceId)).version).toBe(
      8
    )
    expect(
      await execution.settle(token, {
        permitId: 'permit-A',
        draftHash: request.draftHash,
        status: 'unknown'
      })
    ).toEqual({ status: 'unknown' })
    await expect(
      execution.settle(token, {
        permitId: 'permit-A',
        draftHash: request.draftHash,
        status: 'confirmed',
        sourceMessageId: 'synthetic-new-outbound',
        verificationProofHash: evidence.observation.verificationProofHash
      })
    ).rejects.toThrow('PERMIT_CONFLICT')
    for (const sql of [
      'DELETE FROM reconciliation_applied',
      "UPDATE reconciliation_applied SET decision_hash='changed'"
    ])
      await expect(
        pg.db.transaction(f.task.identity.tenantId, (db) => db.query(sql))
      ).rejects.toThrow(/permission denied/i)
  })
  it('rolls back final decision with audit failure and rejects revoked-device decision reads', async () => {
    const c = await challenge(),
      evidence = report(c),
      input = await reviewed(evidence)
    await privileged(`CREATE FUNCTION autoreply.fail_decision_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.kind='reconciliation_decided' THEN RAISE EXCEPTION 'synthetic_audit_failure';END IF;RETURN NEW;END $$;
      CREATE TRIGGER reject_decision_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION autoreply.fail_decision_audit()`)
    await login('synthetic_admin')
    try {
      await expect(
        admin.decideReconciliation(
          f.task.identity.tenantId,
          f.task.identity.accountId,
          c.caseId,
          input
        )
      ).rejects.toThrow('RECONCILIATION_CONFLICT')
      expect(
        (
          await pg.db.transaction(f.task.identity.tenantId, (db) =>
            db.query('SELECT 1 FROM reconciliation_decisions')
          )
        ).rowCount
      ).toBe(0)
    } finally {
      await privileged(
        'DROP TRIGGER reject_decision_audit ON audit_events;DROP FUNCTION autoreply.fail_decision_audit()'
      )
      await login('synthetic_admin')
    }
    await admin.decideReconciliation(
      f.task.identity.tenantId,
      f.task.identity.accountId,
      c.caseId,
      input
    )
    await privileged(`CREATE FUNCTION autoreply.fail_applied_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.kind='reconciliation_resolution_applied' THEN RAISE EXCEPTION 'synthetic_audit_failure';END IF;RETURN NEW;END $$;
      CREATE TRIGGER reject_applied_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION autoreply.fail_applied_audit()`)
    await login()
    const decision = await client.reconciliationDecision(evidence)
    try {
      await expect(client.reconciliationApplied(evidence, decision!)).rejects.toThrow()
      expect(
        (
          await pg.db.transaction(f.task.identity.tenantId, (db) =>
            db.query('SELECT 1 FROM reconciliation_applied')
          )
        ).rowCount
      ).toBe(0)
    } finally {
      await privileged(
        'DROP TRIGGER reject_applied_audit ON audit_events;DROP FUNCTION autoreply.fail_applied_audit()'
      )
      await login()
    }
    await client.reconciliationApplied(evidence, decision!)
    await privileged('UPDATE agents SET revoked_at=clock_timestamp()')
    await login()
    await expect(client.reconciliationDecision(evidence)).rejects.toThrow('AUTHORIZATION_FAILED')
  })
  it('connects the actual SQLite/main/private HTTP/SQL report path with a synthetic read-only inspector', async () => {
    const c = await challenge(),
      ledger = new Ledger(':memory:')
    for (const sourceMessageId of ['m1', 'm2'])
      ledger.observe({
        identity: f.task.identity,
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
    ledger.replies.update(
      f.task.identity,
      f.task.taskId,
      { status: 'unknown', draft: f.draft },
      Date.now()
    )
    const send = ledger.prepare(f.task, f.draft.draftHash, Date.now()).record
    ledger.transition(send.executionId, 'prepared', 'dispatching', Date.now())
    ledger.central.begin(send.executionId, request, Date.now())
    ledger.central.issued(
      send.executionId,
      { ...c.permit, status: 'issued', newlyIssued: true },
      Date.now()
    )
    ledger.central.dispatching(send.executionId, Date.now())
    ledger.central.recordReceipt(
      send.executionId,
      { permitId: 'permit-A', draftHash: request.draftHash, status: 'unknown' },
      Date.now()
    )
    const platform: RuntimePlatform = {
      capabilities: () => ({ backgroundRead: true, nonInterferingSend: true }),
      binding: async () => {
        throw new Error('no window inspection')
      },
      observe: async () => {},
      stop: async () => {},
      readCurrent: async () => {
        throw new Error('no sending inspection')
      },
      dispatch: async () => {
        throw new Error('must not send')
      },
      inspectExecution: async (input) => ({
        ...report(input.challenge).observation,
        executionId: input.executionId
      })
    }
    const runtime = new DesktopAgentRuntime(ledger, client, platform)
    try {
      const row = runtime.workbench().rows[0]
      const result = await runtime.workbenchReconcile({
        taskId: row.taskId,
        expectedVersion: row.version
      })
      expect(result).toMatchObject({ success: true, caseId: c.caseId, status: 'evidence_recorded' })
      const persisted = ledger.central.reconciliationReport(send.executionId)!
      const central = await pg.db.transaction(f.task.identity.tenantId, (db) =>
        db.query('SELECT report_hash,report_json FROM device_reconciliation_reports')
      )
      expect(central.rows).toEqual([
        { report_hash: hashContext(persisted), report_json: persisted }
      ])
      expect(ledger.getSend(send.executionId)?.status).toBe('unknown')
      expect(ledger.central.requiresReconciliation()).toBe(true)
      expect(runtime.workbench().rows[0].canConfirm).toBe(false)
      const decision = await decided(persisted)
      const fresh = runtime.workbench().rows[0]
      expect(
        await runtime.workbenchReconcile({ taskId: fresh.taskId, expectedVersion: fresh.version })
      ).toMatchObject({ success: true, resolution: 'confirmed', applicationAcknowledged: true })
      expect(ledger.central.reconciliationDecision(send.executionId)).toEqual(decision)
      expect(ledger.getSend(send.executionId)?.status).toBe('confirmed')
      expect(ledger.central.get(send.executionId)?.receipt?.status).toBe('unknown')
      expect(ledger.central.requiresReconciliation()).toBe(false)
      expect(
        ledger.snapshot(f.task.identity, f.task.conversationId).messages.map((m) => m.handledBy)
      ).toEqual([send.executionId, send.executionId])
      expect(runtime.status().state).toBe('paused')
      expect(
        (
          await pg.db.transaction(f.task.identity.tenantId, (db) =>
            db.query('SELECT status,settlement_hash FROM execution_permits')
          )
        ).rows[0]
      ).toEqual({
        status: 'unknown',
        settlement_hash: hashContext({
          permitId: 'permit-A',
          draftHash: request.draftHash,
          status: 'unknown'
        })
      })
    } finally {
      await runtime.close()
    }
  })
  it('records exact evidence once, lets the administrator inspect it, and preserves the unknown receipt', async () => {
    const c = await challenge(),
      evidence = report(c)
    expect(c.permit.newlyIssued).toBe(false)
    const ack = await client.reportReconciliation(evidence)
    expect(ack).toEqual({
      caseId: c.caseId,
      reportHash: hashContext(evidence),
      status: 'evidence_recorded'
    })
    expect(await client.reportReconciliation(evidence)).toEqual(ack)
    const audit = await pg.db.transaction(f.task.identity.tenantId, (db) =>
      db.query("SELECT * FROM audit_events WHERE kind='reconciliation_device_evidence_recorded'")
    )
    expect(audit.rows).toHaveLength(1)
    await expect(
      execution.settle(token, {
        permitId: 'permit-A',
        draftHash: request.draftHash,
        status: 'confirmed',
        sourceMessageId: 'synthetic-new-outbound',
        verificationProofHash: evidence.observation.verificationProofHash
      })
    ).rejects.toThrow('PERMIT_CONFLICT')
    await login('synthetic_admin')
    const details = await admin.reconciliation(
      f.task.identity.tenantId,
      f.task.identity.accountId,
      c.caseId
    )
    expect(details.deviceReport).toMatchObject({
      agent_id: f.task.identity.agentId,
      report_hash: ack.reportHash,
      report_json: evidence
    })
    expect(details.currentPermitStatus).toBe('unknown')
    expect(details.case.devicePauseAcknowledged).toBeNull()
  })
  it('requires central pause, expired original permit and no live account lease', async () => {
    await open()
    for (const mutation of [
      'UPDATE accounts SET paused=false',
      "UPDATE account_leases SET expires_at=clock_timestamp()+interval '1 minute'",
      "UPDATE execution_permits SET expires_at=clock_timestamp()+interval '1 minute'"
    ]) {
      await privileged(mutation)
      await login()
      const response = await post('/v1/reconciliation/challenge', request)
      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({ error: 'RECONCILIATION_NOT_READY' })
      await privileged(
        "UPDATE accounts SET paused=true;UPDATE account_leases SET expires_at=clock_timestamp()-interval '1 second';UPDATE execution_permits SET expires_at=issued_at+interval '3 seconds'"
      )
      await login()
    }
  })
  it('rejects other devices, edited tasks, wrong scopes, old/future observation and unproven stops', async () => {
    const c = await challenge(),
      evidence = report(c)
    expect((await post('/v1/reconciliation/challenge', request, otherToken)).status).toBe(409)
    for (const bad of [
      { ...evidence, snapshotHash: 'f'.repeat(64) },
      { ...evidence, request: { ...request, taskHash: 'f'.repeat(64) } },
      {
        ...evidence,
        observation: {
          ...evidence.observation,
          identity: { ...f.task.identity, accountId: 'other' }
        }
      },
      { ...evidence, observation: { ...evidence.observation, conversationId: 'other' } },
      { ...evidence, observation: { ...evidence.observation, observedAt: Date.now() + 60000 } },
      { ...evidence, stopped: { ...evidence.stopped, stoppedAt: c.openedAt - 1 } },
      { ...evidence, stopped: { ...evidence.stopped, senderQuiescent: false } },
      { ...evidence, observation: { status: 'unknown' } },
      { ...evidence, devicePauseAcknowledged: true }
    ])
      expect((await post('/v1/reconciliation/report', bad)).ok).toBe(false)
    expect(
      (
        await pg.db.transaction(f.task.identity.tenantId, (db) =>
          db.query('SELECT 1 FROM device_reconciliation_reports')
        )
      ).rowCount
    ).toBe(0)
  })
  it('accepts actual non-dispatch journal attestation without treating absence as proof and refuses changed retries', async () => {
    const c = await challenge(),
      evidence = report(c)
    const journal = {
      ...evidence.observation,
      status: 'not_sent' as const,
      dispatchStarted: false as const,
      quiescent: true as const
    }
    Reflect.deleteProperty(journal, 'sourceMessageId')
    evidence.observation = journal
    await client.reportReconciliation(evidence)
    expect(
      (
        await post('/v1/reconciliation/report', {
          ...evidence,
          observation: { ...evidence.observation, verificationProofHash: 'f'.repeat(64) }
        })
      ).status
    ).toBe(409)
    expect(
      (
        await post('/v1/reconciliation/report', {
          ...evidence,
          observation: { ...evidence.observation, dispatchStarted: true }
        })
      ).status
    ).toBe(400)
    expect(
      (
        await execution.settle(token, {
          permitId: 'permit-A',
          draftHash: request.draftHash,
          status: 'unknown'
        })
      ).status
    ).toBe('unknown')
  })
  it('rolls back device evidence when audit persistence fails', async () => {
    const c = await challenge(),
      evidence = report(c)
    await privileged(`CREATE FUNCTION autoreply.fail_device_report_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.kind='reconciliation_device_evidence_recorded' THEN RAISE EXCEPTION 'synthetic_audit_failure';END IF;RETURN NEW;END $$;
      CREATE TRIGGER reject_device_report_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION autoreply.fail_device_report_audit()`)
    await login()
    try {
      expect((await post('/v1/reconciliation/report', evidence)).status).toBe(503)
      expect(
        (
          await pg.db.transaction(f.task.identity.tenantId, (db) =>
            db.query('SELECT 1 FROM device_reconciliation_reports')
          )
        ).rowCount
      ).toBe(0)
    } finally {
      await privileged(
        'DROP TRIGGER reject_device_report_audit ON audit_events;DROP FUNCTION autoreply.fail_device_report_audit()'
      )
      await login()
    }
    expect((await client.reportReconciliation(evidence)).reportHash).toBe(hashContext(evidence))
  })
  it('refuses revoked credentials and preserves immutable report permissions', async () => {
    const c = await challenge()
    await client.reportReconciliation(report(c))
    for (const query of [
      'DELETE FROM device_reconciliation_reports',
      "UPDATE device_reconciliation_reports SET report_hash='changed'"
    ])
      await expect(
        pg.db.transaction(f.task.identity.tenantId, (db) => db.query(query))
      ).rejects.toThrow(/permission denied/i)
    await privileged('UPDATE agents SET revoked_at=clock_timestamp()')
    await login()
    expect((await post('/v1/reconciliation/challenge', request)).status).toBe(401)
  })
  it('does not invent absent legacy binding and bounds input at 8 KiB', async () => {
    await privileged(
      'UPDATE execution_permits SET task_hash=NULL,draft_revision=NULL,login_epoch=NULL,client_instance_id=NULL,conversation_id=NULL'
    )
    await login()
    await open()
    const response = await post('/v1/reconciliation/challenge', request)
    expect(await response.json()).toEqual({ error: 'RECONCILIATION_INCOMPLETE' })
    expect(
      (await post('/v1/reconciliation/challenge', { ...request, padding: 'x'.repeat(8192) })).status
    ).toBe(413)
  })
})
