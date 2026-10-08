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
async function login(role = 'restore_assessment_admin') {
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
    'CREATE ROLE restore_assessment_admin LOGIN NOSUPERUSER NOBYPASSRLS; GRANT autoreply_admin TO restore_assessment_admin'
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
    INSERT INTO admin_database_principals(login_name,tenant_id,employee_id) VALUES('restore_assessment_admin','A','admin');
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
async function assessment(input: unknown = {}) {
  return admin.restoreAssessment('A', 'account', caseId, uploadId, input)
}
async function newPermit(id = 'new-after-backup') {
  await owner(
    `INSERT INTO execution_permits(tenant_id,account_id,id,agent_id,lease_version,task_id,draft_hash,status,expires_at) VALUES('A','account','${id}','target',3,'new-task','${'d'.repeat(64)}','unknown',clock_timestamp()-interval '1 minute')`
  )
}
it('binds every record and all devices while paginating one display item and never grants release', async () => {
  const first = await assessment({ limit: 1 })
  expect(first.summary).toMatchObject({ localItems: 3, centralPermits: 0, subjects: 4 })
  expect(first.items[0]).toMatchObject({
    kind: 'account',
    requiredEvidence: 'device_stop',
    canRelease: false
  })
  const second = await assessment({
    limit: 1,
    after: first.nextAfter,
    expectedBasisHash: first.basisHash
  })
  expect(second.items[0]).toMatchObject({
    kind: 'local_message',
    requiredEvidence: 'message_history'
  })
  expect(second.basisHash).toBe(first.basisHash)
  expect(first).toMatchObject({ canRelease: false, externalEvidenceRequired: true })
  await expect(assessment({ limit: 1, after: first.nextAfter })).rejects.toThrow()
  await expect(admin.resume('A', 'account')).rejects.toThrow('UNRESOLVED_RESTORE')
})
it('covers centrally recorded executions absent from the backup and rejects a previous full basis', async () => {
  const before = await assessment({ limit: 1 })
  await newPermit()
  const after = await assessment({ limit: 100 })
  expect(after.summary).toMatchObject({
    centralPermits: 1,
    centralAbsentLocally: 1,
    unresolvedCentral: 1,
    subjects: 5
  })
  expect(after.items.find((item) => item.kind === 'central_permit')).toMatchObject({
    requiredEvidence: 'execution_outcome',
    reasons: expect.arrayContaining(['absent_from_restored_ledger', 'central_outcome_unresolved'])
  })
  await expect(
    assessment({ after: before.nextAfter, expectedBasisHash: before.basisHash })
  ).rejects.toThrow('RESTORE_REVIEW_CONFLICT')
})
it('records immutable evidence references, retries the same historical request and marks late-basis evidence as historical', async () => {
  const before = await assessment()
  const subject = before.items.find((item) => item.kind === 'local_message')!
  const input = {
    noteId: randomUUID(),
    basisHash: before.basisHash,
    subjectKey: subject.key,
    subjectHash: subject.subjectHash,
    kind: subject.requiredEvidence,
    referenceId: 'external-case-7',
    evidenceHash: 'e'.repeat(64),
    observedAt: Date.now()
  }
  const receipt = await admin.recordRestoreEvidence('A', 'account', caseId, uploadId, input)
  expect(await admin.recordRestoreEvidence('A', 'account', caseId, uploadId, input)).toEqual(
    receipt
  )
  await expect(
    admin.recordRestoreEvidence('A', 'account', caseId, uploadId, {
      ...input,
      evidenceHash: 'f'.repeat(64)
    })
  ).rejects.toThrow('RESTORE_REVIEW_CONFLICT')
  expect((await admin.restoreEvidence('A', 'account', caseId, uploadId)).items[0]).toMatchObject({
    currentBasis: true,
    receipt: { noteId: input.noteId, recordedBy: 'admin', canRelease: false }
  })
  await newPermit()
  expect(await admin.recordRestoreEvidence('A', 'account', caseId, uploadId, input)).toEqual(
    receipt
  )
  expect((await admin.restoreEvidence('A', 'account', caseId, uploadId)).items[0]).toMatchObject({
    currentBasis: false
  })
  await expect(
    admin.recordRestoreEvidence('A', 'account', caseId, uploadId, {
      ...input,
      noteId: randomUUID()
    })
  ).rejects.toThrow('RESTORE_REVIEW_CONFLICT')
  await expect(admin.resume('A', 'account')).rejects.toThrow('UNRESOLVED_RESTORE')
})
it('rejects wrong objects, extra content, wrong evidence kinds and future or pre-review observations', async () => {
  const view = await assessment()
  const subject = view.items.find((item) => item.kind === 'local_message')!
  const input = {
    noteId: randomUUID(),
    basisHash: view.basisHash,
    subjectKey: subject.key,
    subjectHash: subject.subjectHash,
    kind: subject.requiredEvidence,
    referenceId: 'ref-1',
    evidenceHash: 'e'.repeat(64),
    observedAt: Date.now()
  }
  for (const mutation of [
    { subjectHash: 'f'.repeat(64) },
    { subjectKey: `p:${'a'.repeat(64)}` },
    { kind: 'device_stop' },
    { observedAt: Date.now() + 60000 },
    { observedAt: 0 },
    { text: 'must not store customer text' },
    { canRelease: true }
  ]) {
    await expect(
      admin.recordRestoreEvidence('A', 'account', caseId, uploadId, { ...input, ...mutation })
    ).rejects.toThrow()
  }
  expect((await admin.restoreEvidence('A', 'account', caseId, uploadId)).items).toHaveLength(0)
})
it('requires independent enabled administrator credentials and exact account/case/upload binding', async () => {
  await expect(admin.restoreAssessment('A', 'other', caseId, uploadId)).rejects.toThrow()
  await expect(admin.restoreAssessment('A', 'account', randomUUID(), uploadId)).rejects.toThrow()
  await expect(admin.restoreAssessment('A', 'account', caseId, randomUUID())).rejects.toThrow()
  await login('autoreply_app')
  await expect(assessment()).rejects.toThrow('DENIED')
  await login()
  await owner("UPDATE employees SET enabled=false WHERE id='admin'")
  await expect(assessment()).rejects.toThrow('DENIED')
})
it('binds device revocation and lease changes into the complete basis', async () => {
  const before = await assessment()
  await owner("UPDATE agents SET revoked_at=clock_timestamp() WHERE id='target'")
  const after = await assessment()
  expect(after.basisHash).not.toBe(before.basisHash)
  await expect(assessment({ expectedBasisHash: before.basisHash })).rejects.toThrow(
    'RESTORE_REVIEW_CONFLICT'
  )
})
it('exposes strict CLI commands using the actual administrator implementation', async () => {
  const command = parseAdminCommand([
    'restore-assessment',
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
    await executeAdminCommand(admin, command, async () => {
      throw Error('unexpected_file')
    })
  ).toMatchObject({ summary: { subjects: 4 }, canRelease: false })
  expect(() =>
    parseAdminCommand([
      'restore-assessment',
      '--tenant',
      'A',
      '--account',
      'account',
      '--case',
      caseId,
      '--upload',
      uploadId,
      '--file',
      'private.json'
    ])
  ).toThrow()
})

it('covers more than a display page and invalidates its basis when an undisplayed permit changes', async () => {
  await owner(`INSERT INTO execution_permits(tenant_id,account_id,id,agent_id,lease_version,task_id,draft_hash,status,expires_at)
    SELECT 'A','account','page-'||lpad(n::text,4,'0'),'target',3,'task-'||n,'${'d'.repeat(64)}','unknown',clock_timestamp()-interval '1 minute' FROM generate_series(1,101) n`)
  const first = await assessment({ limit: 100 })
  expect(first.summary).toMatchObject({
    centralPermits: 101,
    centralAbsentLocally: 101,
    subjects: 105
  })
  const second = await assessment({
    limit: 100,
    after: first.nextAfter,
    expectedBasisHash: first.basisHash
  })
  expect(second.items).toHaveLength(5)
  expect(second.nextAfter).toBeNull()
  expect(new Set([...first.items, ...second.items].map((item) => item.key)).size).toBe(105)
  const unseen = second.items.find((item) => item.kind === 'central_permit')!
  const permit = unseen.metadata as { permitId: string }
  expect(permit.permitId).toMatch(/^page-[0-9]{4}$/)
  await owner(
    `UPDATE execution_permits SET task_id='changed-last-item' WHERE id='${permit.permitId}'`
  )
  await expect(
    assessment({ after: first.nextAfter, expectedBasisHash: first.basisHash })
  ).rejects.toThrow('RESTORE_REVIEW_CONFLICT')
})

it('rolls back a new evidence record when audit insertion fails and forbids database mutation by both runtime roles', async () => {
  const view = await assessment(),
    subject = view.items[0]
  const input = {
    noteId: randomUUID(),
    basisHash: view.basisHash,
    subjectKey: subject.key,
    subjectHash: subject.subjectHash,
    kind: subject.requiredEvidence,
    referenceId: 'stop-evidence',
    evidenceHash: 'e'.repeat(64),
    observedAt: Date.now()
  }
  await owner(`CREATE FUNCTION autoreply.reject_restore_evidence_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='ledger_restore_evidence_recorded' THEN RAISE EXCEPTION 'synthetic_audit_failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_restore_evidence_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION autoreply.reject_restore_evidence_audit()`)
  try {
    await expect(
      admin.recordRestoreEvidence('A', 'account', caseId, uploadId, input)
    ).rejects.toThrow('synthetic_audit_failure')
    expect((await admin.restoreEvidence('A', 'account', caseId, uploadId)).items).toHaveLength(0)
  } finally {
    await owner(
      'DROP TRIGGER reject_restore_evidence_audit ON audit_events; DROP FUNCTION autoreply.reject_restore_evidence_audit()'
    )
  }
  await admin.recordRestoreEvidence('A', 'account', caseId, uploadId, input)
  await expect(
    pg.db.transaction('A', (db) =>
      db.query('UPDATE ledger_restore_evidence SET subject_hash=$1', ['f'.repeat(64)])
    )
  ).rejects.toThrow('permission denied')
  await expect(
    pg.db.transaction('A', (db) => db.query('DELETE FROM ledger_restore_evidence'))
  ).rejects.toThrow('permission denied')
  await login('autoreply_app')
  await expect(
    pg.db.transaction('A', (db) => db.query('SELECT * FROM ledger_restore_evidence'))
  ).rejects.toThrow('permission denied')
  await expect(
    pg.db.transaction('A', (db) => db.query('INSERT INTO ledger_restore_evidence DEFAULT VALUES'))
  ).rejects.toThrow('permission denied')
})

it('rejects damaged source items and damaged saved evidence rather than presenting a valid assessment', async () => {
  const view = await assessment(),
    subject = view.items[0]
  const input = {
    noteId: randomUUID(),
    basisHash: view.basisHash,
    subjectKey: subject.key,
    subjectHash: subject.subjectHash,
    kind: subject.requiredEvidence,
    referenceId: 'ref-corruption',
    evidenceHash: 'e'.repeat(64),
    observedAt: Date.now()
  }
  await admin.recordRestoreEvidence('A', 'account', caseId, uploadId, input)
  await owner("UPDATE ledger_restore_evidence SET subject_hash=repeat('f',64)")
  await expect(admin.restoreEvidence('A', 'account', caseId, uploadId)).rejects.toThrow(
    'RESTORE_REVIEW_CONFLICT'
  )
  await owner(
    "UPDATE ledger_restore_inventory_items SET item_json=jsonb_set(item_json,'{handledBy}',to_jsonb('forged'::text)) WHERE item_json->>'sourceMessageId'='msg-3'"
  )
  await expect(assessment()).rejects.toThrow('RESTORE_REVIEW_CONFLICT')
})

it('canonicalizes valid uppercase UUIDs before storing evidence and supports lowercase retries', async () => {
  const view = await assessment(),
    subject = view.items[0]
  const noteId = 'ABCDEFAB-1234-4234-8234-ABCDEFABCDEF'
  const input = {
    noteId,
    basisHash: view.basisHash,
    subjectKey: subject.key,
    subjectHash: subject.subjectHash,
    kind: subject.requiredEvidence,
    referenceId: 'case-uuid',
    evidenceHash: 'e'.repeat(64),
    observedAt: Date.now()
  }
  const saved = await admin.recordRestoreEvidence(
    'A',
    'account',
    caseId.toUpperCase(),
    uploadId.toUpperCase(),
    input
  )
  expect(saved.noteId).toBe(noteId.toLowerCase())
  expect(
    await admin.recordRestoreEvidence('A', 'account', caseId, uploadId, {
      ...input,
      noteId: noteId.toLowerCase()
    })
  ).toEqual(saved)
  expect((await admin.restoreEvidence('A', 'account', caseId, uploadId)).items[0]).toMatchObject({
    currentBasis: true,
    receipt: { noteId: noteId.toLowerCase() }
  })
})

it('keeps equivalent time zones stable while preserving single-microsecond permit and lease changes', async () => {
  await newPermit()
  await owner(`UPDATE agents SET revoked_at='2026-10-04T00:00:00.123456Z' WHERE id='target';
    INSERT INTO account_leases(tenant_id,account_id,agent_id,login_epoch,client_instance_id,version,expires_at) VALUES('A','account','target',3,'old-process',3,'2026-10-04T00:00:00.123456Z')`)
  await pg.sql.exec("SET TIME ZONE 'UTC'")
  const before = await assessment()
  const subject = before.items[0],
    input = {
      noteId: randomUUID(),
      basisHash: before.basisHash,
      subjectKey: subject.key,
      subjectHash: subject.subjectHash,
      kind: subject.requiredEvidence,
      referenceId: 'tz-evidence',
      evidenceHash: 'e'.repeat(64),
      observedAt: Date.now()
    }
  await admin.recordRestoreEvidence('A', 'account', caseId, uploadId, input)
  try {
    await pg.sql.exec("SET TIME ZONE 'Asia/Shanghai'")
    expect((await assessment()).basisHash).toBe(before.basisHash)
    expect(
      (await admin.restoreEvidence('A', 'account', caseId, uploadId)).items[0].currentBasis
    ).toBe(true)
    await owner("UPDATE account_leases SET expires_at=expires_at+interval '1 microsecond'")
    const leaseChanged = await assessment()
    expect(leaseChanged.basisHash).not.toBe(before.basisHash)
    await owner("UPDATE execution_permits SET expires_at=expires_at+interval '1 microsecond'")
    expect((await assessment()).basisHash).not.toBe(leaseChanged.basisHash)
  } finally {
    await pg.sql.exec("SET TIME ZONE 'UTC'")
  }
})
