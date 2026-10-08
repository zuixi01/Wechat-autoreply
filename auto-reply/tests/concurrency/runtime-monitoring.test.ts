import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Postgres } from '../../server/src/database/postgres'
import { AccountAuthority, tokenHash } from '../../server/src/auth/account-authority'
import { RuntimeStatusAuthority } from '../../server/src/monitoring/runtime-status-authority'

const databaseName = `autoreply_monitor_${randomUUID().replaceAll('-', '')}`,
  role = `monitor_${randomUUID().replaceAll('-', '')}`
const token = 'A'.repeat(43),
  observation = {
    runtimeEpoch: 1,
    sequence: 1,
    status: {
      state: 'paused' as const,
      reason: 'user_pause' as const,
      lease: 'stopped' as const,
      pauseAcknowledged: true
    }
  }
let cluster: Pool, root: Pool, workers: Postgres[]
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
    `CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${password}'; GRANT autoreply_app TO ${role}`
  )
  url.username = role
  url.password = password
  workers = [new Postgres(url.href), new Postgres(url.href)]
})
beforeEach(async () => {
  await root.query('TRUNCATE tenants CASCADE')
  await root.query(`INSERT INTO tenants VALUES('A','synthetic'); INSERT INTO employees(tenant_id,id,role) VALUES('A','employee','employee');
    INSERT INTO accounts(tenant_id,id,employee_id,platform) VALUES('A','account','employee','wework');
    INSERT INTO agents(tenant_id,id,account_id,employee_id,token_hash) VALUES('A','agent','account','employee','${tokenHash(token)}')`)
})
afterAll(async () => {
  await Promise.allSettled([
    ...(workers ?? []).map((db) => db.close()),
    root?.end(),
    cluster?.end()
  ])
})
describe('actual PostgreSQL independent runtime reporting transactions', () => {
  it('serializes duplicate reports into one persisted row and one original timestamp', async () => {
    const clients = await Promise.all(workers.map((db) => db.pool.connect()))
    try {
      expect(
        new Set(
          await Promise.all(
            clients.map(async (c) => (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
          )
        ).size
      ).toBe(2)
    } finally {
      clients.forEach((c) => c.release())
    }
    const receipts = await Promise.all(
      workers.map((db) =>
        new RuntimeStatusAuthority(new AccountAuthority(db)).report(token, observation)
      )
    )
    expect(receipts[0]).toEqual(receipts[1])
    expect(
      (await root.query('SELECT count(*)::int AS n FROM device_runtime_status')).rows[0].n
    ).toBe(1)
    expect((await root.query('SELECT * FROM account_leases')).rows).toEqual([])
  })
  it('rejects the older report after waiting for a newer report to commit under the account lock', async () => {
    const locked = await root.connect()
    await locked.query('BEGIN')
    await locked.query("SELECT 1 FROM accounts WHERE tenant_id='A' AND id='account' FOR UPDATE")
    const authorities = workers.map((db) => new RuntimeStatusAuthority(new AccountAuthority(db)))
    const newer = authorities[0].report(token, { ...observation, sequence: 2 })
    void newer.catch(() => {})
    try {
      // Verify a real row-lock waiter before enqueuing the older packet; no timing-based assertion.
      await expect
        .poll(
          async () =>
            (
              await root.query(
                "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND usename=$1",
                [role]
              )
            ).rows[0].n
        )
        .toBe(1)
      const older = authorities[1].report(token, observation),
        rejected = expect(older).rejects.toThrow('STALE_REPORT')
      await expect
        .poll(
          async () =>
            (
              await root.query(
                "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND usename=$1",
                [role]
              )
            ).rows[0].n
        )
        .toBe(2)
      await locked.query('COMMIT')
      await newer
      await rejected
      expect((await root.query('SELECT sequence FROM device_runtime_status')).rows).toEqual([
        { sequence: '2' }
      ])
    } finally {
      await locked.query('ROLLBACK')
      locked.release()
    }
  })
  it('rechecks revocation under the account lock instead of trusting pre-lock authentication', async () => {
    const locked = await root.connect()
    await locked.query('BEGIN')
    await locked.query("SELECT 1 FROM accounts WHERE tenant_id='A' AND id='account' FOR UPDATE")
    const report = new RuntimeStatusAuthority(new AccountAuthority(workers[0])).report(
        token,
        observation
      ),
      rejected = expect(report).rejects.toThrow('DENIED')
    try {
      await expect
        .poll(
          async () =>
            (
              await root.query(
                "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND usename=$1",
                [role]
              )
            ).rows[0].n
        )
        .toBe(1)
      await locked.query('UPDATE agents SET revoked_at=clock_timestamp()')
      await locked.query('COMMIT')
      await rejected
      expect((await root.query('SELECT * FROM device_runtime_status')).rows).toEqual([])
    } finally {
      await locked.query('ROLLBACK')
      locked.release()
    }
  })
})
