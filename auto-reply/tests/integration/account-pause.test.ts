import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { embeddedPostgres } from '../fixtures/embedded-postgres'
import { AccountAuthority, tokenHash } from '../../server/src/auth/account-authority'
import { Administration } from '../../server/src/admin/administration'
import { AccountPauseAuthority } from '../../server/src/monitoring/account-pause-authority'
import { RuntimeStatusAuthority } from '../../server/src/monitoring/runtime-status-authority'
import { hashContext } from '../../src/core/reply/hashes'
import type {
  AccountPauseReport,
  AccountPauseChallenge
} from '../../src/shared/contracts/runtime-pause'

let pg: Awaited<ReturnType<typeof embeddedPostgres>>,
  admin: Administration,
  pause: AccountPauseAuthority,
  monitor: RuntimeStatusAuthority
const token = 'A'.repeat(43),
  foreign = 'B'.repeat(43),
  other = 'D'.repeat(43)
const context = () => ({ instanceId: randomUUID(), generation: 2 })
async function privileged(sql: string) {
  await pg.sql.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE')
  await pg.sql.exec(sql)
}
async function login() {
  await pg.sql.exec(
    'SET SESSION AUTHORIZATION postgres; RESET ROLE; SET SESSION AUTHORIZATION pause_admin'
  )
}
async function app() {
  await pg.sql.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE; SET ROLE autoreply_app')
}
beforeAll(async () => {
  pg = await embeddedPostgres()
  await privileged(`CREATE ROLE pause_admin LOGIN NOSUPERUSER NOBYPASSRLS;GRANT autoreply_admin TO pause_admin;
    INSERT INTO tenants VALUES('A','synthetic A'),('B','synthetic B');
    INSERT INTO employees(tenant_id,id,role) VALUES('A','admin','admin'),('A','employee','employee'),('A','other','employee'),('B','employee','employee');
    INSERT INTO admin_database_principals VALUES('pause_admin','A','admin');
    INSERT INTO accounts(tenant_id,id,employee_id,platform,paused) VALUES('A','account','employee','wework',false),('A','other','other','wechat',false),('B','account','employee','wechat',false);
    INSERT INTO agents(tenant_id,id,account_id,employee_id,token_hash) VALUES('A','agent','account','employee','${tokenHash(token)}'),('A','peer','account','employee','${tokenHash('C'.repeat(43))}'),('A','other','other','other','${tokenHash(other)}'),('B','agent','account','employee','${tokenHash(foreign)}')`)
  const authority = new AccountAuthority(pg.db)
  pause = new AccountPauseAuthority(authority)
  monitor = new RuntimeStatusAuthority(authority)
  admin = new Administration(pg.db)
}, 20000)
beforeEach(async () => {
  await privileged(
    "TRUNCATE account_pause_requests,account_pause_reports,device_runtime_status,account_leases,execution_permits,audit_events CASCADE;DELETE FROM agents WHERE id='late';UPDATE accounts SET paused=false,enabled=true;UPDATE agents SET revoked_at=NULL;UPDATE employees SET enabled=true"
  )
  await login()
})
afterAll(async () => {
  if (pg) await pg.db.close()
})
async function request() {
  return (await admin.requestPause('A', 'account', randomUUID())) as {
    requestId: string
    targetCount: number
  }
}
async function challenge(requestId: string) {
  await app()
  return pause.challenge(token, {
    requestId,
    attemptId: randomUUID(),
    runtime: context(),
    instanceEpoch: 7
  })
}
const report = (c: AccountPauseChallenge): AccountPauseReport => ({
  challenge: c,
  elapsedMs: 0,
  stopped: {
    observerStopped: true,
    senderQuiescent: true,
    settlementQuiescent: true,
    leaseStopped: true,
    platform: 'absent'
  }
})
describe('account pause requests and purpose-bound runtime confirmations', () => {
  it('pauses atomically, freezes all original device targets, and repeats an explicit request without a second audit', async () => {
    const id = randomUUID(),
      first = await admin.requestPause('A', 'account', id)
    expect(first).toMatchObject({
      requestId: id,
      active: true,
      targetCount: 2,
      reportedTargets: 0,
      physicalStopVerified: false,
      canAuthorizeSend: false
    })
    expect(await admin.requestPause('A', 'account', id)).toEqual(first)
    expect(
      (
        await pg.db.transaction('A', (db) =>
          db.query(
            "SELECT count(*)::int AS n FROM audit_events WHERE kind='account_pause_requested'"
          )
        )
      ).rows[0].n
    ).toBe(1)
    await privileged(
      `INSERT INTO agents(tenant_id,id,account_id,employee_id,token_hash) VALUES('A','late','account','employee','synthetic-late')`
    )
    await app()
    expect(
      (
        await monitor.report('A'.repeat(43), {
          runtimeEpoch: 1,
          sequence: 1,
          status: {
            state: 'paused',
            reason: 'user_pause',
            lease: 'stopped',
            pauseAcknowledged: true
          }
        })
      ).pauseRequestId
    ).toBe(id)
    await login()
    expect((await admin.pauseRequest('A', 'account', id)).targetCount).toBe(2)
  })
  it('separates a recorded declaration from a current matching runtime state and expires offline status', async () => {
    const r = await request(),
      c = await challenge(r.requestId),
      body = report(c)
    const ack = await pause.report(token, body)
    expect(ack).toMatchObject({
      reportHash: hashContext(body),
      physicalStopVerified: false,
      canAuthorizeSend: false
    })
    expect(await pause.report(token, body)).toEqual(ack)
    await login()
    expect(
      (await admin.runtimeStatus('A')).rows.find((r) => r.agentId === 'agent')?.pauseConfirmation
    ).toBe('stale')
    await app()
    await monitor.report(token, {
      runtimeEpoch: 9,
      sequence: 1,
      runtimeContext: c.runtime,
      status: { state: 'paused', reason: 'user_pause', lease: 'stopped', pauseAcknowledged: true }
    })
    await login()
    expect((await admin.runtimeStatus('A')).rows.find((r) => r.agentId === 'agent')).toMatchObject({
      pauseConfirmation: 'confirmed_runtime',
      physicalStopVerified: false
    })
    await app()
    await monitor.report(token, {
      runtimeEpoch: 9,
      sequence: 2,
      runtimeContext: { ...c.runtime, instanceId: randomUUID() },
      status: { state: 'paused', reason: 'user_pause', lease: 'stopped', pauseAcknowledged: true }
    })
    await login()
    expect(
      (await admin.runtimeStatus('A')).rows.find((r) => r.agentId === 'agent')?.pauseConfirmation
    ).toBe('awaiting_state')
    await privileged(
      "UPDATE device_runtime_status SET received_at=clock_timestamp()-interval '1 minute'"
    )
    await login()
    expect(
      (await admin.runtimeStatus('A')).rows.find((r) => r.agentId === 'agent')?.pauseConfirmation
    ).toBe('stale')
  })
  it('keeps unknown sends and leases unchanged when issuing or confirming a pause', async () => {
    await privileged(`INSERT INTO account_leases VALUES('A','account','agent',1,'synthetic',2,clock_timestamp()+interval '10 minutes');
      INSERT INTO execution_permits(tenant_id,account_id,id,agent_id,lease_version,task_id,draft_hash,status) VALUES('A','account','unknown','agent',2,'synthetic','synthetic','unknown')`)
    const before = (await pg.sql.query('SELECT * FROM account_leases')).rows
    await login()
    const r = await request(),
      c = await challenge(r.requestId)
    await pause.report(token, report(c))
    await privileged('SELECT 1')
    expect((await pg.sql.query('SELECT * FROM account_leases')).rows).toEqual(before)
    expect((await pg.sql.query('SELECT status FROM execution_permits')).rows).toEqual([
      { status: 'unknown' }
    ])
  })
  it('rejects changed duplicates and old requests after a new pause or central resume', async () => {
    const r = await request(),
      c = await challenge(r.requestId),
      body = report(c)
    await pause.report(token, body)
    await expect(pause.report(token, { ...body, elapsedMs: 1 })).rejects.toThrow('PAUSE_CONFLICT')
    await login()
    await admin.requestPause('A', 'account', randomUUID())
    await app()
    await expect(pause.report(token, body)).rejects.toThrow('PAUSE_OBSOLETE')
    await login()
    expect((await admin.pauseRequest('A', 'account', r.requestId)).active).toBe(false)
    await expect(admin.requestPause('A', 'account', r.requestId)).rejects.toThrow(
      'pause_request_obsolete'
    )
    await privileged("UPDATE accounts SET paused=false WHERE tenant_id='A' AND id='account'")
    await app()
    await expect(
      pause.challenge(token, {
        requestId: r.requestId,
        attemptId: randomUUID(),
        runtime: context(),
        instanceEpoch: 7
      })
    ).rejects.toThrow('PAUSE_OBSOLETE')
  })
  it('rejects foreign accounts, tenants, scopes and revoked devices even with a known request ID', async () => {
    const r = await request(),
      c = await challenge(r.requestId)
    for (const credential of [foreign, other])
      await expect(
        pause.challenge(credential, {
          requestId: r.requestId,
          attemptId: randomUUID(),
          runtime: context(),
          instanceEpoch: 7
        })
      ).rejects.toThrow('PAUSE_OBSOLETE')
    await expect(
      pause.report(token, {
        ...report(c),
        challenge: { ...c, scope: { ...c.scope, account_id: 'other' } }
      })
    ).rejects.toThrow('PAUSE_CONFLICT')
    await privileged(
      "UPDATE agents SET revoked_at=clock_timestamp() WHERE tenant_id='A' AND id='agent'"
    )
    await app()
    await expect(pause.report(token, report(c))).rejects.toThrow('DENIED')
    await login()
    await expect(admin.requestPause('B', 'account')).rejects.toThrow('DENIED')
    expect(
      (await pg.db.transaction('B', (db) => db.query('SELECT * FROM account_pause_requests'))).rows
    ).toEqual([])
  })
  it('enforces strict stopped facts and prevents app/admin mutation of immutable history', async () => {
    const r = await request(),
      c = await challenge(r.requestId)
    for (const body of [
      { ...report(c), canResume: true },
      { ...report(c), stopped: { ...report(c).stopped, senderQuiescent: false } },
      { ...report(c), challenge: { ...c, purpose: 'ledger_restore' } }
    ])
      await expect(pause.report(token, body)).rejects.toThrow('INVALID_REQUEST')
    await pause.report(token, report(c))
    await expect(
      pg.db.transaction('A', (db) =>
        db.query('UPDATE account_pause_reports SET report_hash=$1', ['b'.repeat(64)])
      )
    ).rejects.toThrow()
    await login()
    await expect(
      pg.db.transaction('A', (db) => db.query('DELETE FROM account_pause_requests'))
    ).rejects.toThrow()
  })
  it('rolls back pause, targets and journal when audit persistence fails', async () => {
    await privileged(
      "CREATE FUNCTION fail_pause_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='account_pause_requested' THEN RAISE EXCEPTION 'synthetic_pause_audit_failure'; END IF; RETURN NEW; END $$;CREATE TRIGGER fail_pause_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_pause_audit()"
    )
    await login()
    try {
      await expect(admin.requestPause('A', 'account')).rejects.toThrow(
        'synthetic_pause_audit_failure'
      )
      expect(
        (
          await pg.db.transaction('A', (db) =>
            db.query("SELECT paused FROM accounts WHERE id='account'")
          )
        ).rows
      ).toEqual([{ paused: false }])
      expect(
        (await pg.db.transaction('A', (db) => db.query('SELECT * FROM account_pause_heads'))).rows
      ).toEqual([])
    } finally {
      await privileged(
        'DROP TRIGGER fail_pause_audit ON audit_events;DROP FUNCTION fail_pause_audit()'
      )
    }
  })
  it('rejects expired or future challenges and rolls back a report whose insertion crossed the deadline', async () => {
    const r = await request(),
      current = await challenge(r.requestId)
    for (const delta of [-60000, 60000]) {
      const c = {
        ...current,
        challengeId: randomUUID(),
        attemptId: randomUUID(),
        issuedAt: current.issuedAt + delta,
        expiresAt: current.expiresAt + delta
      }
      await privileged(
        `INSERT INTO account_pause_challenges VALUES('A','account','${r.requestId}','agent','${c.challengeId}','${c.attemptId}','${hashContext(c)}','${JSON.stringify(c)}',to_timestamp(${c.issuedAt}::numeric/1000),to_timestamp(${c.expiresAt}::numeric/1000))`
      )
      await app()
      await expect(pause.report(token, report(c))).rejects.toThrow('PAUSE_EXPIRED')
    }
    await privileged(
      `CREATE FUNCTION cross_pause_deadline() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.received_at=to_timestamp(${current.expiresAt}::numeric/1000);RETURN NEW;END $$;CREATE TRIGGER cross_pause_deadline BEFORE INSERT ON account_pause_reports FOR EACH ROW EXECUTE FUNCTION cross_pause_deadline()`
    )
    await app()
    try {
      await expect(pause.report(token, report(current))).rejects.toThrow('PAUSE_EXPIRED')
      expect(
        (await pg.db.transaction('A', (db) => db.query('SELECT * FROM account_pause_reports'))).rows
      ).toEqual([])
    } finally {
      await privileged(
        'DROP TRIGGER cross_pause_deadline ON account_pause_reports;DROP FUNCTION cross_pause_deadline()'
      )
    }
  })
  it('does not renew a duplicate confirmation and refuses corrupted immutable evidence', async () => {
    const r = await request(),
      c = await challenge(r.requestId),
      body = report(c),
      first = await pause.report(token, body)
    expect(await pause.report(token, body)).toEqual(first)
    await privileged(
      `ALTER TABLE account_pause_reports DISABLE TRIGGER USER;UPDATE account_pause_reports SET report_hash='${'b'.repeat(64)}';ALTER TABLE account_pause_reports ENABLE TRIGGER USER`
    )
    await app()
    await expect(pause.report(token, body)).rejects.toThrow('PAUSE_INVALID_HISTORY')
    await login()
    expect(
      (await admin.runtimeStatus('A')).rows.find((r) => r.agentId === 'agent')?.pauseConfirmation
    ).toBe('invalid')
  })
})
