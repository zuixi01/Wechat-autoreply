import { PGlite } from '@electric-sql/pglite'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { tokenHash } from '../../server/src/auth/account-authority'

let db: PGlite
const scope = async (tenantId?: string) => {
  await db.exec('RESET ROLE; SET ROLE autoreply_app; SET search_path=autoreply,public')
  await db.query("SELECT set_config('app.tenant_id',$1,false)", [tenantId ?? ''])
}
beforeAll(async () => {
  db = new PGlite()
  const migration = await readFile(resolve('server/migrations/001-core.sql'), 'utf8')
  await db.exec(migration)
  await db.exec(migration)
  await db.exec(`SET search_path=autoreply,public;
    INSERT INTO tenants(id,name) VALUES('A','企业 A'),('B','企业 B');
    INSERT INTO employees(tenant_id,id,role) VALUES('A','employee-A','employee'),('B','employee-B','employee');
    INSERT INTO accounts(tenant_id,id,employee_id,platform) VALUES('A','account-A','employee-A','wechat'),('B','account-B','employee-B','wework');`)
  await db.query(
    `INSERT INTO agents(tenant_id,id,account_id,employee_id,token_hash)
    VALUES('A','agent-revoke','account-A','employee-A',$1)`,
    [tokenHash('revocation-token')]
  )
}, 20000)
afterAll(async () => {
  if (db) await db.close()
})

// Embedded PostgreSQL validates actual SQL and RLS. It has one connection; these are
// deliberately NOT a substitute for multi-connection/row-lock PostgreSQL acceptance.
describe('central SQL migration and tenant policies in embedded PostgreSQL', () => {
  it('denies all tenant data without a trusted transaction scope', async () => {
    await scope()
    expect((await db.query('SELECT id FROM accounts')).rows).toEqual([])
  })
  it('filters reads and rejects cross-tenant writes for the non-privileged application role', async () => {
    await scope('A')
    expect((await db.query('SELECT id FROM accounts')).rows).toEqual([{ id: 'account-A' }])
    await expect(
      db.query("INSERT INTO employees(tenant_id,id,role) VALUES('B','intruder','employee')")
    ).rejects.toThrow(/row.level security/i)
  })
  it('atomically consumes a registration code and authenticates only its assigned account', async () => {
    await db.exec('RESET ROLE')
    await db.query(
      `INSERT INTO enrollment_codes(code_hash,tenant_id,account_id,employee_id,expires_at)
      VALUES($1,'A','account-A','employee-A',clock_timestamp()+interval '10 minutes')`,
      [tokenHash('synthetic-code')]
    )
    await scope()
    const registered = await db.query('SELECT * FROM autoreply.redeem_enrollment($1,$2,$3)', [
      tokenHash('synthetic-code'),
      'agent-A',
      tokenHash('synthetic-token')
    ])
    expect(registered.rows).toEqual([
      {
        tenant_id: 'A',
        employee_id: 'employee-A',
        account_id: 'account-A',
        agent_id: 'agent-A',
        platform: 'wechat'
      }
    ])
    await expect(
      db.query('SELECT * FROM autoreply.redeem_enrollment($1,$2,$3)', [
        tokenHash('synthetic-code'),
        'another-agent',
        tokenHash('another-token')
      ])
    ).rejects.toThrow('registration_rejected')
    expect(
      (
        await db.query('SELECT * FROM autoreply.authenticate_device($1)', [
          tokenHash('synthetic-token')
        ])
      ).rows
    ).toEqual(registered.rows)
    expect(
      (
        await db.query('SELECT * FROM autoreply.authenticate_device($1)', [
          tokenHash('wrong-token')
        ])
      ).rows
    ).toEqual([])
  })
  it('makes revocation effective for subsequent authentication', async () => {
    await db.exec('RESET ROLE')
    await db.query(
      "UPDATE agents SET revoked_at=clock_timestamp() WHERE tenant_id='A' AND id='agent-revoke'"
    )
    await scope('A')
    expect(
      (
        await db.query('SELECT * FROM autoreply.authenticate_device($1)', [
          tokenHash('revocation-token')
        ])
      ).rows
    ).toEqual([])
  })
  it('keeps enrollment codes inaccessible to the application role', async () => {
    await scope('A')
    await expect(db.query('SELECT * FROM enrollment_codes')).rejects.toThrow(/permission denied/i)
  })
})
