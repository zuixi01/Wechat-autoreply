import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { embeddedPostgres } from '../fixtures/embedded-postgres'
import { AccountAuthority, tokenHash } from '../../server/src/auth/account-authority'
import { applyCentralRestoreQuarantine } from '../../server/src/recovery/central-restore-quarantine'

let pg: Awaited<ReturnType<typeof embeddedPostgres>>
let client: PoolClient
const token = 'A'.repeat(43),
  code = 'B'.repeat(43)
const input = () => ({
  restoreId: randomUUID(),
  backupId: randomUUID(),
  archiveSha256: 'a'.repeat(64),
  archiveBytes: 4096,
  databaseName: 'postgres'
})
beforeAll(async () => {
  pg = await embeddedPostgres()
  client = {
    query: async (text: string, values?: unknown[]) => {
      const result = await pg.sql.query(text, values)
      return { ...result, rowCount: Math.max(result.affectedRows ?? 0, result.rows.length) }
    }
  } as unknown as PoolClient
}, 20000)
afterAll(async () => {
  await pg?.db.close()
})
beforeEach(async () => {
  await pg.adminExec(`TRUNCATE database_restore_quarantines; TRUNCATE tenants CASCADE;
    INSERT INTO tenants VALUES('A','fixture A'),('B','fixture B');
    INSERT INTO employees VALUES('A','employee','employee',true),('B','employee','employee',true);
    INSERT INTO accounts(tenant_id,id,employee_id,platform,paused) VALUES('A','account','employee','wechat',false),('B','account','employee','wework',false);
    INSERT INTO agents(tenant_id,id,account_id,employee_id,token_hash) VALUES('A','agent','account','employee','${tokenHash(token)}'),('B','agent','account','employee','fixture-B');
    INSERT INTO account_leases VALUES('A','account','agent',1,'fixture-A',1,clock_timestamp()+interval '1 minute'),('B','account','agent',1,'fixture-B',1,clock_timestamp()+interval '1 minute');
    INSERT INTO enrollment_codes(code_hash,tenant_id,account_id,employee_id,expires_at) VALUES('${tokenHash(code)}','A','account','employee',clock_timestamp()+interval '1 hour');
    INSERT INTO execution_permits(tenant_id,account_id,id,agent_id,lease_version,task_id,draft_hash,status) VALUES('A','account','old-unknown','agent',1,'old-task','old-draft','unknown');
    INSERT INTO generation_publications(tenant_id,account_id,config_version,publication_hash,config_json,policy_json,evidence_json,text_generator_version) VALUES('A','account','v1','fixture','{"product":"source-rules"}','{}','[]','fixture');`)
  await pg.sql.exec('RESET ROLE')
})
describe('central restored database quarantine', () => {
  it('atomically stops every tenant and preserves execution, publication and original identities', async () => {
    const before = await pg.sql.query('SELECT row_to_json(p) AS data FROM execution_permits p')
    const request = input(),
      receipt = await applyCentralRestoreQuarantine(client, request)
    expect(receipt).toMatchObject({
      ...request,
      canRelease: false,
      automaticStart: false,
      requiresHistoryReview: true,
      counts: {
        accounts: 2,
        unrevokedAgents: 2,
        liveLeases: 2,
        unusedEnrollmentCodes: 1,
        unresolvedPermits: 1
      }
    })
    expect(
      (await pg.sql.query('SELECT row_to_json(p) AS data FROM execution_permits p')).rows
    ).toEqual(before.rows)
    expect((await pg.sql.query('SELECT config_json FROM generation_publications')).rows).toEqual([
      { config_json: { product: 'source-rules' } }
    ])
    expect(
      (await pg.sql.query('SELECT bool_and(paused) AS all_paused FROM accounts')).rows
    ).toEqual([{ all_paused: true }])
    expect(
      (await pg.sql.query('SELECT bool_and(revoked_at IS NOT NULL) AS stopped FROM agents')).rows
    ).toEqual([{ stopped: true }])
    expect(
      (
        await pg.sql.query(
          'SELECT count(*)::int AS n FROM account_leases WHERE expires_at>clock_timestamp()'
        )
      ).rows
    ).toEqual([{ n: 0 }])
    expect(
      (
        await pg.sql.query(
          "SELECT count(*)::int AS n FROM audit_events WHERE kind='central_database_restored'"
        )
      ).rows
    ).toEqual([{ n: 2 }])
    await pg.sql.exec('SET ROLE autoreply_app')
    const authority = new AccountAuthority(pg.db)
    await expect(authority.authenticate(token)).rejects.toMatchObject({ code: 'DENIED' })
    await expect(authority.register(code, randomUUID())).rejects.toMatchObject({ code: 'DENIED' })
  })
  it('blocks direct resumption, live lease and issuance even for admin SQL, keeps history append-only', async () => {
    await applyCentralRestoreQuarantine(client, input())
    await pg.sql.exec("SET ROLE autoreply_app; SELECT set_config('app.tenant_id','A',false)")
    await expect(
      pg.sql.exec("UPDATE accounts SET paused=false WHERE tenant_id='A' AND id='account'")
    ).rejects.toThrow('central_restore_review_pending')
    await expect(
      pg.sql.exec(
        "UPDATE account_leases SET expires_at=clock_timestamp()+interval '1 minute' WHERE tenant_id='A'"
      )
    ).rejects.toThrow('central_restore_review_pending')
    await expect(
      pg.sql.exec("UPDATE execution_permits SET status='issued' WHERE id='old-unknown'")
    ).rejects.toThrow('central_restore_review_pending')
    await expect(pg.sql.exec('DELETE FROM database_restore_quarantines')).rejects.toThrow()
    await pg.sql.exec('RESET ROLE')
    await expect(
      pg.sql.exec(
        "INSERT INTO accounts(tenant_id,id,employee_id,platform,paused) VALUES('B','new-account','employee','wework',false)"
      )
    ).rejects.toThrow('central_restore_review_pending')
    await expect(
      pg.sql.exec("UPDATE database_restore_quarantines SET context_hash=repeat('b',64)")
    ).rejects.toThrow('central_restore_history_immutable')
  })
  it('validates exact database and authority before touching restored data', async () => {
    await expect(
      applyCentralRestoreQuarantine(client, { ...input(), databaseName: 'wrong_database' })
    ).rejects.toThrow('central_restore_database_mismatch')
    expect(
      (await pg.sql.query('SELECT count(*)::int AS n FROM accounts WHERE paused')).rows
    ).toEqual([{ n: 0 }])
    await pg.sql.exec('SET ROLE autoreply_app')
    await expect(applyCentralRestoreQuarantine(client, input())).rejects.toThrow(
      'central_restore_denied'
    )
  })
  it('reuses an exact commit and chains a new restore, rejecting changed bindings and corrupt ancestors', async () => {
    const request = input(),
      first = await applyCentralRestoreQuarantine(client, request)
    expect(await applyCentralRestoreQuarantine(client, request)).toEqual(first)
    await expect(
      applyCentralRestoreQuarantine(client, { ...request, archiveSha256: 'b'.repeat(64) })
    ).rejects.toThrow('central_restore_context_conflict')
    const next = await applyCentralRestoreQuarantine(client, input())
    expect(next.previousRestoreId).toBe(first.restoreId)
    expect(next.previousContextHash).toBe(first.contextHash)
    await pg.sql.exec(
      "ALTER TABLE database_restore_quarantines DISABLE TRIGGER central_restore_history_immutable; UPDATE database_restore_quarantines SET context_hash=repeat('b',64); ALTER TABLE database_restore_quarantines ENABLE TRIGGER central_restore_history_immutable"
    )
    await expect(applyCentralRestoreQuarantine(client, input())).rejects.toThrow(
      'central_restore_history_invalid'
    )
  })
  it('rolls back all state and audits if the immutable receipt cannot be written', async () => {
    await pg.sql.exec(
      "CREATE FUNCTION fixture_fail_central_restore() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture_storage_failure'; END $$; CREATE TRIGGER fixture_fail_central_restore BEFORE INSERT ON database_restore_quarantines FOR EACH ROW EXECUTE FUNCTION fixture_fail_central_restore()"
    )
    try {
      await expect(applyCentralRestoreQuarantine(client, input())).rejects.toThrow(
        'central_restore_quarantine_failed'
      )
      expect(
        (await pg.sql.query('SELECT count(*)::int AS n FROM accounts WHERE paused')).rows
      ).toEqual([{ n: 0 }])
      expect((await pg.sql.query('SELECT count(*)::int AS n FROM audit_events')).rows).toEqual([
        { n: 0 }
      ])
    } finally {
      await pg.sql.exec(
        'DROP TRIGGER fixture_fail_central_restore ON database_restore_quarantines; DROP FUNCTION fixture_fail_central_restore()'
      )
    }
  })
  it('fails closed if the guard loses its privileged owner and leaves an unrestored database operational', async () => {
    await pg.sql.exec(
      "UPDATE accounts SET paused=true WHERE tenant_id='A'; UPDATE accounts SET paused=false WHERE tenant_id='A'"
    )
    await applyCentralRestoreQuarantine(client, input())
    await pg.sql.exec(
      'CREATE ROLE central_restore_limited NOLOGIN NOSUPERUSER NOBYPASSRLS; ALTER FUNCTION guard_central_restore() OWNER TO central_restore_limited'
    )
    try {
      await expect(
        pg.sql.exec("UPDATE accounts SET paused=true WHERE tenant_id='A'")
      ).rejects.toThrow('central_restore_guard_owner_invalid')
    } finally {
      await pg.sql.exec(
        'ALTER FUNCTION guard_central_restore() OWNER TO postgres; DROP ROLE central_restore_limited'
      )
    }
  })
  it('rolls back revocation, pause and the receipt when the final audit append fails', async () => {
    await pg.sql.exec(
      "CREATE FUNCTION fixture_fail_restore_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture_audit_failure'; END $$; CREATE TRIGGER fixture_fail_restore_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fixture_fail_restore_audit()"
    )
    try {
      await expect(applyCentralRestoreQuarantine(client, input())).rejects.toThrow(
        'central_restore_quarantine_failed'
      )
      expect(
        (await pg.sql.query<{ n: number }>('SELECT count(*)::int AS n FROM accounts WHERE paused'))
          .rows[0].n
      ).toBe(0)
      expect(
        (
          await pg.sql.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM agents WHERE revoked_at IS NOT NULL'
          )
        ).rows[0].n
      ).toBe(0)
      expect(
        (
          await pg.sql.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM database_restore_quarantines'
          )
        ).rows[0].n
      ).toBe(0)
      expect(
        (
          await pg.sql.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM enrollment_codes WHERE expires_at>clock_timestamp()'
          )
        ).rows[0].n
      ).toBe(1)
    } finally {
      await pg.sql.exec(
        'DROP TRIGGER fixture_fail_restore_audit ON audit_events; DROP FUNCTION fixture_fail_restore_audit()'
      )
    }
  })
})
