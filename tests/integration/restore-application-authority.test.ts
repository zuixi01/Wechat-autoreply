import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { embeddedPostgres } from '../fixtures/embedded-postgres'
import { Administration } from '../../server/src/admin/administration'
import { AccountAuthority, tokenHash } from '../../server/src/auth/account-authority'
import { RestorePauseAuthority } from '../../server/src/execution/restore-pause-authority'
import { hashContext } from '../../src/core/reply/hashes'
import { createServer } from 'node:http'
import { createApplication } from '../../server/src/http/application'
import { listenFetchLoopback } from '../fixtures/fetch-loopback'
import { AgentRegistration } from '../../src/main/services/agent-registration'

let pg: Awaited<ReturnType<typeof embeddedPostgres>>, admin: Administration
let caseId: string, uploadId: string
const token = 'R'.repeat(43)
async function login(role = 'restore_application_admin') {
  await pg.sql.exec(
    `SET SESSION AUTHORIZATION postgres; RESET ROLE; SET SESSION AUTHORIZATION ${role}`
  )
}
async function owner(sql: string) {
  await login('postgres')
  await pg.sql.exec(sql)
  await login()
}
beforeAll(async () => {
  pg = await embeddedPostgres()
  await owner(
    'CREATE ROLE restore_application_admin LOGIN NOSUPERUSER NOBYPASSRLS; GRANT autoreply_admin TO restore_application_admin'
  )
  admin = new Administration(pg.db)
}, 20000)
afterAll(async () => {
  if (pg) await pg.db.close()
})
beforeEach(async () => {
  await owner(`TRUNCATE tenants CASCADE;
    INSERT INTO tenants(id,name) VALUES('A','synthetic');
    INSERT INTO employees(tenant_id,id,role) VALUES('A','admin','admin'),('A','employee','employee');
    INSERT INTO admin_database_principals(login_name,tenant_id,employee_id) VALUES('restore_application_admin','A','admin');
    INSERT INTO accounts(tenant_id,id,employee_id,platform,paused) VALUES('A','account','employee','wechat',false),('A','other','employee','wechat',true);
    INSERT INTO agents(tenant_id,id,account_id,employee_id,token_hash) VALUES('A','target','account','employee','${tokenHash(token)}');`)
  const descriptor = {
    formatVersion: 1,
    restoreId: randomUUID(),
    backupId: randomUUID(),
    sourceSha256: 'a'.repeat(64),
    restoredAt: new Date().toISOString(),
    previousRestoreId: null,
    previousContextHash: null,
    requiresReconciliation: true
  }
  const context = { ...descriptor, contextHash: hashContext(descriptor) }
  caseId = (await admin.openRestoreReview('A', 'account', { agentId: 'target', context })).caseId
  const service = new RestorePauseAuthority(new AccountAuthority(pg.db))
  await login('autoreply_app')
  const challenge = await service.challenge(token, {
    caseId,
    requestId: randomUUID(),
    restoreId: context.restoreId,
    contextHash: context.contextHash
  })
  const now = Date.now()
  await service.report(token, {
    challenge,
    instanceId: randomUUID(),
    runtimeGeneration: 1,
    stoppedAt: now,
    observedAt: now,
    stopped: {
      observerStopped: true,
      senderQuiescent: true,
      settlementQuiescent: true,
      leaseStopped: true,
      platformStopped: true
    }
  })
  const scope = challenge.scope
  const identity = {
    tenantId: 'A',
    employeeId: 'employee',
    accountId: 'account',
    agentId: 'target',
    platform: 'wechat' as const,
    loginEpoch: 3,
    clientInstanceId: 'restored-process'
  }
  const items = [1, 2, 3].map((sequence) => ({
    kind: 'message' as const,
    key: `m:${hashContext({ identity, conversationId: 'customer' })}:${String(sequence).padStart(16, '0')}`,
    identity,
    conversationId: 'customer',
    sourceMessageId: `msg-${sequence}`,
    sequence,
    observedAt: 100 + sequence,
    sequenceComplete: true,
    direction: 'inbound' as const,
    contentHash: 'c'.repeat(64),
    handledBy: null,
    identityVerified: true,
    messageIdVerified: true,
    hasGap: false,
    humanOwned: false,
    lastSequence: 3,
    revision: 0
  }))
  const summary = {
    conversations: 1,
    messages: 3,
    inbound: 3,
    handledInbound: 0,
    unhandledInbound: 3,
    executions: 0,
    unknownExecutions: 0,
    pendingCentral: 0
  }
  const digest = createHash('sha256').update(hashContext({ formatVersion: 1, context, scope }))
  for (const item of items) digest.update(hashContext(item))
  const manifest = {
    formatVersion: 1,
    evidenceKind: 'local_restored_metadata',
    context,
    scope,
    summary,
    basisHash: digest.update(hashContext(summary)).digest('hex'),
    canRelease: false,
    externalEvidenceRequired: true
  }
  uploadId = (
    await service.inventoryStart(token, {
      caseId,
      requestId: randomUUID(),
      challengeId: challenge.challengeId,
      manifest
    })
  ).uploadId
  await service.inventoryPage(token, { uploadId, index: 0, items })
  await service.inventoryComplete(token, { uploadId, pageCount: 1 })
  await login()
})
async function view(input: unknown = {}) {
  return admin.restoreRulings('A', 'account', caseId, uploadId, input)
}
async function ruling(
  subjectIndex = 0,
  outcome: 'accept_for_quarantine' | 'hold' = 'accept_for_quarantine'
) {
  const assessment = await admin.restoreAssessment('A', 'account', caseId, uploadId)
  const subject = assessment.items[subjectIndex]
  const evidence = await admin.recordRestoreEvidence('A', 'account', caseId, uploadId, {
    noteId: randomUUID(),
    basisHash: assessment.basisHash,
    subjectKey: subject.key,
    subjectHash: subject.subjectHash,
    kind: subject.requiredEvidence,
    referenceId: 'synthetic-reviewed-evidence',
    evidenceHash: 'e'.repeat(64),
    observedAt: Date.now()
  })
  return {
    rulingId: randomUUID(),
    basisHash: assessment.basisHash,
    subjectKey: subject.key,
    subjectHash: subject.subjectHash,
    noteId: evidence.noteId,
    noteReceiptHash: hashContext(evidence),
    expectedPreviousRulingId: null,
    outcome,
    evidenceReviewed: true as const
  }
}
async function acceptAll() {
  const assessment = await admin.restoreAssessment('A', 'account', caseId, uploadId)
  for (let i = 0; i < assessment.items.length; i++)
    await admin.recordRestoreRuling('A', 'account', caseId, uploadId, await ruling(i))
  return view()
}
function sealInput(coverage: Awaited<ReturnType<typeof view>>) {
  return {
    decisionId: randomUUID(),
    basisHash: coverage.basisHash,
    rulingsHash: coverage.rulingsHash,
    historyPolicy: 'quarantine',
    reviewedAllSubjects: true
  }
}
async function prepare() {
  const saved = await admin.sealRestoreDecision(
    'A',
    'account',
    caseId,
    uploadId,
    sealInput(await acceptAll())
  )
  await login('autoreply_app')
  return {
    saved,
    input: {
      caseId,
      uploadId,
      decisionId: saved.decisionId,
      restoreId: saved.restoreId,
      contextHash: saved.contextHash,
      decisionHash: hashContext(saved)
    }
  }
}
function service() {
  return new RestorePauseAuthority(new AccountAuthority(pg.db))
}
function applicationReceipt(saved: Awaited<ReturnType<typeof prepare>>['saved']) {
  return {
    applicationId: randomUUID(),
    scope: {
      tenant_id: 'A',
      employee_id: 'employee',
      account_id: 'account',
      agent_id: 'target',
      platform: 'wechat'
    },
    caseId,
    uploadId,
    decisionId: saved.decisionId,
    decisionHash: hashContext(saved),
    restoreId: saved.restoreId,
    contextHash: saved.contextHash,
    inventoryBasisHash: saved.inventoryBasisHash,
    postInventoryBasisHash: 'd'.repeat(64),
    quarantinedInboundCount: 3,
    ownedConversationCount: 1,
    appliedAt: Date.now(),
    centralConfirmationRequired: true,
    canRelease: false
  }
}
it('records one exact application acknowledgement and audit, retries identically, and keeps recovery blocked', async () => {
  const { saved } = await prepare(),
    receipt = applicationReceipt(saved)
  const first = await service().applicationAcknowledge(token, receipt)
  expect(first).toMatchObject({
    applicationId: receipt.applicationId,
    applicationHash: hashContext(receipt),
    status: 'quarantine_recorded',
    canRelease: false,
    automaticStart: false
  })
  expect(await service().applicationAcknowledge(token, receipt)).toEqual(first)
  await expect(
    service().applicationAcknowledge(token, { ...receipt, postInventoryBasisHash: 'f'.repeat(64) })
  ).rejects.toThrow('CONFLICT')
  await expect(
    service().applicationAcknowledge(token, {
      ...receipt,
      scope: { ...receipt.scope, account_id: 'other' }
    })
  ).rejects.toThrow('CONFLICT')
  await expect(
    service().applicationAcknowledge(token, { ...receipt, quarantinedInboundCount: 2 })
  ).rejects.toThrow('CONFLICT')
  await login()
  expect(
    (
      await pg.db.transaction('A', (db) =>
        db.query('SELECT count(*)::int AS n FROM ledger_restore_application_acks')
      )
    ).rows[0].n
  ).toBe(1)
  expect(
    (
      await pg.db.transaction('A', (db) =>
        db.query(
          "SELECT count(*)::int AS n FROM audit_events WHERE kind='ledger_restore_quarantine_recorded'"
        )
      )
    ).rows[0].n
  ).toBe(1)
  await expect(admin.resume('A', 'account')).rejects.toThrow('UNRESOLVED_RESTORE')
})
it('rolls back application acknowledgement if its audit fails and rejects stale or revoked target retries', async () => {
  const { saved } = await prepare(),
    receipt = applicationReceipt(saved)
  await owner(
    "CREATE FUNCTION test_restore_ack_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='ledger_restore_quarantine_recorded' THEN RAISE EXCEPTION 'synthetic_audit_failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER test_restore_ack_audit_failure BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION test_restore_ack_audit_failure()"
  )
  await login('autoreply_app')
  try {
    await expect(service().applicationAcknowledge(token, receipt)).rejects.toThrow(
      'synthetic_audit_failure'
    )
  } finally {
    await owner(
      'DROP TRIGGER test_restore_ack_audit_failure ON audit_events; DROP FUNCTION test_restore_ack_audit_failure()'
    )
  }
  expect(
    (
      await pg.db.transaction('A', (db) =>
        db.query('SELECT count(*)::int AS n FROM ledger_restore_application_acks')
      )
    ).rows[0].n
  ).toBe(0)
  await login('autoreply_app')
  await service().applicationAcknowledge(token, receipt)
  await owner("UPDATE agents SET revoked_at=clock_timestamp() WHERE id='target'")
  await login('autoreply_app')
  await expect(service().applicationAcknowledge(token, receipt)).rejects.toThrow('DENIED')
})
it('rejects an acknowledgement after the central basis changes even when the new permit has expired', async () => {
  const { saved } = await prepare(),
    receipt = applicationReceipt(saved)
  await owner(
    "INSERT INTO execution_permits(tenant_id,account_id,id,agent_id,lease_version,task_id,draft_hash,status,expires_at) VALUES('A','account','late-expired','target',3,'task',repeat('d',64),'issued',clock_timestamp()-interval '10 minutes')"
  )
  await login('autoreply_app')
  await expect(service().applicationAcknowledge(token, receipt)).rejects.toThrow('CONFLICT')
  await login()
  expect(
    (
      await pg.db.transaction('A', (db) =>
        db.query('SELECT count(*)::int AS n FROM ledger_restore_application_acks')
      )
    ).rows[0].n
  ).toBe(0)
})
it('returns only the exact current target decision and leaves the account and provenance blocked', async () => {
  const { saved, input } = await prepare()
  const result = await service().applicationDecision(token, input)
  expect(result).toMatchObject({
    decision: saved,
    decisionHash: hashContext(saved),
    scope: { tenant_id: 'A', account_id: 'account', agent_id: 'target' },
    manifest: { basisHash: saved.inventoryBasisHash },
    canRelease: false
  })
  expect(await service().applicationDecision(token, input)).toEqual(result)
  expect(
    (await pg.db.transaction('A', (db) => db.query('SELECT current_user'))).rows[0].current_user
  ).toBe('autoreply_app')
  await login()
  await expect(admin.resume('A', 'account')).rejects.toThrow('UNRESOLVED_RESTORE')
})
it('requires exact request hashes and target credentials and rejects malformed input', async () => {
  const { input } = await prepare()
  for (const mutation of [
    { caseId: randomUUID() },
    { uploadId: randomUUID() },
    { decisionId: randomUUID() },
    { restoreId: randomUUID() },
    { contextHash: 'f'.repeat(64) },
    { decisionHash: 'f'.repeat(64) },
    { canRelease: true },
    { tenantId: 'A' }
  ])
    await expect(service().applicationDecision(token, { ...input, ...mutation })).rejects.toThrow()
  await expect(service().applicationDecision('Z'.repeat(43), input)).rejects.toThrow('DENIED')
  await owner(
    `INSERT INTO agents(tenant_id,id,account_id,employee_id,token_hash) VALUES('A','other-device','account','employee','${tokenHash('S'.repeat(43))}')`
  )
  await login('autoreply_app')
  await expect(service().applicationDecision('S'.repeat(43), input)).rejects.toThrow()
})
it('rejects a changed full basis, active leases, newly issued permits and revoked targets', async () => {
  const { input } = await prepare()
  await owner(
    "INSERT INTO account_leases(tenant_id,account_id,agent_id,login_epoch,client_instance_id,version,expires_at) VALUES('A','account','target',3,'new',4,clock_timestamp()+interval '10 minutes')"
  )
  await login('autoreply_app')
  await expect(service().applicationDecision(token, input)).rejects.toThrow()
  await owner(
    "DELETE FROM account_leases; INSERT INTO execution_permits(tenant_id,account_id,id,agent_id,lease_version,task_id,draft_hash,status,expires_at) VALUES('A','account','late','target',3,'task',repeat('d',64),'issued',clock_timestamp()+interval '10 minutes')"
  )
  await login('autoreply_app')
  await expect(service().applicationDecision(token, input)).rejects.toThrow()
  await owner("UPDATE agents SET revoked_at=clock_timestamp() WHERE id='target'")
  await login('autoreply_app')
  await expect(service().applicationDecision(token, input)).rejects.toThrow('DENIED')
})
it('rejects damaged stored decisions and evidence and restores the normal connection role on rollback', async () => {
  const { input } = await prepare()
  await owner("UPDATE ledger_restore_decisions SET receipt_hash=repeat('f',64)")
  await login('autoreply_app')
  await expect(service().applicationDecision(token, input)).rejects.toThrow()
  expect(
    (await pg.db.transaction('A', (db) => db.query('SELECT current_user'))).rows[0].current_user
  ).toBe('autoreply_app')
})
it('does not inherit protected administrator reads and limits the scoped reader to its authenticated case', async () => {
  const { input } = await prepare()
  await service().applicationDecision(token, input)
  for (const table of [
    'ledger_restore_evidence',
    'ledger_restore_rulings',
    'ledger_restore_decisions'
  ]) {
    await expect(
      pg.db.transaction('A', (db) => db.query(`SELECT * FROM ${table}`))
    ).rejects.toThrow('permission denied')
  }
  await pg.db
    .transaction('A', async (db) => {
      await db.query(
        "SELECT set_config('app.restore_read_credential_hash',$1,true),set_config('app.restore_read_case_id',$2,true)",
        [tokenHash(token), caseId]
      )
      await db.query('SET LOCAL ROLE autoreply_restore_reader')
      expect((await db.query('SELECT id FROM accounts ORDER BY id')).rows).toEqual([
        { id: 'account' }
      ])
      await expect(db.query('SELECT token_hash FROM agents')).rejects.toThrow('permission denied')
    })
    .catch((error) => {
      if (!String(error).includes('permission denied')) throw error
    })
  await expect(
    pg.db.transaction('A', async (db) => {
      await db.query('SET LOCAL ROLE autoreply_restore_reader')
      await db.query('INSERT INTO ledger_restore_decisions DEFAULT VALUES')
    })
  ).rejects.toThrow('permission denied')
})
it('serves private HTTP and a registered main-process client with strict request and response binding', async () => {
  const { saved, input } = await prepare()
  const server = createServer(
    createApplication(new AccountAuthority(pg.db), { restoration: service() })
  )
  const origin = await listenFetchLoopback(server)
  const scope = {
    tenant_id: 'A',
    employee_id: 'employee',
    account_id: 'account',
    agent_id: 'target',
    platform: 'wechat' as const
  }
  const client = new AgentRegistration(
    {
      load: () => ({ serverUrl: origin, encryptedCredential: 'synthetic-cipher', scope }),
      save: () => {
        throw Error('unexpected_write')
      }
    },
    { available: () => true, encrypt: () => '', decrypt: () => token },
    fetch,
    true
  )
  try {
    const result = await client.restoreApplicationDecision(input, scope)
    expect(result.decision).toEqual(saved)
    expect(
      await client.restoreLatestApplicationDecision(
        { caseId, restoreId: saved.restoreId, contextHash: saved.contextHash },
        scope
      )
    ).toEqual(result)
    const receipt = applicationReceipt(saved),
      ack = await client.acknowledgeRestoreApplication(receipt)
    expect(ack.applicationHash).toBe(hashContext(receipt))
    expect(await client.acknowledgeRestoreApplication(receipt)).toEqual(ack)
    const unauthorized = await fetch(origin + '/v1/restorations/application/decision', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input)
    })
    expect(unauthorized.status).toBe(401)
    const invalid = await fetch(origin + '/v1/restorations/application/decision', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify({ ...input, path: 'private.sqlite' })
    })
    expect(invalid.status).toBe(400)
  } finally {
    const closed = new Promise<void>((done) => server.close(() => done()))
    server.closeAllConnections()
    await closed
  }
})
it('rejects forged response bindings before any local application and refuses a changed client scope', async () => {
  const { input } = await prepare(),
    result = await service().applicationDecision(token, input)
  const scope = result.scope
  let requests = 0
  const returned = structuredClone(result)
  returned.decision.caseId = randomUUID()
  returned.decisionHash = hashContext(returned.decision)
  const client = new AgentRegistration(
    {
      load: () => ({ serverUrl: 'http://127.0.0.1:4782', encryptedCredential: 'synthetic', scope }),
      save: () => {}
    },
    { available: () => true, encrypt: () => '', decrypt: () => token },
    async () => {
      requests++
      return new Response(JSON.stringify(returned), { status: 200 })
    },
    true
  )
  await expect(client.restoreApplicationDecision(input, scope)).rejects.toThrow('INVALID_RESPONSE')
  expect(requests).toBe(1)
  await expect(
    client.restoreApplicationDecision(input, { ...scope, account_id: 'other' })
  ).rejects.toThrow('DEVICE_SCOPE_CHANGED')
  expect(requests).toBe(1)
})
