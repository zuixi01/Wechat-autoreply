import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { embeddedPostgres } from '../fixtures/embedded-postgres'
import { Administration } from '../../server/src/admin/administration'
import { AccountAuthority, tokenHash } from '../../server/src/auth/account-authority'
import { RestorePauseAuthority } from '../../server/src/execution/restore-pause-authority'
import { hashContext } from '../../src/core/reply/hashes'
import { executeAdminCommand, parseAdminCommand } from '../../server/src/admin/command'

let pg: Awaited<ReturnType<typeof embeddedPostgres>>, admin: Administration
let caseId: string, uploadId: string
const token = 'R'.repeat(43)
async function login(role = 'restore_decisions_admin') {
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
    'CREATE ROLE restore_decisions_admin LOGIN NOSUPERUSER NOBYPASSRLS; GRANT autoreply_admin TO restore_decisions_admin'
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
    INSERT INTO admin_database_principals(login_name,tenant_id,employee_id) VALUES('restore_decisions_admin','A','admin');
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
it('counts every subject even when displaying one and preserves immutable historical retries', async () => {
  const first = await view({ limit: 1 })
  expect(first.summary).toEqual({ subjects: 4, accepted: 0, held: 0, missing: 4 })
  const input = await ruling(1)
  const saved = await admin.recordRestoreRuling('A', 'account', caseId, uploadId, input)
  expect(saved).toMatchObject({ revision: 1, recordedBy: 'admin', canRelease: false })
  expect(await admin.recordRestoreRuling('A', 'account', caseId, uploadId, input)).toEqual(saved)
  const after = await view({ limit: 1 })
  expect(after.summary).toEqual({ subjects: 4, accepted: 1, held: 0, missing: 3 })
  expect(after.rulingsHash).not.toBe(first.rulingsHash)
  await expect(
    view({
      after: first.nextAfter,
      expectedBasisHash: first.basisHash,
      expectedRulingsHash: first.rulingsHash
    })
  ).rejects.toThrow('RESTORE_REVIEW_CONFLICT')
  await owner(
    "INSERT INTO execution_permits(tenant_id,account_id,id,agent_id,lease_version,task_id,draft_hash,status,expires_at) VALUES('A','account','new','target',3,'task',repeat('d',64),'unknown',clock_timestamp())"
  )
  expect((await view()).summary).toEqual({ subjects: 5, accepted: 0, held: 0, missing: 5 })
  expect(await admin.recordRestoreRuling('A', 'account', caseId, uploadId, input)).toEqual(saved)
  await expect(
    admin.recordRestoreRuling('A', 'account', caseId, uploadId, {
      ...input,
      rulingId: randomUUID()
    })
  ).rejects.toThrow('RESTORE_REVIEW_CONFLICT')
})
it('requires exact evidence receipt, kind, object, basis and explicit human review', async () => {
  const input = await ruling()
  for (const mutation of [
    { noteId: randomUUID() },
    { noteReceiptHash: 'f'.repeat(64) },
    { subjectHash: 'f'.repeat(64) },
    { subjectKey: `p:${'a'.repeat(64)}` },
    { basisHash: 'a'.repeat(64) },
    { evidenceReviewed: false },
    { canRelease: true },
    { reply: 'customer text' }
  ]) {
    await expect(
      admin.recordRestoreRuling('A', 'account', caseId, uploadId, { ...input, ...mutation })
    ).rejects.toThrow()
  }
  const other = await ruling(1)
  await expect(
    admin.recordRestoreRuling('A', 'account', caseId, uploadId, {
      ...input,
      noteId: other.noteId,
      noteReceiptHash: other.noteReceiptHash
    })
  ).rejects.toThrow()
  expect((await view()).summary.accepted).toBe(0)
})
it('appends corrections with an exact previous ID and refuses silent concurrent overwrites', async () => {
  const initial = await ruling(0, 'hold')
  const first = await admin.recordRestoreRuling('A', 'account', caseId, uploadId, initial)
  const changed = {
    ...initial,
    rulingId: randomUUID(),
    outcome: 'accept_for_quarantine',
    expectedPreviousRulingId: first.rulingId
  }
  const second = await admin.recordRestoreRuling('A', 'account', caseId, uploadId, changed)
  expect(second).toMatchObject({ revision: 2, expectedPreviousRulingId: first.rulingId })
  expect((await view()).summary).toMatchObject({ accepted: 1, held: 0 })
  await expect(
    admin.recordRestoreRuling('A', 'account', caseId, uploadId, {
      ...changed,
      rulingId: randomUUID(),
      outcome: 'hold'
    })
  ).rejects.toThrow()
  await expect(
    admin.recordRestoreRuling('A', 'account', caseId, uploadId, {
      ...initial,
      outcome: 'accept_for_quarantine'
    })
  ).rejects.toThrow()
  expect(await admin.recordRestoreRuling('A', 'account', caseId, uploadId, initial)).toEqual(first)
})
it('refuses missing, held or stale coverage and seals complete quarantine without releasing the account', async () => {
  await expect(
    admin.sealRestoreDecision('A', 'account', caseId, uploadId, sealInput(await view()))
  ).rejects.toThrow()
  for (let i = 0; i < 4; i++)
    await admin.recordRestoreRuling(
      'A',
      'account',
      caseId,
      uploadId,
      await ruling(i, i === 3 ? 'hold' : 'accept_for_quarantine')
    )
  const held = await view()
  await expect(
    admin.sealRestoreDecision('A', 'account', caseId, uploadId, sealInput(held))
  ).rejects.toThrow()
  const previous = held.items[3].latestRuling!
  await admin.recordRestoreRuling('A', 'account', caseId, uploadId, {
    ...(await ruling(3)),
    expectedPreviousRulingId: previous.rulingId
  })
  await expect(
    admin.sealRestoreDecision('A', 'account', caseId, uploadId, sealInput(held))
  ).rejects.toThrow()
  const current = await view(),
    input = sealInput(current)
  const decision = await admin.sealRestoreDecision('A', 'account', caseId, uploadId, input)
  expect(decision).toMatchObject({
    subjectCount: 4,
    historyPolicy: 'quarantine',
    canRelease: false,
    applicationRequired: true,
    automaticStart: false
  })
  expect(await admin.sealRestoreDecision('A', 'account', caseId, uploadId, input)).toEqual(decision)
  expect(
    await admin.restoreDecision('A', 'account', caseId, uploadId, decision.decisionId)
  ).toMatchObject({
    decision,
    currentBasis: true,
    canRelease: false
  })
  await expect(admin.resume('A', 'account')).rejects.toThrow('UNRESOLVED_RESTORE')
  const correction = {
    ...(await ruling(0)),
    expectedPreviousRulingId: current.items[0].latestRuling!.rulingId
  }
  await expect(
    admin.recordRestoreRuling('A', 'account', caseId, uploadId, correction)
  ).rejects.toThrow()
  await expect(
    admin.sealRestoreDecision('A', 'account', caseId, uploadId, {
      ...input,
      decisionId: randomUUID()
    })
  ).rejects.toThrow()
})
it('keeps decisions historical when the full basis changes and refuses corrupt ruling chains or evidence', async () => {
  const coverage = await acceptAll(),
    input = sealInput(coverage)
  const saved = await admin.sealRestoreDecision('A', 'account', caseId, uploadId, input)
  await owner("UPDATE agents SET revoked_at=clock_timestamp() WHERE id='target'")
  expect(
    (await admin.restoreDecision('A', 'account', caseId, uploadId, saved.decisionId)).currentBasis
  ).toBe(false)
  expect(await admin.sealRestoreDecision('A', 'account', caseId, uploadId, input)).toEqual(saved)
  await owner("UPDATE ledger_restore_rulings SET receipt_hash=repeat('f',64)")
  await expect(
    admin.restoreDecision('A', 'account', caseId, uploadId, saved.decisionId)
  ).rejects.toThrow()
})
it('refuses tampered current evidence rather than counting its ruling as accepted', async () => {
  const input = await ruling()
  await admin.recordRestoreRuling('A', 'account', caseId, uploadId, input)
  await owner("UPDATE ledger_restore_evidence SET subject_hash=repeat('f',64)")
  await expect(view()).rejects.toThrow('RESTORE_REVIEW_CONFLICT')
})
it('requires enabled independent administrator login and exact scope', async () => {
  const input = await ruling()
  for (const [account, review, upload] of [
    ['other', caseId, uploadId],
    ['account', randomUUID(), uploadId],
    ['account', caseId, randomUUID()]
  ])
    await expect(admin.recordRestoreRuling('A', account, review, upload, input)).rejects.toThrow()
  await login('autoreply_app')
  await expect(view()).rejects.toThrow('DENIED')
  await expect(admin.recordRestoreRuling('A', 'account', caseId, uploadId, input)).rejects.toThrow(
    'DENIED'
  )
  await login()
  await owner("UPDATE employees SET enabled=false WHERE id='admin'")
  await expect(view()).rejects.toThrow('DENIED')
})
it('rolls back ruling and decision inserts on audit failure and denies modification by runtime roles', async () => {
  const input = await ruling()
  await owner(`CREATE FUNCTION autoreply.reject_restore_decision_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind IN ('ledger_restore_ruling_recorded','ledger_restore_decision_sealed') THEN RAISE EXCEPTION 'synthetic_audit_failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_restore_decision_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION autoreply.reject_restore_decision_audit()`)
  try {
    await expect(
      admin.recordRestoreRuling('A', 'account', caseId, uploadId, input)
    ).rejects.toThrow('synthetic_audit_failure')
    expect((await view()).summary.missing).toBe(4)
    await owner('ALTER TABLE audit_events DISABLE TRIGGER reject_restore_decision_audit')
    const coverage = await acceptAll()
    await owner('ALTER TABLE audit_events ENABLE TRIGGER reject_restore_decision_audit')
    await expect(
      admin.sealRestoreDecision('A', 'account', caseId, uploadId, sealInput(coverage))
    ).rejects.toThrow('synthetic_audit_failure')
    expect(
      (
        await pg.db.transaction('A', (db) =>
          db.query('SELECT count(*)::int AS count FROM ledger_restore_decisions')
        )
      ).rows[0].count
    ).toBe(0)
  } finally {
    await owner(
      'DROP TRIGGER reject_restore_decision_audit ON audit_events; DROP FUNCTION autoreply.reject_restore_decision_audit()'
    )
  }
  for (const table of ['ledger_restore_rulings', 'ledger_restore_decisions']) {
    await expect(pg.db.transaction('A', (db) => db.query(`DELETE FROM ${table}`))).rejects.toThrow(
      'permission denied'
    )
    await expect(
      pg.db.transaction('A', (db) => db.query(`UPDATE ${table} SET receipt_hash=repeat('f',64)`))
    ).rejects.toThrow('permission denied')
  }
  await login('autoreply_app')
  for (const table of ['ledger_restore_rulings', 'ledger_restore_decisions']) {
    await expect(
      pg.db.transaction('A', (db) => db.query(`SELECT * FROM ${table}`))
    ).rejects.toThrow('permission denied')
    await expect(
      pg.db.transaction('A', (db) => db.query(`INSERT INTO ${table} DEFAULT VALUES`))
    ).rejects.toThrow('permission denied')
  }
})
it('canonicalizes UUID case and exposes strict executable administrator commands', async () => {
  const original = await ruling()
  const input = {
    ...original,
    rulingId: original.rulingId.toUpperCase(),
    noteId: original.noteId.toUpperCase()
  }
  const saved = await admin.recordRestoreRuling(
    'A',
    'account',
    caseId.toUpperCase(),
    uploadId.toUpperCase(),
    input
  )
  expect(saved.rulingId).toBe(input.rulingId.toLowerCase())
  const cmd = parseAdminCommand([
    'restore-rulings',
    '--tenant',
    'A',
    '--account',
    'account',
    '--case',
    caseId,
    '--upload',
    uploadId,
    '--limit',
    '1'
  ])
  expect(
    await executeAdminCommand(admin, cmd, async () => {
      throw Error('unexpected_read')
    })
  ).toMatchObject({ summary: { accepted: 1 } })
  const record = parseAdminCommand([
    'record-restore-ruling',
    '--tenant',
    'A',
    '--account',
    'account',
    '--case',
    caseId,
    '--upload',
    uploadId,
    '--file',
    'ruling.json'
  ])
  expect(await executeAdminCommand(admin, record, async () => input)).toEqual(saved)
  expect(() =>
    parseAdminCommand([
      'restore-rulings',
      '--tenant',
      'A',
      '--account',
      'account',
      '--case',
      caseId,
      '--upload',
      uploadId,
      '--after',
      'a:' + 'a'.repeat(64)
    ])
  ).toThrow()
  expect(() =>
    parseAdminCommand([
      'restore-rulings',
      '--tenant',
      'A',
      '--account',
      'account',
      '--case',
      caseId,
      '--upload',
      uploadId,
      '--file',
      'secret.json'
    ])
  ).toThrow()
})
it('counts undisplayed centrally missing executions and never seals a partially reviewed page', async () => {
  await owner(`INSERT INTO execution_permits(tenant_id,account_id,id,agent_id,lease_version,task_id,draft_hash,status,expires_at)
    SELECT 'A','account','page-'||n,'target',3,'task-'||n,repeat('d',64),'unknown',clock_timestamp() FROM generate_series(1,101) n`)
  await admin.recordRestoreRuling('A', 'account', caseId, uploadId, await ruling(0))
  const first = await view({ limit: 1 })
  expect(first.summary).toEqual({ subjects: 105, accepted: 1, held: 0, missing: 104 })
  expect(first.items).toHaveLength(1)
  const second = await view({
    limit: 100,
    after: first.nextAfter,
    expectedBasisHash: first.basisHash,
    expectedRulingsHash: first.rulingsHash
  })
  expect(second.items).toHaveLength(100)
  expect(second.summary).toEqual(first.summary)
  expect(second.rulingsHash).toBe(first.rulingsHash)
  await expect(
    admin.sealRestoreDecision('A', 'account', caseId, uploadId, sealInput(first))
  ).rejects.toThrow()
})
it('validates saved decision and ruling actors against their hashed receipts', async () => {
  const current = await acceptAll(),
    input = sealInput(current)
  const saved = await admin.sealRestoreDecision('A', 'account', caseId, uploadId, input)
  await owner("UPDATE ledger_restore_decisions SET recorded_by='employee'")
  await expect(
    admin.restoreDecision('A', 'account', caseId, uploadId, saved.decisionId)
  ).rejects.toThrow()
  await owner(
    "UPDATE ledger_restore_decisions SET recorded_by='admin'; UPDATE ledger_restore_rulings SET recorded_by='employee'"
  )
  await expect(view()).rejects.toThrow()
})
it('refuses a correction when a sealed decision lookup column was damaged', async () => {
  const coverage = await acceptAll()
  await admin.sealRestoreDecision('A', 'account', caseId, uploadId, sealInput(coverage))
  const correction = {
    ...(await ruling(0)),
    outcome: 'hold',
    expectedPreviousRulingId: coverage.items[0].latestRuling!.rulingId
  }
  await owner("UPDATE ledger_restore_decisions SET basis_hash=repeat('f',64)")
  await expect(
    admin.recordRestoreRuling('A', 'account', caseId, uploadId, correction)
  ).rejects.toThrow('RESTORE_REVIEW_CONFLICT')
  expect(
    (
      await pg.db.transaction('A', (db) =>
        db.query('SELECT count(*)::int AS count FROM ledger_restore_rulings')
      )
    ).rows[0].count
  ).toBe(4)
  await expect(
    admin.sealRestoreDecision('A', 'account', caseId, uploadId, sealInput(coverage))
  ).rejects.toThrow('RESTORE_REVIEW_CONFLICT')
  expect(
    (
      await pg.db.transaction('A', (db) =>
        db.query('SELECT count(*)::int AS count FROM ledger_restore_decisions')
      )
    ).rows[0].count
  ).toBe(1)
})
it('refuses damaged ruling basis columns instead of treating the record as missing', async () => {
  const input = await ruling()
  await admin.recordRestoreRuling('A', 'account', caseId, uploadId, input)
  await owner("UPDATE ledger_restore_rulings SET basis_hash=repeat('f',64)")
  await expect(view()).rejects.toThrow('RESTORE_REVIEW_CONFLICT')
  await expect(
    admin.recordRestoreRuling('A', 'account', caseId, uploadId, {
      ...input,
      rulingId: randomUUID()
    })
  ).rejects.toThrow('RESTORE_REVIEW_CONFLICT')
})
