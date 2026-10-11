import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'

// The 1001-row pagination audit performs actual embedded PostgreSQL writes.
vi.setConfig({ testTimeout: 20000 })
import { embeddedPostgres } from '../fixtures/embedded-postgres'
import { Administration } from '../../server/src/admin/administration'
import { AccountAuthority, tokenHash } from '../../server/src/auth/account-authority'
import { ExecutionAuthority } from '../../server/src/execution/execution-authority'
import { hashContext } from '../../src/core/reply/hashes'
import { executeAdminCommand, parseAdminCommand } from '../../server/src/admin/command'

let pg: Awaited<ReturnType<typeof embeddedPostgres>>, admin: Administration, caseId: string
const token = 'A'.repeat(43),
  draftHash = 'b'.repeat(64)
async function privileged(sql: string) {
  await pg.sql.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE')
  await pg.sql.exec(sql)
}
async function login(role = 'restore_audit_admin') {
  await pg.sql.exec(
    `SET SESSION AUTHORIZATION postgres; RESET ROLE; SET SESSION AUTHORIZATION ${role}`
  )
}
async function open() {
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
  await login()
  caseId = (
    await admin.openRestoreReview('A', 'account', {
      agentId: 'target',
      context: { ...descriptor, contextHash: hashContext(descriptor) }
    })
  ).caseId
}
beforeAll(async () => {
  pg = await embeddedPostgres()
  await privileged(
    'CREATE ROLE restore_audit_admin LOGIN NOSUPERUSER NOBYPASSRLS; GRANT autoreply_admin TO restore_audit_admin'
  )
  admin = new Administration(pg.db)
}, 20000)
afterAll(async () => {
  if (pg) await pg.db.close()
})
beforeEach(async () => {
  await privileged(`TRUNCATE tenants CASCADE;
    INSERT INTO tenants(id,name) VALUES('A','合成企业');
    INSERT INTO employees(tenant_id,id,role) VALUES('A','admin','admin'),('A','employee','employee');
    INSERT INTO admin_database_principals(login_name,tenant_id,employee_id) VALUES('restore_audit_admin','A','admin');
    INSERT INTO accounts(tenant_id,id,employee_id,platform,paused) VALUES('A','account','employee','wechat',false);
    INSERT INTO agents(tenant_id,id,account_id,employee_id,token_hash) VALUES('A','target','account','employee','${tokenHash(token)}');
    INSERT INTO execution_permits(tenant_id,account_id,id,agent_id,lease_version,task_id,draft_hash,status,expires_at)
      VALUES('A','account','expired','target',7,'expired-task','${draftHash}','issued',clock_timestamp()-interval '1 hour'),
      ('A','account','pending','target',7,'pending-task','${draftHash}','issued',NULL);`)
  await open()
})

it('compares opening and actual authenticated settlement, keeping expired issuance unresolved and fences intact', async () => {
  const before = await admin.restorePermitAudit('A', 'account', caseId, { limit: 1 })
  expect(before.summary).toMatchObject({
    capturedCount: 2,
    currentCount: 2,
    unresolvedCentralCount: 2,
    expiredIssuedCount: 1,
    changedCount: 0,
    unexpectedCount: 0
  })
  expect(before.items[0]).toMatchObject({
    permitId: 'expired',
    openingStatus: 'issued',
    currentStatus: 'issued',
    expired: true,
    outcomeReviewRequired: true
  })
  expect(before).toMatchObject({
    canRelease: false,
    localWatermarksRequired: true,
    evidenceKind: 'central_metadata_comparison',
    nextAfter: 'expired'
  })
  await login('autoreply_app')
  await new ExecutionAuthority(new AccountAuthority(pg.db), async () => {
    throw Error('unexpected_publication_validation')
  }).settle(token, {
    permitId: 'pending',
    draftHash,
    status: 'not_sent',
    dispatchStarted: false,
    quiescent: true,
    verificationProofHash: 'c'.repeat(64)
  })
  await login()
  const after = await admin.restorePermitAudit('A', 'account', caseId)
  expect(after.summary).toMatchObject({ unresolvedCentralCount: 1, changedCount: 1 })
  expect(after.items.find((item) => item.permitId === 'pending')).toMatchObject({
    openingStatus: 'issued',
    currentStatus: 'not_sent',
    changed: true,
    settlementRecorded: true
  })
  expect(after.basisHash).not.toBe(before.basisHash)
  await expect(
    admin.restorePermitAudit('A', 'account', caseId, {
      after: before.nextAfter!,
      expectedBasisHash: before.basisHash
    })
  ).rejects.toThrow('RESTORE_REVIEW_CONFLICT')
  await expect(admin.resume('A', 'account')).rejects.toThrow('UNRESOLVED_RESTORE')
  const rows = await pg.db.transaction('A', (db) =>
    db.query('SELECT status_at_opening FROM ledger_restore_review_permits ORDER BY permit_id')
  )
  expect(rows.rows).toEqual([{ status_at_opening: 'issued' }, { status_at_opening: 'issued' }])
})

it('finds uncaptured permits and identity drift without turning terminal legacy rows into trusted outcomes', async () => {
  await privileged(`UPDATE execution_permits SET task_id='changed-task' WHERE id='pending';
    INSERT INTO execution_permits(tenant_id,account_id,id,agent_id,lease_version,task_id,draft_hash,status) VALUES('A','account','unexpected','target',7,'new-task','${draftHash}','confirmed')`)
  await login()
  const audit = await admin.restorePermitAudit('A', 'account', caseId)
  expect(audit.summary).toMatchObject({
    unexpectedCount: 1,
    identityChangedCount: 1,
    incompleteMetadataCount: 3
  })
  expect(audit.items.find((item) => item.permitId === 'pending')).toMatchObject({
    comparison: 'identity_changed',
    outcomeReviewRequired: true
  })
  expect(audit.items.find((item) => item.permitId === 'unexpected')).toMatchObject({
    comparison: 'not_captured',
    openingStatus: null,
    currentStatus: 'confirmed',
    settlementRecorded: false,
    outcomeReviewRequired: true
  })
})

it('requires private administrator scope and rejects malformed cursors and snapshot metadata', async () => {
  await login('autoreply_app')
  await expect(admin.restorePermitAudit('A', 'account', caseId)).rejects.toThrow('DENIED')
  await login()
  await expect(admin.restorePermitAudit('B', 'account', caseId)).rejects.toThrow('DENIED')
  await expect(admin.restorePermitAudit('A', 'missing', caseId)).rejects.toThrow()
  await expect(admin.restorePermitAudit('A', 'account', randomUUID())).rejects.toThrow(
    'RESTORE_REVIEW_NOT_FOUND'
  )
  await expect(admin.restorePermitAudit('A', 'account', caseId, { limit: 101 })).rejects.toThrow()
  await privileged(
    `UPDATE ledger_restore_review_permits SET snapshot_json=jsonb_set(snapshot_json,'{status}','"confirmed"') WHERE permit_id='pending'`
  )
  await login()
  await expect(admin.restorePermitAudit('A', 'account', caseId)).rejects.toThrow(
    'RESTORE_REVIEW_CONFLICT'
  )
})

it('includes the final page in the basis and counts rather than only auditing the returned page', async () => {
  await privileged(`INSERT INTO execution_permits(tenant_id,account_id,id,agent_id,lease_version,task_id,draft_hash,status)
    SELECT 'A','account','p-'||lpad(n::text,4,'0'),'target',7,'task-'||n,'${draftHash}','unknown' FROM generate_series(1,1001) n`)
  await open()
  const first = await admin.restorePermitAudit('A', 'account', caseId, { limit: 1 })
  expect(first.summary).toMatchObject({
    capturedCount: 1003,
    currentCount: 1003,
    unresolvedCentralCount: 1003
  })
  await privileged("UPDATE execution_permits SET task_id='last-page-change' WHERE id='p-1001'")
  await login()
  await expect(
    admin.restorePermitAudit('A', 'account', caseId, {
      after: first.nextAfter!,
      expectedBasisHash: first.basisHash,
      limit: 1
    })
  ).rejects.toThrow('RESTORE_REVIEW_CONFLICT')
  const next = await admin.restorePermitAudit('A', 'account', caseId, { after: 'p-1000', limit: 1 })
  expect(next.items[0]).toMatchObject({ permitId: 'p-1001', comparison: 'identity_changed' })
})
it('detects immutable timestamp drift smaller than a millisecond', async () => {
  await privileged(
    "UPDATE execution_permits SET issued_at='2026-01-01T00:00:00.123001Z' WHERE id='pending'"
  )
  await open()
  await privileged(
    "UPDATE execution_permits SET issued_at='2026-01-01T00:00:00.123002Z' WHERE id='pending'"
  )
  await login()
  const audit = await admin.restorePermitAudit('A', 'account', caseId)
  expect(audit.items.find((item) => item.permitId === 'pending')).toMatchObject({
    comparison: 'identity_changed'
  })
})

it('uses database ordering for Unicode page cursors without hiding permits', async () => {
  const firstId = '\uE000',
    secondId = '\u{10000}'
  await privileged(`INSERT INTO execution_permits(tenant_id,account_id,id,agent_id,lease_version,task_id,draft_hash,status)
    VALUES('A','account','${firstId}','target',7,'unicode-first','${draftHash}','unknown'),
    ('A','account','${secondId}','target',7,'unicode-second','${draftHash}','unknown')`)
  await open()
  const first = await admin.restorePermitAudit('A', 'account', caseId, {
    after: 'pending',
    limit: 1
  })
  expect(first.items.map((item) => item.permitId)).toEqual([firstId])
  expect(first.nextAfter).toBe(firstId)
  const second = await admin.restorePermitAudit('A', 'account', caseId, {
    after: first.nextAfter!,
    limit: 1,
    expectedBasisHash: first.basisHash
  })
  expect(second.items.map((item) => item.permitId)).toEqual([secondId])
  expect(second.nextAfter).toBeNull()
})

it('keeps semantic changes and basis stable across session time zones with microsecond precision', async () => {
  await privileged(
    "SET TIME ZONE 'UTC'; UPDATE execution_permits SET issued_at='2026-01-01T00:00:00.123001Z' WHERE id='pending'"
  )
  await open()
  const before = await admin.restorePermitAudit('A', 'account', caseId)
  await pg.sql.exec("SET TIME ZONE 'Asia/Shanghai'")
  const after = await admin.restorePermitAudit('A', 'account', caseId)
  expect(after.summary.changedCount).toBe(0)
  expect(after.basisHash).toBe(before.basisHash)
  await expect(
    admin.restorePermitAudit('A', 'account', caseId, {
      expectedBasisHash: before.basisHash
    })
  ).resolves.toMatchObject({ basisHash: before.basisHash })
  await privileged(
    "UPDATE execution_permits SET issued_at='2026-01-01T00:00:00.123002Z' WHERE id='pending'"
  )
  await login()
  const changed = await admin.restorePermitAudit('A', 'account', caseId)
  expect(changed.summary.changedCount).toBe(1)
  expect(changed.basisHash).not.toBe(before.basisHash)
})

it('runs the private CLI command with basis-bound pagination and rejects source files or duplicate options', async () => {
  const command = parseAdminCommand([
    'restore-permit-audit',
    '--tenant',
    'A',
    '--account',
    'account',
    '--case',
    caseId,
    '--limit',
    '1'
  ])
  const result = await executeAdminCommand(admin, command, async () => {
    throw Error('unexpected_file_read')
  })
  expect(result).toMatchObject({
    canRelease: false,
    summary: { capturedCount: 2 },
    items: [{ permitId: 'expired' }]
  })
  for (const extra of [
    ['--file', 'input.json'],
    ['--basis', 'invalid'],
    ['--limit', '2']
  ])
    expect(() =>
      parseAdminCommand([
        'restore-permit-audit',
        '--tenant',
        'A',
        '--account',
        'account',
        '--case',
        caseId,
        '--limit',
        '1',
        ...extra
      ])
    ).toThrow()
})
