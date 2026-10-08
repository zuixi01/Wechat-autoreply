import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { embeddedPostgres } from '../fixtures/embedded-postgres'
import { Administration } from '../../server/src/admin/administration'
import { hashContext } from '../../src/core/reply/hashes'
import { executeAdminCommand, parseAdminCommand } from '../../server/src/admin/command'

let pg: Awaited<ReturnType<typeof embeddedPostgres>>, admin: Administration
const privileged = async (sql: string) => {
  await pg.sql.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE')
  await pg.sql.exec(sql)
}
const login = async () => {
  await pg.sql.exec(
    'SET SESSION AUTHORIZATION postgres; RESET ROLE; SET SESSION AUTHORIZATION restore_admin'
  )
}
const request = () => {
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
  return { agentId: 'agent-A', context: { ...descriptor, contextHash: hashContext(descriptor) } }
}
beforeAll(async () => {
  pg = await embeddedPostgres()
  await privileged(
    'CREATE ROLE restore_admin LOGIN NOSUPERUSER NOBYPASSRLS; GRANT autoreply_admin TO restore_admin;'
  )
  admin = new Administration(pg.db)
}, 20000)
afterAll(async () => {
  if (pg) await pg.db.close()
})
beforeEach(async () => {
  await privileged(`TRUNCATE tenants CASCADE;
    INSERT INTO tenants(id,name) VALUES('A','合成企业'),('B','另一合成企业');
    INSERT INTO employees(tenant_id,id,role) VALUES('A','admin-A','admin'),('A','employee-A','employee');
    INSERT INTO admin_database_principals(login_name,tenant_id,employee_id) VALUES('restore_admin','A','admin-A');
    INSERT INTO accounts(tenant_id,id,employee_id,platform,paused) VALUES('A','account-A','employee-A','wechat',false);
    INSERT INTO agents(tenant_id,id,account_id,employee_id,token_hash) VALUES('A','agent-A','account-A','employee-A','synthetic-no-device-secret');
    INSERT INTO account_leases(tenant_id,account_id,agent_id,login_epoch,client_instance_id,version,expires_at) VALUES('A','account-A','agent-A',3,'client-A',7,clock_timestamp()+interval '10 minutes');`)
  await login()
})
describe('central restoration review preparation', () => {
  it('opens a recovery case without a prior execution lease and persists a SQL-null snapshot', async () => {
    await privileged('DELETE FROM account_leases')
    await login()
    const review = await admin.openRestoreReview('A', 'account-A', request())
    expect(review.leaseAtOpening).toBeNull()
    const rows = await pg.db.transaction('A', (db) =>
      db.query(
        'SELECT lease_snapshot IS NULL AS sql_null FROM ledger_restore_reviews WHERE id=$1',
        [review.caseId]
      )
    )
    expect(rows.rows).toEqual([{ sql_null: true }])
  })
  it('fails closed when the database pause guard loses its privileged migration owner', async () => {
    await privileged(`CREATE ROLE restore_guard_limited NOLOGIN NOSUPERUSER NOBYPASSRLS;
      GRANT USAGE ON SCHEMA autoreply TO restore_guard_limited; GRANT SELECT ON ledger_restore_reviews TO restore_guard_limited;
      ALTER FUNCTION autoreply.guard_ledger_restore_pause() OWNER TO restore_guard_limited;`)
    await login()
    try {
      await expect(
        pg.db.transaction('A', (db) =>
          db.query("UPDATE accounts SET paused=false WHERE id='account-A'")
        )
      ).rejects.toThrow('ledger_restore_guard_owner_invalid')
    } finally {
      await privileged(
        'ALTER FUNCTION autoreply.guard_ledger_restore_pause() OWNER TO postgres; DROP OWNED BY restore_guard_limited; DROP ROLE restore_guard_limited'
      )
    }
  })
  it('binds a distinct restore to an authenticated account, pauses it, and retries without duplicating evidence', async () => {
    const input = request()
    const first = await admin.openRestoreReview('A', 'account-A', input)
    expect(first).toMatchObject({
      restoreId: input.context.restoreId,
      agentId: 'agent-A',
      contextHash: input.context.contextHash,
      permitCount: 0,
      requiresReconciliation: true,
      devicePauseAcknowledged: null,
      leaseAtOpening: {
        agentId: 'agent-A',
        loginEpoch: '3',
        clientInstanceId: 'client-A',
        version: '7'
      }
    })
    expect(await admin.openRestoreReview('A', 'account-A', input)).toEqual(first)
    const state = await pg.db.transaction('A', (db) =>
      db.query("SELECT paused FROM accounts WHERE id='account-A'")
    )
    expect(state.rows).toEqual([{ paused: true }])
    expect(await admin.restoreReviews('A', 'account-A')).toEqual([first])
    const audit = await pg.db.transaction('A', (db) =>
      db.query(
        "SELECT count(*)::int AS count FROM audit_events WHERE kind='ledger_restore_review_opened'"
      )
    )
    expect(audit.rows).toEqual([{ count: 1 }])
    await expect(
      admin.openRestoreReview('A', 'account-A', { ...input, agentId: 'missing' })
    ).rejects.toThrow('RESTORE_REVIEW_CONFLICT')
  })
  it('freezes every existing permit, retains original outcomes, and refuses resume or direct removal of pause', async () => {
    await privileged(`INSERT INTO execution_permits(tenant_id,account_id,id,agent_id,lease_version,task_id,draft_hash,status) VALUES
      ('A','account-A','sent','agent-A',7,'t1','${'b'.repeat(64)}','confirmed'),
      ('A','account-A','no-send','agent-A',7,'t2','${'b'.repeat(64)}','not_sent'),
      ('A','account-A','uncertain','agent-A',7,'t3','${'b'.repeat(64)}','unknown');`)
    await login()
    const opened = await admin.openRestoreReview('A', 'account-A', request())
    expect(opened.permitCount).toBe(3)
    await expect(admin.resume('A', 'account-A')).rejects.toThrow('UNRESOLVED_RESTORE')
    await expect(
      pg.db.transaction('A', (db) =>
        db.query("UPDATE accounts SET paused=false WHERE id='account-A'")
      )
    ).rejects.toThrow('ledger_restore_review_pending')
    const rows = await pg.db.transaction('A', (db) =>
      db.query(
        'SELECT permit_id,status_at_opening FROM ledger_restore_review_permits ORDER BY permit_id'
      )
    )
    expect(rows.rows).toEqual([
      { permit_id: 'no-send', status_at_opening: 'not_sent' },
      { permit_id: 'sent', status_at_opening: 'confirmed' },
      { permit_id: 'uncertain', status_at_opening: 'unknown' }
    ])
    await expect(
      pg.db.transaction('A', (db) => db.query('DELETE FROM ledger_restore_reviews'))
    ).rejects.toThrow()
    await expect(
      pg.db.transaction('A', (db) => db.query("UPDATE ledger_restore_reviews SET context_hash='x'"))
    ).rejects.toThrow()
    await expect(
      pg.db.transaction('A', (db) =>
        db.query("UPDATE ledger_restore_review_permits SET status_at_opening='confirmed'")
      )
    ).rejects.toThrow()
    const original = await pg.db.transaction('A', (db) =>
      db.query('SELECT id,status FROM execution_permits ORDER BY id')
    )
    expect(original.rows).toEqual([
      { id: 'no-send', status: 'not_sent' },
      { id: 'sent', status: 'confirmed' },
      { id: 'uncertain', status: 'unknown' }
    ])
    await pg.sql.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE; SET ROLE autoreply_app')
    await expect(
      pg.db.transaction('A', (db) =>
        db.query("UPDATE accounts SET paused=false WHERE id='account-A'")
      )
    ).rejects.toThrow('ledger_restore_review_pending')
  })
  it('rejects cross-tenant, non-admin, malformed context and reuse of an id with different content', async () => {
    const input = request()
    await expect(admin.openRestoreReview('B', 'account-A', input)).rejects.toThrow('DENIED')
    await expect(
      admin.openRestoreReview('A', 'account-A', {
        ...input,
        context: { ...input.context, contextHash: 'f'.repeat(64) }
      })
    ).rejects.toThrow('RESTORE_REVIEW_CONFLICT')
    await admin.openRestoreReview('A', 'account-A', input)
    const { contextHash: originalHash, ...descriptor } = input.context
    const changed = { ...descriptor, backupId: randomUUID() }
    expect(hashContext(changed)).not.toBe(originalHash)
    await expect(
      admin.openRestoreReview('A', 'account-A', {
        ...input,
        context: { ...changed, contextHash: hashContext(changed) }
      })
    ).rejects.toThrow('RESTORE_REVIEW_CONFLICT')
    await pg.sql.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE; SET ROLE autoreply_app')
    await expect(admin.restoreReviews('A', 'account-A')).rejects.toThrow('DENIED')
  })
  it('rolls pause and evidence back together if recording the administrator audit fails', async () => {
    await privileged(`CREATE OR REPLACE FUNCTION autoreply.restore_test_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='ledger_restore_review_opened' THEN RAISE EXCEPTION 'synthetic_audit_failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER restore_test_audit_failure BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION autoreply.restore_test_audit_failure();`)
    await login()
    try {
      await expect(admin.openRestoreReview('A', 'account-A', request())).rejects.toThrow(
        'synthetic_audit_failure'
      )
      expect(await admin.restoreReviews('A', 'account-A')).toEqual([])
      const state = await pg.db.transaction('A', (db) =>
        db.query("SELECT paused FROM accounts WHERE id='account-A'")
      )
      expect(state.rows).toEqual([{ paused: false }])
    } finally {
      await privileged(
        'DROP TRIGGER restore_test_audit_failure ON audit_events; DROP FUNCTION autoreply.restore_test_audit_failure()'
      )
    }
  })
  it('captures more than one thousand permits without truncation and offers bounded cursor pages', async () => {
    await privileged(`INSERT INTO execution_permits(tenant_id,account_id,id,agent_id,lease_version,task_id,draft_hash,status)
      SELECT 'A','account-A','permit-'||lpad(n::text,4,'0'),'agent-A',7,'task-'||n,'${'d'.repeat(64)}','confirmed' FROM generate_series(1,1001) n`)
    await login()
    const opened = await admin.openRestoreReview('A', 'account-A', request())
    expect(opened.permitCount).toBe(1001)
    const first = await admin.restoreReviewPermits('A', 'account-A', opened.caseId, { limit: 2 })
    expect(first.map((row) => row.permitId)).toEqual(['permit-0001', 'permit-0002'])
    expect(
      await admin.restoreReviewPermits('A', 'account-A', opened.caseId, {
        after: 'permit-1000',
        limit: 2
      })
    ).toMatchObject([{ permitId: 'permit-1001', status: 'confirmed' }])
    await expect(
      admin.restoreReviewPermits('A', 'account-A', opened.caseId, { limit: 101 })
    ).rejects.toThrow()
  })
  it('routes concrete restore CLI commands through administrator authority and never offers release', async () => {
    const input = request()
    const command = parseAdminCommand([
      'open-restore-review',
      '--tenant',
      'A',
      '--account',
      'account-A',
      '--file',
      'synthetic-context.json'
    ])
    const opened = (await executeAdminCommand(admin, command, async () => input)) as {
      caseId: string
    }
    const list = parseAdminCommand(['restore-reviews', '--tenant', 'A', '--account', 'account-A'])
    expect(
      await executeAdminCommand(admin, list, async () => {
        throw Error('unexpected_file_read')
      })
    ).toMatchObject({ restoreReviews: [{ caseId: opened.caseId }] })
    const page = parseAdminCommand([
      'restore-review-permits',
      '--tenant',
      'A',
      '--account',
      'account-A',
      '--case',
      opened.caseId,
      '--limit',
      '2'
    ])
    expect(
      await executeAdminCommand(admin, page, async () => {
        throw Error('unexpected_file_read')
      })
    ).toEqual({ permits: [] })
    expect(() =>
      parseAdminCommand(['release-restore-review', '--tenant', 'A', '--account', 'account-A'])
    ).toThrow()
  })
  it('retains the opening outcome after a late settlement and refuses a changed snapshot count', async () => {
    await privileged(
      `INSERT INTO execution_permits(tenant_id,account_id,id,agent_id,lease_version,task_id,draft_hash,status) VALUES('A','account-A','original','agent-A',7,'t1','${'b'.repeat(64)}','issued')`
    )
    await login()
    const opened = await admin.openRestoreReview('A', 'account-A', request())
    await privileged("UPDATE execution_permits SET status='confirmed' WHERE id='original'")
    await login()
    expect(await admin.restoreReviewPermits('A', 'account-A', opened.caseId)).toMatchObject([
      { permitId: 'original', status: 'issued' }
    ])
    await privileged(`INSERT INTO execution_permits(tenant_id,account_id,id,agent_id,lease_version,task_id,draft_hash,status) VALUES('A','account-A','extra','agent-A',7,'t2','${'b'.repeat(64)}','confirmed');
      INSERT INTO ledger_restore_review_permits VALUES('A','account-A','${opened.caseId}','extra','confirmed','{}')`)
    await login()
    await expect(admin.restoreReview('A', 'account-A', opened.caseId)).rejects.toThrow(
      'RESTORE_REVIEW_CONFLICT'
    )
    await expect(admin.resume('A', 'account-A')).rejects.toThrow('UNRESOLVED_RESTORE')
  })
})
