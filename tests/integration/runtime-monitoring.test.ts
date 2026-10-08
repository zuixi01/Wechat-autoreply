import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { embeddedPostgres } from '../fixtures/embedded-postgres'
import { AccountAuthority, tokenHash } from '../../server/src/auth/account-authority'
import { RuntimeStatusAuthority } from '../../server/src/monitoring/runtime-status-authority'
import { Administration } from '../../server/src/admin/administration'
import type { RuntimeObservation } from '../../src/shared/contracts/runtime-monitoring'

let pg: Awaited<ReturnType<typeof embeddedPostgres>>,
  monitor: RuntimeStatusAuthority,
  admin: Administration
const token = 'A'.repeat(43),
  tokenB = 'B'.repeat(43)
const observation: RuntimeObservation = {
  runtimeEpoch: 1,
  sequence: 1,
  status: { state: 'paused', reason: 'user_pause', lease: 'stopped', pauseAcknowledged: true }
}
async function privileged(sql: string) {
  await pg.sql.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE')
  await pg.sql.exec(sql)
}
async function app() {
  await pg.sql.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE; SET ROLE autoreply_app')
}
async function login() {
  await pg.sql.exec(
    'SET SESSION AUTHORIZATION postgres; RESET ROLE; SET SESSION AUTHORIZATION monitoring_admin'
  )
}
beforeAll(async () => {
  pg = await embeddedPostgres()
  await privileged(`CREATE ROLE monitoring_admin LOGIN NOSUPERUSER NOBYPASSRLS; GRANT autoreply_admin TO monitoring_admin;
    INSERT INTO tenants VALUES('A','Synthetic A'),('B','Synthetic B');
    INSERT INTO employees(tenant_id,id,role) VALUES('A','admin','admin'),('A','employee','employee'),('B','employee','employee');
    INSERT INTO admin_database_principals VALUES('monitoring_admin','A','admin');
    INSERT INTO accounts(tenant_id,id,employee_id,platform) VALUES('A','account','employee','wework'),('B','account','employee','wechat');
    INSERT INTO agents(tenant_id,id,account_id,employee_id,token_hash) VALUES('A','agent','account','employee','${tokenHash(token)}'),('B','agent','account','employee','${tokenHash(tokenB)}');`)
  monitor = new RuntimeStatusAuthority(new AccountAuthority(pg.db))
  admin = new Administration(pg.db)
}, 20000)
beforeEach(async () => {
  await privileged(`DELETE FROM device_runtime_status; DELETE FROM account_leases;
    DELETE FROM agents WHERE id<>'agent'; UPDATE agents SET revoked_at=NULL;
    UPDATE accounts SET paused=true,enabled=true; UPDATE employees SET enabled=true;`)
  await app()
})
afterAll(async () => {
  if (pg) await pg.db.close()
})
describe('credential-derived runtime observations and tenant administration', () => {
  it('reports a paused account without acquiring or renewing a lease, with replay-stable receipt', async () => {
    const first = await monitor.report(token, observation)
    expect(first).toMatchObject({
      scope: { tenant_id: 'A', account_id: 'account', agent_id: 'agent' },
      serverPaused: true,
      canAuthorizeSend: false
    })
    await privileged(
      `UPDATE device_runtime_status SET received_at=clock_timestamp()-interval '2 minutes' WHERE tenant_id='A'`
    )
    await app()
    const replay = await monitor.report(token, observation)
    expect(replay.receivedAt).toBeLessThan(first.receivedAt - 60000)
    expect(await monitor.report(token, observation)).toEqual(replay)
    expect(
      (await pg.db.transaction('A', (db) => db.query('SELECT * FROM account_leases'))).rows
    ).toEqual([])
    await login()
    expect((await admin.runtimeStatus('A')).rows[0]).toMatchObject({
      freshness: 'stale',
      physicalStopVerified: false,
      canAuthorizeSend: false,
      serverPaused: true
    })
  })
  it('keeps newer sequences and process epochs while rejecting stale/conflicting packets', async () => {
    await monitor.report(token, { ...observation, sequence: 2 })
    await expect(monitor.report(token, observation)).rejects.toThrow('STALE_REPORT')
    await expect(
      monitor.report(token, {
        ...observation,
        sequence: 2,
        status: { ...observation.status, reason: 'shutdown' }
      })
    ).rejects.toThrow('REPORT_CONFLICT')
    await monitor.report(token, { ...observation, runtimeEpoch: 2 })
    await expect(monitor.report(token, { ...observation, sequence: 200 })).rejects.toThrow(
      'STALE_REPORT'
    )
    await login()
    const page = await admin.runtimeStatus('A')
    expect(page.rows[0]).toMatchObject({
      freshness: 'recent',
      observation: { runtimeEpoch: 2, sequence: 1 }
    })
  })
  it.each([
    { ...observation, scope: { tenant_id: 'B' } },
    { ...observation, sequence: 0 },
    { ...observation, runtimeEpoch: Number.MAX_SAFE_INTEGER + 1 },
    { ...observation, status: { ...observation.status, state: 'running' } },
    { ...observation, status: { ...observation.status, customer: 'private' } }
  ])('rejects malformed or client-selected authority %#', async (input) => {
    await expect(monitor.report(token, input)).rejects.toThrow('INVALID_REQUEST')
    expect(
      (await pg.db.transaction('A', (db) => db.query('SELECT * FROM device_runtime_status'))).rows
    ).toEqual([])
  })
  it.each([
    'UPDATE agents SET revoked_at=clock_timestamp()',
    'UPDATE employees SET enabled=false',
    'UPDATE accounts SET enabled=false'
  ])('denies disabled/revoked devices %#', async (sql) => {
    await privileged(sql)
    await app()
    await expect(monitor.report(token, observation)).rejects.toThrow('DENIED')
  })
  it('isolates identical agent/account names across tenants and refuses foreign admin access', async () => {
    await monitor.report(token, observation)
    await monitor.report(tokenB, { ...observation, sequence: 8 })
    expect(
      (await pg.db.transaction('A', (db) => db.query('SELECT sequence FROM device_runtime_status')))
        .rows
    ).toEqual([{ sequence: 1 }])
    await expect(admin.runtimeStatus('A')).rejects.toThrow('DENIED')
    await login()
    await expect(admin.runtimeStatus('B')).rejects.toThrow('DENIED')
    expect(
      (await pg.db.transaction('B', (db) => db.query('SELECT * FROM device_runtime_status'))).rows
    ).toEqual([])
    await expect(
      pg.db.transaction('A', (db) => db.query('UPDATE device_runtime_status SET sequence=99'))
    ).rejects.toThrow()
    expect((await admin.runtimeStatus('A')).rows).toHaveLength(1)
  })
  it('shows corrupted reports as invalid and refuses to overwrite corrupted history', async () => {
    await monitor.report(token, observation)
    await privileged(`UPDATE device_runtime_status SET report_hash='${'b'.repeat(64)}'`)
    await app()
    await expect(monitor.report(token, { ...observation, sequence: 2 })).rejects.toThrow(
      'INVALID_HISTORY'
    )
    await login()
    expect((await admin.runtimeStatus('A')).rows[0]).toMatchObject({
      freshness: 'invalid',
      observation: null
    })
  })
  it('retains historical observations while marking revoked devices separately', async () => {
    await monitor.report(token, observation)
    await privileged('UPDATE agents SET revoked_at=clock_timestamp()')
    await login()
    expect(await admin.runtimeStatus('A')).toMatchObject({
      totalDevices: 1,
      revokedDevices: 1,
      rows: [{ freshness: 'revoked', observation }]
    })
  })
  it('pages through more than 200 devices without duplicates or a silent limit, binding the cursor to the filter and tenant', async () => {
    await privileged(`INSERT INTO agents(tenant_id,id,account_id,employee_id,token_hash)
      SELECT 'A','device-'||n,'account','employee','synthetic-'||n FROM generate_series(1,205) n;
      INSERT INTO agents(tenant_id,id,account_id,employee_id,token_hash) VALUES('A','中文设备','account','employee','synthetic-unicode');`)
    await login()
    const first = await admin.runtimeStatus('A', { limit: 100 }),
      second = await admin.runtimeStatus('A', { limit: 100, after: first.nextCursor }),
      third = await admin.runtimeStatus('A', { limit: 100, after: second.nextCursor })
    expect([first.rows.length, second.rows.length, third.rows.length]).toEqual([100, 100, 7])
    expect(first.totalDevices).toBe(207)
    expect(third.nextCursor).toBeNull()
    expect(new Set([...first.rows, ...second.rows, ...third.rows].map((r) => r.agentId)).size).toBe(
      207
    )
    expect(third.rows.at(-1)?.agentId).toBe('中文设备')
    await expect(
      admin.runtimeStatus('A', { accountId: 'account', after: first.nextCursor })
    ).rejects.toThrow('invalid_runtime_cursor')
    const cursor = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString())
    cursor.tenant = 'B'
    await expect(
      admin.runtimeStatus('A', { after: Buffer.from(JSON.stringify(cursor)).toString('base64url') })
    ).rejects.toThrow('invalid_runtime_cursor')
    expect((await admin.runtimeStatus('A', { accountId: 'missing' })).totalDevices).toBe(0)
    for (const input of [
      { limit: 101 },
      { limit: 0 },
      { after: 'broken' },
      { includeCredentials: true }
    ])
      await expect(admin.runtimeStatus('A', input)).rejects.toThrow()
  })
  it('does not extend an existing lease or change account pause state', async () => {
    await privileged(
      `UPDATE accounts SET paused=false; INSERT INTO account_leases VALUES('A','account','agent',1,'synthetic',2,clock_timestamp()+interval '10 minutes')`
    )
    await app()
    const before = (await pg.db.transaction('A', (db) => db.query('SELECT * FROM account_leases')))
      .rows
    expect((await monitor.report(token, observation)).serverPaused).toBe(false)
    expect(
      (await pg.db.transaction('A', (db) => db.query('SELECT * FROM account_leases'))).rows
    ).toEqual(before)
    await login()
    expect((await admin.runtimeStatus('A')).rows[0]).toMatchObject({
      leaseLive: true,
      leaseAgentId: 'agent',
      serverPaused: false
    })
  })
})
