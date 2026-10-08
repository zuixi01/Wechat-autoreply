import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { embeddedPostgres } from '../fixtures/embedded-postgres'
import { Administration } from '../../server/src/admin/administration'
import { AccountAuthority, tokenHash } from '../../server/src/auth/account-authority'
import { AccountPauseAuthority } from '../../server/src/monitoring/account-pause-authority'
let pg: Awaited<ReturnType<typeof embeddedPostgres>>, admin: Administration
const token = 'A'.repeat(43)
async function root(sql: string) {
  await pg.sql.exec('SET SESSION AUTHORIZATION postgres;RESET ROLE')
  await pg.sql.exec(sql)
}
async function login() {
  await pg.sql.exec(
    'SET SESSION AUTHORIZATION postgres;RESET ROLE;SET SESSION AUTHORIZATION bulk_admin'
  )
}
beforeAll(async () => {
  pg = await embeddedPostgres()
  await root(`CREATE ROLE bulk_admin LOGIN NOSUPERUSER NOBYPASSRLS;GRANT autoreply_admin TO bulk_admin;
    INSERT INTO tenants VALUES('A','synthetic A'),('B','synthetic B'),('E','synthetic empty');
    INSERT INTO employees(tenant_id,id,role) VALUES('A','admin','admin'),('A','employee','employee'),('B','employee','employee'),('E','admin','admin');
    INSERT INTO admin_database_principals VALUES('bulk_admin','A','admin'),('bulk_admin','E','admin');
    INSERT INTO accounts(tenant_id,id,employee_id,platform,paused) VALUES('A','account','employee','wework',false),('A','other','employee','wechat',false),('B','account','employee','wework',false);
    INSERT INTO agents(tenant_id,id,account_id,employee_id,token_hash) VALUES('A','agent','account','employee','${tokenHash(token)}'),('A','peer','account','employee','synthetic-peer'),('A','other','other','employee','synthetic-other'),('A','revoked','account','employee','synthetic-revoked')`)
  admin = new Administration(pg.db)
}, 20000)
beforeEach(async () => {
  await root(`TRUNCATE tenant_pause_batches,account_pause_requests,account_pause_reports,device_runtime_status,account_leases,execution_permits,audit_events CASCADE;
    DELETE FROM accounts WHERE tenant_id='A' AND id NOT IN('account','other');UPDATE accounts SET paused=false,enabled=true;
    UPDATE agents SET revoked_at=NULL;UPDATE agents SET revoked_at=clock_timestamp() WHERE id='revoked';UPDATE employees SET enabled=true;`)
  await login()
})
afterAll(async () => {
  await pg?.db.close()
})
describe('atomic enterprise-wide pause batches', () => {
  it('covers enabled and disabled accounts, excludes revoked devices, and preserves foreign accounts, leases and unknown sends', async () => {
    await root(
      `UPDATE accounts SET enabled=false WHERE tenant_id='A' AND id='other';INSERT INTO account_leases VALUES('A','account','agent',1,'synthetic',2,clock_timestamp()+interval '10 minutes');INSERT INTO execution_permits(tenant_id,account_id,id,agent_id,lease_version,task_id,draft_hash,status) VALUES('A','account','unknown','agent',2,'synthetic','synthetic','unknown')`
    )
    const lease = (await pg.sql.query('SELECT * FROM account_leases')).rows
    await login()
    const id = randomUUID(),
      s = await admin.requestPauseAll('A', id)
    expect(s).toMatchObject({
      requestId: id,
      accountCount: 2,
      activeAccounts: 2,
      outsideAccounts: 0,
      targetCount: 3,
      reportedTargets: 0,
      physicalStopVerified: false,
      canAuthorizeSend: false
    })
    expect((await admin.pauseAllAccounts('A', id)).rows).toHaveLength(2)
    await root('SELECT 1')
    expect(
      (await pg.sql.query('SELECT tenant_id,id,paused FROM accounts ORDER BY tenant_id,id')).rows
    ).toEqual([
      { tenant_id: 'A', id: 'account', paused: true },
      { tenant_id: 'A', id: 'other', paused: true },
      { tenant_id: 'B', id: 'account', paused: false }
    ])
    expect((await pg.sql.query('SELECT * FROM account_leases')).rows).toEqual(lease)
    expect((await pg.sql.query('SELECT status FROM execution_permits')).rows).toEqual([
      { status: 'unknown' }
    ])
    expect(
      (
        await pg.sql.query(
          'SELECT kind,count(*)::int AS n FROM audit_events GROUP BY kind ORDER BY kind'
        )
      ).rows
    ).toEqual([
      { kind: 'account_pause_requested', n: 2 },
      { kind: 'tenant_pause_requested', n: 1 }
    ])
  })
  it('reuses the frozen batch without re-pausing resumed or superseded accounts or adding later accounts', async () => {
    const id = randomUUID(),
      first = await admin.requestPauseAll('A', id)
    expect(await admin.requestPauseAll('A', id)).toEqual(first)
    await admin.requestPause('A', 'account')
    await root(
      "UPDATE accounts SET paused=false WHERE tenant_id='A' AND id='other';INSERT INTO accounts(tenant_id,id,employee_id,platform,paused) VALUES('A','late','employee','wechat',false)"
    )
    const heads = (await pg.sql.query('SELECT * FROM account_pause_heads ORDER BY account_id')).rows
    await login()
    expect(await admin.requestPauseAll('A', id)).toMatchObject({
      accountCount: 2,
      activeAccounts: 0,
      outsideAccounts: 1,
      targetCount: 3
    })
    expect((await admin.pauseAllAccounts('A', id)).rows.every((r) => !r.active)).toBe(true)
    await root('SELECT 1')
    expect(
      (await pg.sql.query('SELECT * FROM account_pause_heads ORDER BY account_id')).rows
    ).toEqual(heads)
    expect(
      (
        await pg.sql.query(
          "SELECT id,paused FROM accounts WHERE tenant_id='A' AND id IN('late','other') ORDER BY id"
        )
      ).rows
    ).toEqual([
      { id: 'late', paused: false },
      { id: 'other', paused: false }
    ])
    expect(
      (await pg.sql.query('SELECT count(*)::int AS n FROM tenant_pause_batches')).rows
    ).toEqual([{ n: 1 }])
  })
  it('pages all 208 frozen accounts without truncation or duplication and binds cursors to the batch and tenant', async () => {
    await root(
      `INSERT INTO accounts(tenant_id,id,employee_id,platform,paused) SELECT 'A','extra-'||n,'employee','wework',false FROM generate_series(1,205) n;INSERT INTO accounts(tenant_id,id,employee_id,platform,paused) VALUES('A','中文账号','employee','wechat',false)`
    )
    await login()
    const id = randomUUID(),
      s = await admin.requestPauseAll('A', id),
      one = await admin.pauseAllAccounts('A', id, { limit: 100 }),
      two = await admin.pauseAllAccounts('A', id, { limit: 100, after: one.nextCursor }),
      three = await admin.pauseAllAccounts('A', id, { limit: 100, after: two.nextCursor })
    expect(s).toMatchObject({ accountCount: 208, activeAccounts: 208 })
    expect([one.rows.length, two.rows.length, three.rows.length]).toEqual([100, 100, 8])
    expect(new Set([...one.rows, ...two.rows, ...three.rows].map((r) => r.accountId)).size).toBe(
      208
    )
    expect(three.rows.at(-1)?.accountId).toBe('中文账号')
    expect(three.nextCursor).toBeNull()
    expect(new Set([...one.rows, ...two.rows, ...three.rows].map((r) => r.requestId)).size).toBe(
      208
    )
    await expect(
      admin.pauseAllAccounts('A', randomUUID(), { after: one.nextCursor })
    ).rejects.toThrow('invalid_bulk_pause_cursor')
    const cursor = JSON.parse(Buffer.from(one.nextCursor!, 'base64url').toString('utf8'))
    cursor.tenantId = 'B'
    await expect(
      admin.pauseAllAccounts('A', id, {
        after: Buffer.from(JSON.stringify(cursor)).toString('base64url')
      })
    ).rejects.toThrow('invalid_bulk_pause_cursor')
    for (const input of [{ limit: 0 }, { limit: 101 }, { after: 'broken' }, { allTenants: true }])
      await expect(admin.pauseAllAccounts('A', id, input)).rejects.toThrow()
  })
  it('accepts an empty tenant once and rejects missing batches, extra identity and invalid UUIDs', async () => {
    const id = randomUUID(),
      s = await admin.requestPauseAll('E', id)
    expect(s).toMatchObject({
      accountCount: 0,
      activeAccounts: 0,
      targetCount: 0,
      outsideAccounts: 0
    })
    expect(await admin.requestPauseAll('E', id)).toEqual(s)
    expect(await admin.pauseAllAccounts('E', id)).toMatchObject({ rows: [], nextCursor: null })
    await expect(admin.pauseAllRequest('A', id)).rejects.toThrow('bulk_pause_not_found')
    await expect(admin.requestPauseAll('A', 'invalid')).rejects.toThrow()
    await expect(admin.pauseAllAccounts('A', id, { tenantId: 'E' })).rejects.toThrow()
  })
  it('enforces administrator tenant scope and immutable group history, denying all app access', async () => {
    const s = await admin.requestPauseAll('A')
    await root(
      `INSERT INTO tenant_pause_batches(tenant_id,id,actor_id) VALUES('B','${randomUUID()}','employee')`
    )
    await login()
    await expect(admin.requestPauseAll('B')).rejects.toThrow('DENIED')
    expect(
      (await pg.db.transaction('B', (db) => db.query('SELECT * FROM tenant_pause_batches'))).rows
    ).toEqual([])
    for (const sql of [
      'UPDATE tenant_pause_batches SET actor_id=actor_id',
      'DELETE FROM tenant_pause_accounts'
    ])
      await expect(pg.db.transaction('A', (db) => db.query(sql))).rejects.toThrow()
    await root('SET ROLE autoreply_app')
    for (const table of ['tenant_pause_batches', 'tenant_pause_accounts'])
      await expect(
        pg.db.transaction('A', (db) => db.query('SELECT * FROM ' + table))
      ).rejects.toThrow()
    await expect(admin.pauseAllRequest('A', s.requestId)).rejects.toThrow('DENIED')
  })
  it('keeps a frozen member visible as inactive even if its mutable head is missing', async () => {
    const s = await admin.requestPauseAll('A')
    await root("DELETE FROM account_pause_heads WHERE tenant_id='A' AND account_id='other'")
    await login()
    const p = await admin.pauseAllAccounts('A', s.requestId)
    expect(p.summary).toMatchObject({ accountCount: 2, activeAccounts: 1 })
    expect(p.rows).toHaveLength(2)
    expect(p.rows.find((r) => r.accountId === 'other')?.active).toBe(false)
  })
  it('rolls back every account flag, child request, target, head, batch and audit on final audit failure', async () => {
    await root(
      "CREATE FUNCTION fail_bulk_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='tenant_pause_requested' THEN RAISE EXCEPTION 'synthetic_bulk_audit_failure';END IF;RETURN NEW;END $$;CREATE TRIGGER fail_bulk_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_bulk_audit()"
    )
    await login()
    try {
      await expect(admin.requestPauseAll('A')).rejects.toThrow('synthetic_bulk_audit_failure')
      expect(
        (await pg.db.transaction('A', (db) => db.query('SELECT paused FROM accounts'))).rows.every(
          (r) => !r.paused
        )
      ).toBe(true)
      for (const table of [
        'tenant_pause_batches',
        'tenant_pause_accounts',
        'account_pause_requests',
        'account_pause_targets',
        'account_pause_heads',
        'audit_events'
      ])
        expect(
          (await pg.db.transaction('A', (db) => db.query('SELECT * FROM ' + table))).rows
        ).toEqual([])
    } finally {
      await root('DROP TRIGGER fail_bulk_audit ON audit_events;DROP FUNCTION fail_bulk_audit()')
    }
  })
  it('uses the existing device-purpose challenge for each child request and counts historical reports without claiming physical stop', async () => {
    const s = await admin.requestPauseAll('A'),
      rows = (await admin.pauseAllAccounts('A', s.requestId)).rows,
      cid = rows.find((r) => r.accountId === 'account')!.requestId
    await root('SET ROLE autoreply_app')
    const pause = new AccountPauseAuthority(new AccountAuthority(pg.db)),
      challenge = await pause.challenge(token, {
        requestId: cid,
        attemptId: randomUUID(),
        runtime: { instanceId: randomUUID(), generation: 1 },
        instanceEpoch: 1
      })
    await pause.report(token, {
      challenge,
      elapsedMs: 0,
      stopped: {
        observerStopped: true,
        senderQuiescent: true,
        settlementQuiescent: true,
        leaseStopped: true,
        platform: 'absent'
      }
    })
    await login()
    expect(await admin.pauseAllRequest('A', s.requestId)).toMatchObject({
      targetCount: 3,
      reportedTargets: 1,
      physicalStopVerified: false,
      canAuthorizeSend: false
    })
    expect(
      (await admin.runtimeStatus('A')).rows.find((r) => r.agentId === 'agent')?.pauseConfirmation
    ).toBe('stale')
  })
  it('round-trips maximum-length Chinese tenant and account identifiers without truncating the cursor', async () => {
    const tenant = '企'.repeat(128),
      firstId = '客'.repeat(128),
      secondId = '末'.repeat(128)
    await root(
      `INSERT INTO tenants VALUES('${tenant}','synthetic Unicode');INSERT INTO employees(tenant_id,id,role) VALUES('${tenant}','admin','admin');INSERT INTO admin_database_principals VALUES('bulk_admin','${tenant}','admin');INSERT INTO accounts(tenant_id,id,employee_id,platform) VALUES('${tenant}','${firstId}','admin','wework'),('${tenant}','${secondId}','admin','wechat')`
    )
    await login()
    const s = await admin.requestPauseAll(tenant),
      first = await admin.pauseAllAccounts(tenant, s.requestId, { limit: 1 })
    expect(first.nextCursor!.length).toBeGreaterThan(1024)
    expect(first.nextCursor!.length).toBeLessThanOrEqual(2048)
    const second = await admin.pauseAllAccounts(tenant, s.requestId, {
      limit: 1,
      after: first.nextCursor
    })
    expect(first.rows[0].accountId).toBe(firstId)
    expect(second.rows[0].accountId).toBe(secondId)
    expect(second.nextCursor).toBeNull()
  })
})
