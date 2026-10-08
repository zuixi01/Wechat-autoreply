import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Postgres } from '../../server/src/database/postgres'
import { AccountAuthority, tokenHash } from '../../server/src/auth/account-authority'
import { AccountPauseAuthority } from '../../server/src/monitoring/account-pause-authority'
import { Administration } from '../../server/src/admin/administration'
import type { AccountPauseChallenge } from '../../src/shared/contracts/runtime-pause'

const databaseName = `autoreply_pause_${randomUUID().replaceAll('-', '')}`,
  role = `pause_${randomUUID().replaceAll('-', '')}`,
  adminRole = `pause_admin_${randomUUID().replaceAll('-', '')}`
const token = 'A'.repeat(43),
  peer = 'B'.repeat(43)
let cluster: Pool, root: Pool, workers: Postgres[], admins: Postgres[]
beforeAll(async () => {
  const uri = process.env.AUTOREPLY_POSTGRES_TEST_URL,
    password = process.env.AUTOREPLY_POSTGRES_TEST_PASSWORD
  if (!uri || !password || !/^[a-f0-9]{64}$/.test(password))
    throw new Error('use_isolated_postgres_runner')
  const url = new URL(uri)
  if (
    url.hostname !== '127.0.0.1' ||
    url.username !== 'postgres' ||
    !/^\/autoreply_concurrency_[a-f0-9]{32}$/.test(url.pathname)
  )
    throw new Error('use_isolated_postgres_runner')
  cluster = new Pool({ connectionString: uri, max: 1 })
  await cluster.query(`CREATE DATABASE "${databaseName}"`)
  url.pathname = '/' + databaseName
  root = new Pool({
    connectionString: url.href,
    max: 3,
    options: '-c search_path=autoreply,public'
  })
  for (const file of (await readdir(resolve('server/migrations')))
    .filter((f) => /^\d{3}-.+\.sql$/.test(f))
    .sort()) {
    const sql = await readFile(resolve('server/migrations', file), 'utf8')
    await root.query(sql)
    await root.query(sql)
  }
  await root.query(
    `CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${password}';GRANT autoreply_app TO ${role};CREATE ROLE ${adminRole} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${password}';GRANT autoreply_admin TO ${adminRole}`
  )
  url.username = role
  url.password = password
  workers = [new Postgres(url.href), new Postgres(url.href)]
  url.username = adminRole
  admins = [new Postgres(url.href), new Postgres(url.href)]
})
beforeEach(async () => {
  await root.query('TRUNCATE tenants CASCADE')
  await root.query(`INSERT INTO tenants VALUES('A','synthetic');INSERT INTO employees(tenant_id,id,role) VALUES('A','admin','admin'),('A','employee','employee');
    INSERT INTO admin_database_principals VALUES('${adminRole}','A','admin');
    INSERT INTO accounts(tenant_id,id,employee_id,platform,paused) VALUES('A','account','employee','wework',false);
    INSERT INTO agents(tenant_id,id,account_id,employee_id,token_hash) VALUES('A','agent','account','employee','${tokenHash(token)}'),('A','peer','account','employee','${tokenHash(peer)}')`)
})
afterAll(async () => {
  await Promise.allSettled([
    ...(workers ?? []).map((db) => db.close()),
    ...(admins ?? []).map((db) => db.close()),
    root?.end(),
    cluster?.end()
  ])
})
const authority = (n = 0) => new AccountPauseAuthority(new AccountAuthority(workers[n]))
const request = async () => {
  const id = randomUUID()
  await new Administration(admins[0]).requestPause('A', 'account', id)
  return id
}
const input = (requestId: string) => ({
  requestId,
  attemptId: randomUUID(),
  runtime: { instanceId: randomUUID(), generation: 1 },
  instanceEpoch: 1
})
const report = (challenge: AccountPauseChallenge) => ({
  challenge,
  elapsedMs: 0,
  stopped: {
    observerStopped: true as const,
    senderQuiescent: true as const,
    settlementQuiescent: true as const,
    leaseStopped: true as const,
    platform: 'absent' as const
  }
})
const waiters = () =>
  expect.poll(
    async () =>
      (
        await root.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND usename=$1",
          [role]
        )
      ).rows[0].n
  )
describe('actual PostgreSQL purpose-bound pause concurrency', () => {
  it('covers and pages 208 accounts with the real non-bypass administrator and no silent limit', async () => {
    await root.query(
      `INSERT INTO accounts(tenant_id,id,employee_id,platform,paused) SELECT 'A','extra-'||n,'employee','wechat',false FROM generate_series(1,206) n;INSERT INTO accounts(tenant_id,id,employee_id,platform,paused) VALUES('A','中文账号','employee','wework',false)`
    )
    const admin = new Administration(admins[0]),
      s = await admin.requestPauseAll('A'),
      one = await admin.pauseAllAccounts('A', s.requestId, { limit: 100 }),
      two = await admin.pauseAllAccounts('A', s.requestId, { limit: 100, after: one.nextCursor }),
      three = await admin.pauseAllAccounts('A', s.requestId, { limit: 100, after: two.nextCursor })
    expect(s).toMatchObject({ accountCount: 208, activeAccounts: 208 })
    expect([one.rows.length, two.rows.length, three.rows.length]).toEqual([100, 100, 8])
    expect(new Set([...one.rows, ...two.rows, ...three.rows].map((r) => r.accountId)).size).toBe(
      208
    )
    expect(three.nextCursor).toBeNull()
    expect(
      (await root.query('SELECT count(*)::int AS n FROM accounts WHERE paused')).rows[0].n
    ).toBe(208)
  })
  it('serializes full-tenant retries and captures every account once without rewriting a resumed account', async () => {
    await root.query(
      "INSERT INTO accounts(tenant_id,id,employee_id,platform,paused) VALUES('A','other','employee','wechat',false)"
    )
    const id = randomUUID(),
      summaries = await Promise.all(
        admins.map((db) => new Administration(db).requestPauseAll('A', id))
      )
    expect(summaries[0]).toEqual(summaries[1])
    expect(summaries[0]).toMatchObject({ accountCount: 2, activeAccounts: 2, targetCount: 2 })
    expect(
      (
        await root.query(
          "SELECT count(*)::int AS n FROM audit_events WHERE kind='tenant_pause_requested'"
        )
      ).rows[0].n
    ).toBe(1)
    await root.query("UPDATE accounts SET paused=false WHERE tenant_id='A' AND id='other'")
    expect(await new Administration(admins[1]).requestPauseAll('A', id)).toMatchObject({
      accountCount: 2,
      activeAccounts: 1
    })
    expect(
      (await root.query("SELECT paused FROM accounts WHERE tenant_id='A' AND id='other'")).rows[0]
        .paused
    ).toBe(false)
  })
  it('blocks lease admission behind the bulk account locks and rejects it after the pause commits', async () => {
    await root.query(
      "INSERT INTO accounts(tenant_id,id,employee_id,platform,paused) VALUES('A','other','employee','wechat',false)"
    )
    const locked = await root.connect()
    await locked.query('BEGIN')
    await locked.query("SELECT 1 FROM accounts WHERE tenant_id='A' AND id='other' FOR UPDATE")
    const bulk = new Administration(admins[0]).requestPauseAll('A')
    void bulk.catch(() => {})
    try {
      await expect
        .poll(
          async () =>
            (
              await root.query(
                "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND usename=$1",
                [adminRole]
              )
            ).rows[0].n
        )
        .toBe(1)
      const lease = new AccountAuthority(workers[0]).acquireLease(token, 1, 'synthetic'),
        rejected = expect(lease).rejects.toThrow('PAUSED')
      await waiters().toBe(1)
      await locked.query('COMMIT')
      expect(await bulk).toMatchObject({ accountCount: 2, activeAccounts: 2 })
      await rejected
      expect((await root.query('SELECT * FROM account_leases')).rows).toEqual([])
    } finally {
      await locked.query('ROLLBACK')
      locked.release()
    }
  })
  it('freezes membership before a concurrent new account is provisioned and reports that account outside the batch', async () => {
    await root.query(
      "INSERT INTO accounts(tenant_id,id,employee_id,platform,paused) VALUES('A','other','employee','wechat',false)"
    )
    const locked = await root.connect()
    await locked.query('BEGIN')
    await locked.query("SELECT 1 FROM accounts WHERE tenant_id='A' AND id='other' FOR UPDATE")
    const bulk = new Administration(admins[0]).requestPauseAll('A')
    void bulk.catch(() => {})
    try {
      await expect
        .poll(
          async () =>
            (
              await root.query(
                "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND usename=$1",
                [adminRole]
              )
            ).rows[0].n
        )
        .toBe(1)
      await new Administration(admins[1]).provision('A', {
        accountId: 'new',
        employeeId: 'employee',
        platform: 'wechat'
      })
      await locked.query('COMMIT')
      const summary = await bulk
      expect(summary).toMatchObject({ accountCount: 2, outsideAccounts: 1 })
      expect(
        (await new Administration(admins[1]).pauseAllAccounts('A', summary.requestId)).rows.map(
          (r) => r.accountId
        )
      ).toEqual(['account', 'other'])
      expect(
        (await root.query("SELECT paused FROM accounts WHERE tenant_id='A' AND id='new'")).rows[0]
          .paused
      ).toBe(true)
    } finally {
      await locked.query('ROLLBACK')
      locked.release()
    }
  })
  it('rolls back the complete batch when its final audit fails on real PostgreSQL', async () => {
    await root.query(
      "INSERT INTO accounts(tenant_id,id,employee_id,platform,paused) VALUES('A','other','employee','wechat',false);CREATE FUNCTION fail_bulk_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='tenant_pause_requested' THEN RAISE EXCEPTION 'synthetic_bulk_audit_failure';END IF;RETURN NEW;END $$;CREATE TRIGGER fail_bulk_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_bulk_audit()"
    )
    try {
      await expect(new Administration(admins[0]).requestPauseAll('A')).rejects.toThrow(
        'synthetic_bulk_audit_failure'
      )
      expect((await root.query('SELECT paused FROM accounts')).rows.every((r) => !r.paused)).toBe(
        true
      )
      for (const table of [
        'tenant_pause_batches',
        'tenant_pause_accounts',
        'account_pause_requests',
        'account_pause_targets',
        'account_pause_heads',
        'audit_events'
      ])
        expect((await root.query('SELECT * FROM ' + table)).rows).toEqual([])
    } finally {
      await root.query(
        'DROP TRIGGER fail_bulk_audit ON audit_events;DROP FUNCTION fail_bulk_audit()'
      )
    }
  })
  it('serializes independent administrators repeating one request into one immutable request and audit', async () => {
    const id = randomUUID(),
      summaries = await Promise.all(
        admins.map((db) => new Administration(db).requestPause('A', 'account', id))
      )
    expect(summaries[0]).toEqual(summaries[1])
    expect(summaries[0]).toMatchObject({
      targetCount: 2,
      reportedTargets: 0,
      physicalStopVerified: false
    })
    expect(
      (await root.query('SELECT count(*)::int AS n FROM account_pause_requests')).rows[0].n
    ).toBe(1)
    expect(
      (
        await root.query(
          "SELECT count(*)::int AS n FROM audit_events WHERE kind='account_pause_requested'"
        )
      ).rows[0].n
    ).toBe(1)
  })
  it('serializes duplicate device confirmations with the same original receipt and no new lease', async () => {
    const id = await request(),
      i = input(id),
      challenges = await Promise.all(workers.map((_, n) => authority(n).challenge(token, i)))
    expect(challenges[0]).toEqual(challenges[1])
    const receipts = await Promise.all(
      workers.map((_, n) => authority(n).report(token, report(challenges[0])))
    )
    expect(receipts[0]).toEqual(receipts[1])
    expect(
      (await root.query('SELECT count(*)::int AS n FROM account_pause_reports')).rows[0].n
    ).toBe(1)
    expect((await root.query('SELECT * FROM account_leases')).rows).toEqual([])
    expect((await root.query('SELECT * FROM execution_permits')).rows).toEqual([])
  })
  it('rejects a queued report when a newer pause commits ahead of it', async () => {
    const id = await request(),
      c = await authority().challenge(token, input(id)),
      next = randomUUID(),
      locked = await root.connect()
    await locked.query('BEGIN')
    await locked.query("SELECT 1 FROM accounts WHERE tenant_id='A' AND id='account' FOR UPDATE")
    const pending = authority().report(token, report(c)),
      rejected = expect(pending).rejects.toThrow('PAUSE_OBSOLETE')
    try {
      await waiters().toBe(1)
      await locked.query(
        `INSERT INTO account_pause_requests(tenant_id,account_id,id,actor_id) VALUES('A','account',$1,'admin');`,
        [next]
      )
      await locked.query(`INSERT INTO account_pause_targets VALUES('A','account',$1,'agent')`, [
        next
      ])
      await locked.query(
        `UPDATE account_pause_heads SET request_id=$1 WHERE tenant_id='A' AND account_id='account'`,
        [next]
      )
      await locked.query('COMMIT')
      await rejected
      expect((await root.query('SELECT * FROM account_pause_reports')).rows).toEqual([])
    } finally {
      await locked.query('ROLLBACK')
      locked.release()
    }
  })
  it('rechecks revocation after waiting for the account lock', async () => {
    const id = await request(),
      c = await authority().challenge(token, input(id)),
      locked = await root.connect()
    await locked.query('BEGIN')
    await locked.query("SELECT 1 FROM accounts WHERE tenant_id='A' AND id='account' FOR UPDATE")
    const pending = authority().report(token, report(c)),
      rejected = expect(pending).rejects.toThrow('DENIED')
    try {
      await waiters().toBe(1)
      await locked.query(
        "UPDATE agents SET revoked_at=clock_timestamp() WHERE tenant_id='A' AND id='agent'"
      )
      await locked.query('COMMIT')
      await rejected
      expect((await root.query('SELECT * FROM account_pause_reports')).rows).toEqual([])
    } finally {
      await locked.query('ROLLBACK')
      locked.release()
    }
  })
  it('isolates confirmations of two agents targeted by the same pause', async () => {
    const id = await request(),
      credentials = [token, peer],
      challenges = await Promise.all(
        credentials.map((t, n) => authority(n).challenge(t, input(id)))
      )
    await expect(authority(1).report(peer, report(challenges[0]))).rejects.toThrow('PAUSE_CONFLICT')
    await Promise.all(credentials.map((t, n) => authority(n).report(t, report(challenges[n]))))
    expect(
      (await new Administration(admins[0]).pauseRequest('A', 'account', id)).reportedTargets
    ).toBe(2)
    expect(
      (await root.query('SELECT agent_id FROM account_pause_reports ORDER BY agent_id')).rows
    ).toEqual([{ agent_id: 'agent' }, { agent_id: 'peer' }])
  })
})
