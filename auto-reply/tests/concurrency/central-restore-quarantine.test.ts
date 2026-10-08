import { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyCentralRestoreQuarantine } from '../../server/src/recovery/central-restore-quarantine'

let cluster: Pool, database: Pool
const name = `autoreply_restore_${randomUUID().replaceAll('-', '')}`
beforeAll(async () => {
  const uri = process.env.AUTOREPLY_POSTGRES_TEST_URL
  if (!uri || !process.env.AUTOREPLY_POSTGRES_TEST_REPORT)
    throw new Error('use_isolated_postgres_runner')
  const url = new URL(uri)
  if (url.hostname !== '127.0.0.1' || !/^\/autoreply_concurrency_[a-f0-9]{32}$/.test(url.pathname))
    throw new Error('use_isolated_postgres_runner')
  cluster = new Pool({ connectionString: uri, max: 1 })
  await cluster.query(`CREATE DATABASE "${name}"`)
  url.pathname = '/' + name
  database = new Pool({
    connectionString: url.href,
    max: 3,
    options: '-c search_path=autoreply,public'
  })
  for (const migration of (await readdir(resolve('server/migrations')))
    .filter((f) => /^\d{3}-.+\.sql$/.test(f))
    .sort()) {
    const sql = await readFile(resolve('server/migrations', migration), 'utf8')
    await database.query(sql)
    await database.query(sql)
  }
  await database.query(`INSERT INTO tenants VALUES('fixture','central-restoration'); INSERT INTO employees VALUES('fixture','employee','employee',true);
    INSERT INTO accounts(tenant_id,id,employee_id,platform,paused) VALUES('fixture','account','employee','wechat',false);
    INSERT INTO agents(tenant_id,id,account_id,employee_id,token_hash) VALUES('fixture','agent','account','employee','synthetic');
    INSERT INTO execution_permits(tenant_id,account_id,id,agent_id,lease_version,task_id,draft_hash,status) VALUES('fixture','account','unknown','agent',1,'fixture','fixture','unknown')`)
})
afterAll(async () => {
  await database?.end()
  await cluster?.end()
})
describe('independent PostgreSQL restore transactions', () => {
  it('rejects an untrusted pause-guard owner before calling privileged admission helpers', async () => {
    const role = `restore_guard_${randomUUID().replaceAll('-', '')}`
    await database.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`)
    try {
      await database.query(`GRANT USAGE ON SCHEMA autoreply TO ${role}`)
      await database.query(`ALTER FUNCTION guard_ledger_restore_pause() OWNER TO ${role}`)
      await expect(
        database.query(
          "UPDATE accounts SET paused=false WHERE tenant_id='fixture' AND id='account'"
        )
      ).rejects.toThrow('ledger_restore_guard_owner_invalid')
      expect(
        (
          await database.query(
            "SELECT paused FROM accounts WHERE tenant_id='fixture' AND id='account'"
          )
        ).rows
      ).toEqual([{ paused: false }])
    } finally {
      await database.query('ALTER FUNCTION guard_ledger_restore_pause() OWNER TO postgres')
      await database.query(`DROP OWNED BY ${role}`)
      await database.query(`DROP ROLE ${role}`)
    }
  })

  it('serializes two exact applications from independent backends into one journal and audit', async () => {
    const clients = await Promise.all([database.connect(), database.connect()])
    try {
      const pids = await Promise.all(
        clients.map(async (c) => (await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      )
      expect(new Set(pids).size).toBe(2)
      const request = {
        restoreId: randomUUID(),
        backupId: randomUUID(),
        archiveSha256: 'a'.repeat(64),
        archiveBytes: 4096,
        databaseName: name
      }
      const results = await Promise.all(
        clients.map((c) => applyCentralRestoreQuarantine(c, request))
      )
      expect(results[0]).toEqual(results[1])
      expect(results[0]).toMatchObject({
        counts: { accounts: 1, unrevokedAgents: 1, unresolvedPermits: 1 },
        canRelease: false
      })
      expect(
        (await clients[0].query('SELECT count(*)::int AS n FROM database_restore_quarantines'))
          .rows[0].n
      ).toBe(1)
      expect(
        (
          await clients[0].query(
            "SELECT count(*)::int AS n FROM audit_events WHERE kind='central_database_restored'"
          )
        ).rows[0].n
      ).toBe(1)
      expect((await clients[0].query('SELECT status FROM execution_permits')).rows).toEqual([
        { status: 'unknown' }
      ])
      await expect(
        clients[1].query("UPDATE accounts SET paused=false WHERE id='account'")
      ).rejects.toThrow('central_restore_review_pending')
      await writeFile(
        join(process.env.AUTOREPLY_POSTGRES_TEST_REPORT!, 'central-restoration-concurrency.json'),
        JSON.stringify(
          {
            passed: true,
            independentBackendPids: pids,
            immutableReceipts: 1,
            immutableAudits: 1,
            unknownPreserved: true,
            resumeDenied: true,
            canRelease: false
          },
          null,
          2
        )
      )
    } finally {
      clients.forEach((c) => c.release())
    }
  })
})
