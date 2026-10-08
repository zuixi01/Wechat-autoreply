import { randomBytes, randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Pool } from 'pg'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { Postgres } from '../../server/src/database/postgres'
import { Administration } from '../../server/src/admin/administration'
import { hashContext } from '../../src/core/reply/hashes'
import { tokenHash } from '../../server/src/auth/account-authority'

const suffix = randomUUID().replaceAll('-', ''),
  database = `autoreply_completion_audit_${suffix}`,
  login = `completion_audit_admin_${suffix}`
let cluster: Pool, owner: Pool, serviceDb: Postgres, admin: Administration
function request() {
  const fields = {
    formatVersion: 1 as const,
    restoreId: randomUUID(),
    backupId: randomUUID(),
    sourceSha256: 'a'.repeat(64),
    restoredAt: new Date().toISOString(),
    previousRestoreId: null,
    previousContextHash: null,
    requiresReconciliation: true as const
  }
  return { agentId: 'agent', context: { ...fields, contextHash: hashContext(fields) } }
}
beforeAll(async () => {
  const uri = process.env.AUTOREPLY_POSTGRES_TEST_URL
  if (!uri || !process.env.AUTOREPLY_POSTGRES_TEST_REPORT)
    throw Error('use_isolated_postgres_runner')
  const url = new URL(uri)
  if (url.hostname !== '127.0.0.1' || !/^\/autoreply_concurrency_[a-f0-9]{32}$/.test(url.pathname))
    throw Error('use_isolated_postgres_runner')
  cluster = new Pool({ connectionString: uri, max: 1 })
  await cluster.query(`CREATE DATABASE "${database}"`)
  url.pathname = '/' + database
  owner = new Pool({
    connectionString: url.href,
    max: 2,
    options: '-c search_path=autoreply,public'
  })
  for (const file of (await readdir(resolve('server/migrations')))
    .filter((f) => /^\d{3}-.+\.sql$/.test(f))
    .sort()) {
    const source = await readFile(resolve('server/migrations', file), 'utf8')
    await owner.query(source)
    await owner.query(source)
  }
  const password = randomBytes(32).toString('hex')
  await owner.query(`CREATE ROLE "${login}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}';GRANT autoreply_admin TO "${login}";
    INSERT INTO tenants(id,name) VALUES('tenant','synthetic complete account audit');
    INSERT INTO employees(tenant_id,id,role) VALUES('tenant','admin','admin'),('tenant','employee','employee');
    INSERT INTO admin_database_principals(login_name,tenant_id,employee_id) VALUES('${login}','tenant','admin');
    INSERT INTO accounts(tenant_id,id,employee_id,platform,paused) VALUES('tenant','account','employee','wechat',true),('tenant','other','employee','wechat',true)`)
  await owner.query(
    "INSERT INTO agents(tenant_id,id,account_id,employee_id,token_hash) VALUES('tenant','agent','account','employee',$1)",
    [tokenHash('S'.repeat(43))]
  )
  url.username = login
  url.password = password
  serviceDb = new Postgres(url.href)
  admin = new Administration(serviceDb)
})
afterAll(async () => {
  await serviceDb?.close()
  await owner?.end()
  if (cluster) {
    await cluster.query(`DROP DATABASE IF EXISTS "${database}"`)
    await cluster.query(`DROP ROLE IF EXISTS "${login}"`)
    await cluster.end()
  }
})
it('reads more than a display page and observes a new case committed ahead of an actual account-lock waiter', async () => {
  for (let i = 0; i < 51; i++) await admin.openRestoreReview('tenant', 'account', request())
  const before = (await owner.query('SELECT count(*)::int AS n FROM audit_events')).rows[0].n
  const first = await admin.restoreCompletionAudit('tenant', 'account')
  expect(first.cases).toHaveLength(51)
  expect(first).toMatchObject({
    readyCases: 0,
    pendingCases: 51,
    allCasesPrepared: false,
    canRelease: false
  })
  expect((await owner.query('SELECT count(*)::int AS n FROM audit_events')).rows[0].n).toBe(before)
  const lock = await owner.connect()
  let creating: Promise<unknown> | undefined,
    reading: ReturnType<Administration['restoreCompletionAudit']> | undefined
  try {
    await lock.query('BEGIN')
    await lock.query("SELECT id FROM accounts WHERE tenant_id='tenant' AND id='account' FOR UPDATE")
    const waiters = async (expected: number): Promise<void> => {
      for (let i = 0; i < 100; i++) {
        const n = (
          await cluster.query(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND query LIKE '%accounts%FOR UPDATE%'",
            [database]
          )
        ).rows[0].n
        if (n === expected) return
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw Error('completion_audit_account_waiter_not_observed')
    }
    creating = admin.openRestoreReview('tenant', 'account', request())
    await waiters(1)
    reading = admin.restoreCompletionAudit('tenant', 'account')
    await waiters(2)
    await lock.query('COMMIT')
    await creating
    const second = await reading
    expect(second.cases).toHaveLength(52)
    expect(second.pendingCases).toBe(52)
    expect(second.basisHash).not.toBe(first.basisHash)
    expect((await admin.restoreCompletionAudit('tenant', 'other')).cases).toEqual([])
    await expect(admin.resume('tenant', 'account')).rejects.toThrow('UNRESOLVED_RESTORE')
    expect(
      (await owner.query("SELECT paused FROM accounts WHERE tenant_id='tenant' AND id='account'"))
        .rows[0].paused
    ).toBe(true)
  } finally {
    await lock.query('ROLLBACK')
    lock.release()
    await Promise.allSettled([creating, reading])
  }
})
