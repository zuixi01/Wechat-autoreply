import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { embeddedPostgres } from '../fixtures/embedded-postgres'
import { Administration } from '../../server/src/admin/administration'
import { AccountAuthority, tokenHash } from '../../server/src/auth/account-authority'
import type { Publication } from '../../server/src/generation/publication'
import { randomUUID } from 'node:crypto'
import { hashContext } from '../../src/core/reply/hashes'
import { LegacySettingsArchive } from '../../src/core/persistence/legacy-settings-archive'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { learningHash } from '../../src/core/memory/learning-scope'
import { EnterpriseLearningManagement } from '../../server/src/learning/learning-service'
import { LearningWorkbenchSnapshotSchema } from '../../src/shared/contracts/learning-management'

function removeLegacyFixture(root: string): void {
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep + 'legacy-publish-'))
    throw new Error('unexpected_fixture_path')
  rmSync(root, { recursive: true, force: true })
}

let pg: Awaited<ReturnType<typeof embeddedPostgres>>, admin: Administration, p: Publication
const privileged = async (text: string) => {
  await pg.sql.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE')
  await pg.sql.exec(text)
}
const login = async (name = 'synthetic_admin') => {
  await pg.sql.exec(
    `SET SESSION AUTHORIZATION postgres; RESET ROLE; SET SESSION AUTHORIZATION ${name}`
  )
}
beforeAll(async () => {
  pg = await embeddedPostgres()
  await privileged(`CREATE ROLE synthetic_admin LOGIN NOSUPERUSER NOBYPASSRLS;
    GRANT autoreply_admin TO synthetic_admin;
    INSERT INTO tenants(id,name) VALUES('A','合成企业 A'),('B','合成企业 B');
    INSERT INTO employees(tenant_id,id,role) VALUES('A','admin-A','admin'),('B','admin-B','admin');
    INSERT INTO admin_database_principals(login_name,tenant_id,employee_id) VALUES('synthetic_admin','A','admin-A');`)
  admin = new Administration(pg.db, 'synthetic-generator-v1')
}, 20000)
afterAll(async () => {
  if (pg) await pg.db.close()
})

async function seedReconciliation(status = 'unknown'): Promise<void> {
  await privileged(`
    UPDATE accounts SET paused=false WHERE tenant_id='A' AND id='account-A';
    INSERT INTO agents(tenant_id,id,account_id,employee_id,token_hash)
      VALUES('A','agent-A','account-A','employee-A','synthetic-reconcile-token-hash');
    INSERT INTO account_leases(tenant_id,account_id,agent_id,login_epoch,client_instance_id,version,expires_at)
      VALUES('A','account-A','agent-A',3,'client-A',7,clock_timestamp()+interval '10 minutes');
    INSERT INTO execution_permits(tenant_id,account_id,id,agent_id,lease_version,task_id,draft_hash,status,
      task_hash,draft_revision,login_epoch,client_instance_id,conversation_id,issued_at,expires_at,settlement_hash)
      VALUES('A','account-A','permit-A','agent-A',7,'task-A','${'d'.repeat(64)}','${status}',
        '${'a'.repeat(64)}',2,3,'client-A','conversation-A',clock_timestamp()-interval '2 minutes',
        clock_timestamp()-interval '1 minute','${'b'.repeat(64)}');`)
  await login()
}

describe('append-only administrator reconciliation preparation', () => {
  it('reports known tokens and unfinished/unknown calls separately, and changing quota does not reset usage', async () => {
    await admin.setModelLimits('A', 'account-A', { dailyAttemptLimit: 3 })
    await privileged(`UPDATE accounts SET paused=false;
      INSERT INTO agents(tenant_id,id,account_id,employee_id,token_hash) VALUES('A','meter-agent','account-A','employee-A','meter-hash');
      INSERT INTO generation_tasks(tenant_id,account_id,task_id,agent_id,request_hash,task_json,status,expires_at)
        VALUES('A','account-A','meter-task','meter-agent','${'a'.repeat(64)}','{}','running',clock_timestamp()+interval '1 minute');
      INSERT INTO model_call_attempts(tenant_id,account_id,id,agent_id,task_id,task_hash,provider,stage,attempt_number,request_hash,requested_model,question_hash,config_version,policy_version,question_set_version,knowledge_version,limit_revision)
        VALUES('A','account-A','call-1','meter-agent','meter-task','${'b'.repeat(64)}','jev','pre',1,'${'c'.repeat(64)}','alias','${'d'.repeat(64)}','config','policy','questions','knowledge',1),
        ('A','account-A','call-2','meter-agent','meter-task','${'b'.repeat(64)}','jev','pre',2,'${'c'.repeat(64)}','alias','${'d'.repeat(64)}','config','policy','questions','knowledge',1),
        ('A','account-A','call-3','meter-agent','meter-task','${'b'.repeat(64)}','jev','post',1,'${'c'.repeat(64)}','alias','${'d'.repeat(64)}','config','policy','questions','knowledge',1);
      INSERT INTO model_call_results(tenant_id,account_id,attempt_id,result_hash,result_json) VALUES
        ('A','account-A','call-1','${'e'.repeat(64)}','{"outcome":"response","durationMs":10,"actualModel":"resolved","usage":{"inputTokens":10,"outputTokens":5}}'),
        ('A','account-A','call-2','${'f'.repeat(64)}','{"outcome":"timed_out","durationMs":100,"failureCode":"TIMEOUT"}');`)
    await login()
    const date = (
      await pg.db.transaction('A', (db) =>
        db.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD') AS day")
      )
    ).rows[0].day
    expect(await admin.modelUsage('A', 'account-A', date)).toMatchObject([
      {
        stage: 'post',
        reserved_attempts: 1,
        unfinished_attempts: 1,
        unknown_usage_attempts: 1,
        known_input_tokens: '0',
        known_output_tokens: '0',
        completed_p50_ms: null
      },
      {
        stage: 'pre',
        reserved_attempts: 2,
        unfinished_attempts: 0,
        unknown_usage_attempts: 1,
        known_input_tokens: '10',
        known_output_tokens: '5',
        completed_p50_ms: 55,
        completed_p95_ms: 95.5
      }
    ])
    const runs = await admin.modelRuns('A', 'account-A', 'meter-task')
    expect(runs).toHaveLength(3)
    expect(runs[2].result_json).toBeNull()
    expect(await admin.modelLimits('A', 'account-A')).toMatchObject({
      reservedToday: 3,
      dailyAttemptLimit: 3
    })
    await admin.setModelLimits('A', 'account-A', { dailyAttemptLimit: 5 })
    expect(await admin.modelLimits('A', 'account-A')).toMatchObject({
      reservedToday: 3,
      dailyAttemptLimit: 5,
      revision: '2'
    })
  })
  it('sets an audited account quota without resetting existing reservations, and identical configuration is idempotent', async () => {
    expect(await admin.modelLimits('A', 'account-A')).toMatchObject({
      dailyAttemptLimit: null,
      reservedToday: 0,
      timezone: 'UTC'
    })
    const first = await admin.setModelLimits('A', 'account-A', { dailyAttemptLimit: 30 })
    expect(first).toEqual({ accountId: 'account-A', dailyAttemptLimit: 30, revision: '1' })
    expect(await admin.setModelLimits('A', 'account-A', { dailyAttemptLimit: 30 })).toEqual(first)
    expect(await admin.setModelLimits('A', 'account-A', { dailyAttemptLimit: 0 })).toMatchObject({
      dailyAttemptLimit: 0,
      revision: '2'
    })
    expect(await admin.modelLimits('A', 'account-A')).toMatchObject({
      dailyAttemptLimit: 0,
      reservedToday: 0
    })
    const audit = await pg.db.transaction('A', (db) =>
      db.query(
        "SELECT details_json FROM audit_events WHERE kind='model_call_limit_set' ORDER BY created_at,id"
      )
    )
    expect(audit.rows).toHaveLength(2)
    expect(audit.rows[1].details_json).toMatchObject({
      dailyAttemptLimit: 0,
      previousLimit: 30,
      revision: '2'
    })
    for (const input of [
      { dailyAttemptLimit: -1 },
      { dailyAttemptLimit: 100001 },
      { dailyAttemptLimit: 1, resetUsage: true }
    ])
      await expect(admin.setModelLimits('A', 'account-A', input)).rejects.toThrow()
  })
  it('commits quota updates and audit atomically', async () => {
    await privileged(`CREATE FUNCTION fail_model_limit_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='model_call_limit_set' THEN RAISE EXCEPTION 'synthetic_audit_failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_model_limit_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_model_limit_audit();`)
    await login()
    try {
      await expect(
        admin.setModelLimits('A', 'account-A', { dailyAttemptLimit: 30 })
      ).rejects.toThrow('synthetic_audit_failure')
      expect(await admin.modelLimits('A', 'account-A')).toMatchObject({ dailyAttemptLimit: null })
    } finally {
      await privileged(
        'DROP TRIGGER fail_model_limit_audit ON audit_events; DROP FUNCTION fail_model_limit_audit()'
      )
      await login()
    }
  })
  it('denies foreign tenant quota and usage access even after changing the SQL tenant setting', async () => {
    await privileged(`INSERT INTO employees(tenant_id,id,role) VALUES('B','employee-B','employee');
      INSERT INTO accounts(tenant_id,id,employee_id,platform) VALUES('B','account-B','employee-B','wechat');
      INSERT INTO model_call_limits(tenant_id,account_id,daily_attempt_limit,revision) VALUES('B','account-B',100,1);`)
    await login()
    await expect(admin.modelLimits('B', 'account-B')).rejects.toThrow('DENIED')
    await expect(admin.setModelLimits('B', 'account-B', { dailyAttemptLimit: 1 })).rejects.toThrow(
      'DENIED'
    )
    await expect(admin.modelUsage('B', 'account-B', '2026-10-02')).rejects.toThrow('DENIED')
    const rows = await pg.db.transaction('B', (db) => db.query('SELECT * FROM model_call_limits'))
    expect(rows.rows).toEqual([])
    await expect(
      pg.db.transaction('B', (db) =>
        db.query("UPDATE model_call_limits SET daily_attempt_limit=0 WHERE tenant_id='B'")
      )
    ).resolves.toMatchObject({ rowCount: 0 })
    await login('autoreply_app')
    await expect(admin.setModelLimits('A', 'account-A', { dailyAttemptLimit: 1 })).rejects.toThrow()
  })
  it('opens one exact immutable case, pauses admission and preserves live lease/unknown receipt', async () => {
    await seedReconciliation()
    const saved = await admin.openReconciliation('A', 'account-A', 'permit-A')
    expect(saved).toMatchObject({
      openedBy: 'admin-A',
      noteCount: 0,
      devicePauseAcknowledged: null,
      snapshot: {
        tenantId: 'A',
        accountId: 'account-A',
        permitId: 'permit-A',
        agentId: 'agent-A',
        taskId: 'task-A',
        taskHash: 'a'.repeat(64),
        draftHash: 'd'.repeat(64),
        draftRevision: 2,
        loginEpoch: 3,
        clientInstanceId: 'client-A',
        leaseVersion: 7,
        conversationId: 'conversation-A',
        statusAtOpening: 'unknown',
        purpose: 'automatic',
        confirmationId: null,
        settlementHash: 'b'.repeat(64)
      }
    })
    expect(saved.snapshotHash).toBe(hashContext(saved.snapshot))
    expect(await admin.openReconciliation('A', 'account-A', 'permit-A')).toEqual(saved)
    expect(await admin.accounts('A')).toMatchObject([
      { server_paused: true, lease_live: true, unresolved_count: 1 }
    ])
    expect(await admin.unresolved('A', 'account-A')).toMatchObject([{ status: 'unknown' }])
    const audit = await pg.db.transaction('A', (db) =>
      db.query("SELECT kind FROM audit_events WHERE kind LIKE 'reconciliation_%' ORDER BY kind")
    )
    expect(audit.rows).toEqual([
      { kind: 'reconciliation_account_paused' },
      { kind: 'reconciliation_opened' }
    ])
    expect(await admin.reconciliations('A', 'account-A')).toMatchObject([
      {
        case_id: saved.caseId,
        snapshot_hash: saved.snapshotHash,
        current_permit_status: 'unknown',
        note_count: 0
      }
    ])
  })

  it('records bound metadata idempotently without granting stop acknowledgment, resume or settlement', async () => {
    await seedReconciliation('issued')
    const saved = await admin.openReconciliation('A', 'account-A', 'permit-A')
    const note = {
      noteId: randomUUID(),
      snapshotHash: saved.snapshotHash,
      referenceId: 'TICKET-001',
      evidenceHash: 'e'.repeat(64),
      observedAt: Date.now()
    }
    const first = await admin.recordReconciliationNote('A', 'account-A', saved.caseId, note)
    expect(first.devicePauseAcknowledged).toBeNull()
    expect(await admin.recordReconciliationNote('A', 'account-A', saved.caseId, note)).toEqual(
      first
    )
    await expect(
      admin.recordReconciliationNote('A', 'account-A', saved.caseId, {
        ...note,
        evidenceHash: 'f'.repeat(64)
      })
    ).rejects.toThrow('RECONCILIATION_CONFLICT')
    const read = await admin.reconciliation('A', 'account-A', saved.caseId)
    expect(read.case.noteCount).toBe(1)
    expect(read.notes).toMatchObject([
      {
        note_id: note.noteId,
        reference_id: 'TICKET-001',
        evidence_hash: 'e'.repeat(64),
        recorded_by: 'admin-A'
      }
    ])
    expect(read.currentPermitStatus).toBe('issued')
    await admin.publish('A', 'account-A', p)
    await expect(admin.resume('A', 'account-A')).rejects.toThrow('UNRESOLVED_EXECUTION')
    expect(await admin.accounts('A')).toMatchObject([{ server_paused: true }])
    const audit = await pg.db.transaction('A', (db) =>
      db.query("SELECT details_json FROM audit_events WHERE kind='reconciliation_note_recorded'")
    )
    expect(audit.rows).toHaveLength(1)
    expect(audit.rows[0].details_json).toMatchObject({
      noteId: note.noteId,
      snapshotHash: saved.snapshotHash
    })
  })

  it('rejects tenant/account/role crossing, forged note results, stale hashes and invalid observation times', async () => {
    await seedReconciliation()
    const saved = await admin.openReconciliation('A', 'account-A', 'permit-A')
    await admin.provision('A', {
      accountId: 'account-other',
      employeeId: 'employee-other',
      platform: 'wechat'
    })
    await expect(admin.openReconciliation('A', 'account-other', 'permit-A')).rejects.toThrow(
      'RECONCILIATION_NOT_FOUND'
    )
    await expect(admin.reconciliation('A', 'account-other', saved.caseId)).rejects.toThrow(
      'RECONCILIATION_NOT_FOUND'
    )
    await expect(admin.reconciliations('B', 'account-A')).rejects.toThrow('DENIED')
    const note = {
      noteId: randomUUID(),
      snapshotHash: saved.snapshotHash,
      referenceId: 'TICKET-001',
      evidenceHash: 'e'.repeat(64),
      observedAt: Date.now()
    }
    for (const changed of [
      { ...note, snapshotHash: 'f'.repeat(64) },
      { ...note, observedAt: saved.snapshot.issuedAt - 1 },
      { ...note, observedAt: Date.now() + 60000 },
      { ...note, status: 'not_sent' },
      { ...note, quiescent: true },
      { ...note, referenceId: 'https://secret.example/chat' },
      { ...note, chat: 'private conversation' }
    ])
      await expect(
        admin.recordReconciliationNote('A', 'account-A', saved.caseId, changed)
      ).rejects.toThrow()
    expect((await admin.reconciliation('A', 'account-A', saved.caseId)).notes).toEqual([])
    await login('autoreply_app')
    await expect(admin.openReconciliation('A', 'account-A', 'permit-A')).rejects.toThrow('DENIED')
    await expect(
      pg.db.transaction('A', (db) => db.query('SELECT * FROM reconciliation_notes'))
    ).rejects.toThrow(/permission denied/i)
  })

  it('keeps cases/notes immutable even for the administrator and refuses forged audit actors', async () => {
    await seedReconciliation()
    const saved = await admin.openReconciliation('A', 'account-A', 'permit-A')
    for (const text of [
      'DELETE FROM reconciliation_cases',
      "UPDATE reconciliation_cases SET snapshot_hash='forged'",
      'DELETE FROM reconciliation_notes',
      "UPDATE reconciliation_notes SET reference_id='changed'",
      "UPDATE execution_permits SET status='not_sent'"
    ])
      await expect(pg.db.transaction('A', (db) => db.query(text))).rejects.toThrow(
        /permission denied/i
      )
    await expect(
      pg.db.transaction('A', (db) =>
        db.query(
          `INSERT INTO reconciliation_notes(tenant_id,account_id,id,case_id,snapshot_hash,reference_id,evidence_hash,request_hash,observed_at,recorded_by)
       VALUES('A','account-A',$1,$2,$3,'TICKET-001',$4,$4,clock_timestamp(),'employee-A')`,
          [randomUUID(), saved.caseId, saved.snapshotHash, 'e'.repeat(64)]
        )
      )
    ).rejects.toThrow(/row.level security/i)
    await privileged('UPDATE admin_database_principals SET enabled=false')
    await login()
    await expect(admin.reconciliation('A', 'account-A', saved.caseId)).rejects.toThrow('DENIED')
  })

  it('rolls back pause, case and note writes when the audit cannot persist', async () => {
    await seedReconciliation()
    await privileged(`CREATE FUNCTION autoreply.fail_reconciliation_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.kind IN ('reconciliation_opened','reconciliation_note_recorded') THEN RAISE EXCEPTION 'synthetic_audit_failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_reconciliation_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION autoreply.fail_reconciliation_audit()`)
    await login()
    try {
      await expect(admin.openReconciliation('A', 'account-A', 'permit-A')).rejects.toThrow(
        'synthetic_audit_failure'
      )
      expect(await admin.reconciliations('A', 'account-A')).toEqual([])
      expect(await admin.accounts('A')).toMatchObject([{ server_paused: false }])
      await privileged('ALTER TABLE audit_events DISABLE TRIGGER reject_reconciliation_audit')
      await login()
      const saved = await admin.openReconciliation('A', 'account-A', 'permit-A')
      await privileged('ALTER TABLE audit_events ENABLE TRIGGER reject_reconciliation_audit')
      await login()
      await expect(
        admin.recordReconciliationNote('A', 'account-A', saved.caseId, {
          noteId: randomUUID(),
          snapshotHash: saved.snapshotHash,
          referenceId: 'TICKET-001',
          evidenceHash: 'e'.repeat(64),
          observedAt: Date.now()
        })
      ).rejects.toThrow('synthetic_audit_failure')
      expect((await admin.reconciliation('A', 'account-A', saved.caseId)).notes).toEqual([])
    } finally {
      await privileged(
        'DROP TRIGGER reject_reconciliation_audit ON audit_events; DROP FUNCTION autoreply.fail_reconciliation_audit()'
      )
      await login()
    }
  })

  it('preserves original snapshot after later settlement, and refuses opening terminal or missing permits', async () => {
    await seedReconciliation('issued')
    const saved = await admin.openReconciliation('A', 'account-A', 'permit-A')
    await privileged(
      "UPDATE execution_permits SET status='unknown',settled_at=clock_timestamp() WHERE id='permit-A'"
    )
    await login()
    const after = await admin.reconciliation('A', 'account-A', saved.caseId)
    expect(after.case).toEqual(saved)
    expect(after.currentPermitStatus).toBe('unknown')
    await privileged(
      "UPDATE execution_permits SET status='confirmed' WHERE id='permit-A'; UPDATE accounts SET paused=false"
    )
    await login()
    await expect(admin.openReconciliation('A', 'account-A', 'permit-A')).rejects.toThrow(
      'RECONCILIATION_CONFLICT'
    )
    await expect(admin.openReconciliation('A', 'account-A', 'missing')).rejects.toThrow(
      'RECONCILIATION_NOT_FOUND'
    )
    expect(await admin.accounts('A')).toMatchObject([{ server_paused: false }])
    expect((await admin.reconciliation('A', 'account-A', saved.caseId)).case.snapshot).toEqual(
      saved.snapshot
    )
  })

  it('opens legacy unknown records without inventing missing identity or proof', async () => {
    await privileged(`INSERT INTO agents(tenant_id,id,account_id,employee_id,token_hash)
      VALUES('A','agent-A','account-A','employee-A','legacy-token-hash');
      INSERT INTO execution_permits(tenant_id,account_id,id,agent_id,lease_version,task_id,draft_hash,status)
      VALUES('A','account-A','legacy','agent-A',1,'legacy-task','legacy-hash','unknown')`)
    await login()
    expect(await admin.openReconciliation('A', 'account-A', 'legacy')).toMatchObject({
      snapshot: {
        taskHash: null,
        draftRevision: null,
        loginEpoch: null,
        clientInstanceId: null,
        conversationId: null,
        expiresAt: null,
        settlementHash: null
      },
      devicePauseAcknowledged: null
    })
  })
  it('caps case metadata at 100 notes but still permits an identical retry at the cap', async () => {
    await seedReconciliation()
    const saved = await admin.openReconciliation('A', 'account-A', 'permit-A')
    const note = {
      noteId: randomUUID(),
      snapshotHash: saved.snapshotHash,
      referenceId: 'TICKET-001',
      evidenceHash: 'e'.repeat(64),
      observedAt: Date.now()
    }
    await admin.recordReconciliationNote('A', 'account-A', saved.caseId, note)
    await privileged(`INSERT INTO reconciliation_notes(tenant_id,account_id,id,case_id,snapshot_hash,reference_id,evidence_hash,request_hash,observed_at,recorded_by)
      SELECT 'A','account-A','synthetic-note-'||n,'${saved.caseId}','${saved.snapshotHash}',
        'TICKET-'||n,'${'e'.repeat(64)}','${'f'.repeat(64)}',clock_timestamp(),'admin-A' FROM generate_series(2,100) n`)
    await login()
    expect((await admin.reconciliation('A', 'account-A', saved.caseId)).notes).toHaveLength(100)
    await expect(
      admin.recordReconciliationNote('A', 'account-A', saved.caseId, {
        ...note,
        noteId: randomUUID()
      })
    ).rejects.toThrow('RECONCILIATION_LIMIT')
    await expect(
      admin.recordReconciliationNote('A', 'account-A', saved.caseId, note)
    ).resolves.toMatchObject({ noteId: note.noteId })
  })
  it('rejects reusing a note ID for a different exact execution case', async () => {
    await seedReconciliation()
    const first = await admin.openReconciliation('A', 'account-A', 'permit-A')
    await privileged(`INSERT INTO execution_permits(tenant_id,account_id,id,agent_id,lease_version,task_id,draft_hash,status)
      VALUES('A','account-A','permit-other','agent-A',1,'task-other','hash','unknown')`)
    await login()
    const second = await admin.openReconciliation('A', 'account-A', 'permit-other')
    const note = {
      noteId: randomUUID(),
      snapshotHash: first.snapshotHash,
      referenceId: 'TICKET-001',
      evidenceHash: 'e'.repeat(64),
      observedAt: Date.now()
    }
    await admin.recordReconciliationNote('A', 'account-A', first.caseId, note)
    await expect(
      admin.recordReconciliationNote('A', 'account-A', second.caseId, {
        ...note,
        snapshotHash: second.snapshotHash
      })
    ).rejects.toThrow('RECONCILIATION_CONFLICT')
    expect((await admin.reconciliation('A', 'account-A', second.caseId)).notes).toEqual([])
  })
  it('keeps actual foreign tenant cases invisible after a raw SQL tenant-setting change', async () => {
    await seedReconciliation()
    const saved = await admin.openReconciliation('A', 'account-A', 'permit-A')
    const otherCase = randomUUID()
    await privileged(`INSERT INTO employees(tenant_id,id,role) VALUES('B','employee-B','employee');
      INSERT INTO accounts(tenant_id,id,employee_id,platform) VALUES('B','account-B','employee-B','wechat');
      INSERT INTO agents(tenant_id,id,account_id,employee_id,token_hash) VALUES('B','agent-B','account-B','employee-B','foreign-token-hash');
      INSERT INTO execution_permits(tenant_id,account_id,id,agent_id,lease_version,task_id,draft_hash,status)
        VALUES('B','account-B','permit-B','agent-B',1,'task-B','foreign-draft','unknown');
      INSERT INTO reconciliation_cases(tenant_id,account_id,id,permit_id,snapshot_hash,snapshot_json,opened_by)
        VALUES('B','account-B','${otherCase}','permit-B','${'f'.repeat(64)}','{}'::jsonb,'admin-B');
      INSERT INTO reconciliation_notes(tenant_id,account_id,id,case_id,snapshot_hash,reference_id,evidence_hash,request_hash,observed_at,recorded_by)
        VALUES('B','account-B','foreign-note','${otherCase}','${'f'.repeat(64)}','FOREIGN-TICKET','${'e'.repeat(64)}','${'d'.repeat(64)}',clock_timestamp(),'admin-B')`)
    await login()
    await pg.sql.query("SELECT set_config('app.tenant_id','B',false)")
    expect((await pg.sql.query('SELECT * FROM reconciliation_cases')).rows).toEqual([])
    expect((await pg.sql.query('SELECT * FROM reconciliation_notes')).rows).toEqual([])
    await expect(
      pg.sql.query(
        `INSERT INTO reconciliation_notes(tenant_id,account_id,id,case_id,snapshot_hash,reference_id,evidence_hash,request_hash,observed_at,recorded_by)
      VALUES('B','account-B','intruder-note',$1,$2,'TICKET',$3,$3,clock_timestamp(),'admin-B')`,
        [otherCase, 'f'.repeat(64), 'e'.repeat(64)]
      )
    ).rejects.toThrow(/row.level security/i)
    expect((await admin.reconciliation('A', 'account-A', saved.caseId)).case.caseId).toBe(
      saved.caseId
    )
  })
})
beforeEach(async () => {
  await privileged(`TRUNCATE learning_versions,learning_episodes,learning_memories,learning_revisions,learning_settings,learning_generations,learning_feedback,learning_quarantines,learning_tombstones,learning_mutations,
    model_call_results,model_call_attempts,model_call_limits,execution_request_seal_applications,execution_request_seals,reconciliation_applied,reconciliation_decisions,device_reconciliation_reports,reconciliation_notes,reconciliation_cases,evaluation_approvals,evaluation_runs,enrollment_codes,account_leases,execution_permits,human_confirmations,reviewed_replies,generation_tasks,
    generation_publications,published_configurations,agents,accounts,audit_events CASCADE;
    DELETE FROM employees WHERE role='employee';
    UPDATE employees SET enabled=true;
    UPDATE admin_database_principals SET enabled=true;`)
  await login()
  await admin.provision('A', {
    employeeId: 'employee-A',
    accountId: 'account-A',
    platform: 'wework'
  })
  const now = Date.now()
  p = {
    configuration: {
      configVersion: 'config-1',
      knowledgeVersion: 'knowledge-1',
      decisionPolicyVersion: 'policy-1',
      questionSetVersion: 'questions-1',
      modelResolved: 'jev-test',
      automaticEnabled: false
    },
    policy: {
      version: 'policy-1',
      knowledgeVersion: 'knowledge-1',
      questionSetVersion: 'questions-1',
      modelAlias: 'jev-test',
      modelResolved: 'jev-test',
      mode: 'shadow',
      evaluationApproved: false,
      automaticIntents: ['faq'],
      minimumChoiceProbability: 0.9,
      minimumChoiceConfidence: 0.8,
      minimumChoiceMargin: 0.3,
      presentIntentProbability: 0.9,
      humanRequestThreshold: 0.2,
      minimumAuditProbability: 0.95,
      reviewValidityMs: 5000,
      preBudgetMs: 1000,
      postBudgetMs: 1000
    },
    textGeneratorVersion: 'synthetic-generator-v1',
    evidence: [
      {
        evidenceId: 'faq-A',
        tenantId: 'A',
        knowledgeVersion: 'knowledge-1',
        intent: 'faq',
        kind: 'approved_faq',
        content: '合成知识',
        source: '合成资料',
        approvedBy: 'business-test',
        validFrom: now - 1000,
        expiresAt: now + 60000
      }
    ]
  }
})
describe('authenticated administrator operations on actual embedded PostgreSQL', () => {
  async function seedActiveLearning() {
    const episodeId = randomUUID(),
      memoryId = randomUUID(),
      now = Date.now()
    const content = {
      kind: 'lesson' as const,
      scenario: '询价',
      guidance: '先核对型号和数量，再查询现行资料',
      rationale: '',
      steps: [],
      pitfalls: [],
      verification: []
    }
    const contentHash = learningHash(content)
    await privileged('SELECT 1')
    await pg.sql.query(
      "INSERT INTO learning_episodes(tenant_id,account_id,id,source_id,input_hash,payload,created_at) VALUES('A','account-A',$1,$2,$3,$4::jsonb,$5)",
      [
        episodeId,
        'synthetic-human-source',
        learningHash('synthetic-source'),
        JSON.stringify({
          id: episodeId,
          scope: {
            workspaceId: `enterprise:${learningHash({ tenant: 'A', account: 'account-A' })}`,
            tenantId: 'A',
            accountId: 'account-A',
            platform: 'wework'
          },
          sourceId: 'synthetic-human-source',
          topic: '询价',
          outcome: 'corrected',
          startedAt: now,
          createdAt: now,
          messages: []
        }),
        now
      ]
    )
    await pg.sql.query(
      "INSERT INTO learning_memories(tenant_id,account_id,id,state,current_revision,active_revision,created_at,updated_at) VALUES('A','account-A',$1,'active',1,1,$2,$2)",
      [memoryId, now]
    )
    await pg.sql.query(
      "INSERT INTO learning_revisions(tenant_id,account_id,memory_id,revision,content_hash,payload,activated_at) VALUES('A','account-A',$1,1,$2,$3::jsonb,$4)",
      [
        memoryId,
        contentHash,
        JSON.stringify({
          memoryId,
          revision: 1,
          contentHash,
          content,
          evidence: [{ episodeId }],
          source: 'human',
          reason: 'synthetic-fixture',
          createdAt: now
        }),
        now
      ]
    )
    await login()
    return { episodeId, memoryId, content, contentHash, now }
  }
  it('prepares a fresh version-bound private draft without publishing or changing account admission', async () => {
    const memory = await seedActiveLearning()
    const prepared = await admin.prepareLearningPublication('A', 'account-A', p)
    expect(prepared.publication.memoryManifest).toEqual([
      { id: memory.memoryId, revision: 1, contentHash: memory.contentHash }
    ])
    expect(prepared.publication.configuration.configVersion).not.toBe(p.configuration.configVersion)
    expect(prepared.publication.configuration.memoryCorpusVersion).toBe(
      prepared.publication.memoryCorpusVersion
    )
    expect(prepared.summary).toMatchObject({
      publicationHash: hashContext(prepared.publication),
      methodCount: 1,
      requiresIndependentEvaluation: false
    })
    expect(await admin.accounts('A')).toMatchObject([{ server_paused: true, config_version: null }])
    const rows = await pg.db.transaction('A', (db) =>
      db.query(
        "SELECT kind,details_json FROM audit_events WHERE kind='learning_publication_prepared'"
      )
    )
    expect(rows.rows).toMatchObject([
      { details_json: { publicationHash: prepared.summary.publicationHash, methodCount: 1 } }
    ])
    expect(JSON.stringify(rows.rows)).not.toContain(memory.content.guidance)
    await admin.publish('A', 'account-A', prepared.publication)
    expect(await admin.accounts('A')).toMatchObject([
      {
        server_paused: true,
        config_version: prepared.publication.configuration.configVersion,
        automatic_enabled: false
      }
    ])
  })
  it('reports actual publication state to the enrolled employee without lending administrator authority', async () => {
    const memory = await seedActiveLearning()
    const enrollment = await admin.enroll('A', 'account-A')
    await login('autoreply_app')
    const authority = new AccountAuthority(pg.db)
    const device = await authority.register(enrollment.enrollmentCode, randomUUID())
    const management = new EnterpriseLearningManagement(pg.db, authority)
    const snapshot = async () => {
      await login('autoreply_app')
      return LearningWorkbenchSnapshotSchema.parse(
        await management.request(device.credential, 'snapshot', { conversationId: null })
      )
    }
    expect((await snapshot()).publication).toMatchObject({
      state: 'unpublished',
      tenantId: 'A',
      accountId: 'account-A',
      currentMethodCount: 1,
      serverPaused: true,
      published: null
    })
    await login()
    const prepared = await admin.prepareLearningPublication('A', 'account-A', p)
    expect((await snapshot()).publication?.state).toBe('unpublished')
    await login()
    await admin.publish('A', 'account-A', prepared.publication)
    expect((await snapshot()).publication).toMatchObject({
      state: 'current',
      published: {
        configVersion: prepared.publication.configuration.configVersion,
        methodCount: 1,
        automaticEnabled: false
      },
      serverPaused: true
    })
    await privileged('SELECT 1')
    await pg.sql.query(
      "UPDATE learning_memories SET state='stale' WHERE tenant_id='A' AND account_id='account-A' AND id=$1",
      [memory.memoryId]
    )
    expect((await snapshot()).publication).toMatchObject({
      state: 'outdated',
      currentMethodCount: 0,
      published: { methodCount: 1 }
    })
    await expect(admin.prepareLearningPublication('A', 'account-A', p)).rejects.toThrow('DENIED')
    await login()
    await admin.revoke('A', 'account-A', device.scope.agent_id)
    await expect(snapshot()).rejects.toThrow('DENIED')
    await login()
  })
  it('rejects an old prepared catalogue after an active method is disabled and requires preparation again', async () => {
    const memory = await seedActiveLearning()
    const prepared = await admin.prepareLearningPublication('A', 'account-A', p)
    await privileged('SELECT 1')
    await pg.sql.query(
      "UPDATE learning_memories SET state='stale' WHERE tenant_id='A' AND account_id='account-A' AND id=$1",
      [memory.memoryId]
    )
    await login()
    await expect(admin.publish('A', 'account-A', prepared.publication)).rejects.toThrow(
      'TASK_CONFLICT'
    )
    const refreshed = await admin.prepareLearningPublication('A', 'account-A', p)
    expect(refreshed.publication.memoryManifest).toEqual([])
    expect(refreshed.publication.configuration.configVersion).not.toBe(
      prepared.publication.configuration.configVersion
    )
    await admin.publish('A', 'account-A', refreshed.publication)
  })
  it('never reuses an old evaluation approval while preparing an automatic publication', async () => {
    await seedActiveLearning()
    const automatic = {
      ...p,
      configuration: { ...p.configuration, automaticEnabled: true },
      policy: { ...p.policy, mode: 'enforced' as const, evaluationApproved: true },
      evaluationApprovalId: 'unearned-old-approval'
    }
    const prepared = await admin.prepareLearningPublication('A', 'account-A', automatic)
    expect(prepared.publication.evaluationApprovalId).toBeUndefined()
    expect(prepared.summary.requiresIndependentEvaluation).toBe(true)
    await expect(admin.publish('A', 'account-A', prepared.publication)).rejects.toThrow(
      'CONFIGURATION_UNAVAILABLE'
    )
    expect(await admin.accounts('A')).toMatchObject([{ server_paused: true, config_version: null }])
  })
  it('rejects foreign tenant, knowledge evidence, generator and ordinary application authority during preparation', async () => {
    await expect(admin.prepareLearningPublication('B', 'account-A', p)).rejects.toThrow('DENIED')
    await expect(
      admin.prepareLearningPublication('A', 'account-A', {
        ...p,
        evidence: [{ ...p.evidence[0], tenantId: 'B' }]
      })
    ).rejects.toThrow('PUBLICATION_INVALID')
    await expect(
      admin.prepareLearningPublication('A', 'account-A', {
        ...p,
        textGeneratorVersion: 'different-generator'
      })
    ).rejects.toThrow('PUBLICATION_INVALID')
    await login('autoreply_app')
    await expect(admin.prepareLearningPublication('A', 'account-A', p)).rejects.toThrow('DENIED')
    await login()
  })
  it('publishes explicitly reviewed legacy rules through the existing administrator gate without enabling automatic replies', async () => {
    const root = mkdtempSync(join(tmpdir(), 'legacy-publish-'))
    const archive = new LegacySettingsArchive(join(root, 'private.sqlite'), 'workspace-A')
    try {
      const file = join(root, 'source.json')
      writeFileSync(
        file,
        JSON.stringify({ modes: [{ id: 'mode', name: '咨询', prompt: '旧规则', autoReply: true }] })
      )
      await archive.importFile(file)
      const draft = archive.list().find((d) => d.content.kind === 'mode')!
      const { prepareLegacyPublication } = await import('../../server/src/admin/legacy-publication')
      expect(() => prepareLegacyPublication(archive, draft.id, 0, p)).toThrow(
        'legacy_settings_review_required'
      )
      archive.recordReview(
        {
          sourceId: 'accept-1',
          draftId: draft.id,
          expectedContentHash: draft.contentHash,
          expectedReviewRevision: 0,
          decision: 'accept',
          reason: '核对旧配置',
          replyRules: '先询问客户型号，不承诺价格'
        },
        'reviewer-A'
      )
      const prepared = prepareLegacyPublication(archive, draft.id, 1, p)
      expect(prepared.provenance).toMatchObject({
        workspaceId: 'workspace-A',
        draftId: draft.id,
        reviewRevision: 1,
        automaticEnabled: false,
        identityVerified: false,
        publicationHash: hashContext(prepared.publication)
      })
      expect(prepared.publication.replyRules).toBe('先询问客户型号，不承诺价格')
      expect(p.replyRules).toBeUndefined()
      expect(() =>
        prepareLegacyPublication(archive, draft.id, 1, {
          ...p,
          policy: { ...p.policy, mode: 'enforced' }
        })
      ).toThrow('legacy_settings_publication_invalid')
      expect(() =>
        prepareLegacyPublication(archive, draft.id, 1, { ...p, evaluationApprovalId: 'unearned' })
      ).toThrow('legacy_settings_publication_invalid')
      const customer = archive.list().find((d) => d.content.kind === 'preferences')!
      archive.recordReview(
        {
          sourceId: 'preferences',
          draftId: customer.id,
          expectedContentHash: customer.contentHash,
          expectedReviewRevision: 0,
          decision: 'accept',
          reason: '偏好确认'
        },
        'reviewer-A'
      )
      expect(() => prepareLegacyPublication(archive, customer.id, 1, p)).toThrow(
        'legacy_settings_review_required'
      )
      await admin.publish('A', 'account-A', prepared.publication)
      expect(await admin.accounts('A')).toMatchObject([
        { server_paused: true, automatic_enabled: false }
      ])
      const stored = await pg.db.transaction('A', (db) =>
        db.query("SELECT policy_json FROM generation_publications WHERE config_version='config-1'")
      )
      expect(stored.rows[0].policy_json).toMatchObject({
        replyRules: '先询问客户型号，不承诺价格',
        mode: 'shadow',
        evaluationApproved: false
      })
      await expect(admin.publish('B', 'account-B', prepared.publication)).rejects.toThrow('DENIED')
      archive.recordReview(
        {
          sourceId: 'reopen-1',
          draftId: draft.id,
          expectedContentHash: draft.contentHash,
          expectedReviewRevision: 1,
          decision: 'reopen',
          reason: '新要求待核对'
        },
        'reviewer-A'
      )
      expect(() => prepareLegacyPublication(archive, draft.id, 1, p)).toThrow(
        'legacy_settings_review_required'
      )
      expect(() => prepareLegacyPublication(archive, draft.id, 2, p)).toThrow(
        'legacy_settings_review_required'
      )
    } finally {
      archive.close()
      removeLegacyFixture(root)
    }
  })
  it('enrolls multiple employees into their exact platform/account scope and rejects another account knowledge', async () => {
    await admin.provision('A', {
      employeeId: 'employee-B',
      accountId: 'account-B',
      platform: 'wechat'
    })
    const a = await admin.enroll('A', 'account-A'),
      b = await admin.enroll('A', 'account-B')
    const scoped = { ...p, evidence: [{ ...p.evidence[0], accountId: 'account-A' }] }
    await admin.publish('A', 'account-A', scoped)
    await expect(admin.publish('A', 'account-B', scoped)).rejects.toThrow('TASK_CONFLICT')
    expect(await admin.accounts('A')).toMatchObject([
      {
        account_id: 'account-A',
        employee_id: 'employee-A',
        platform: 'wework',
        server_paused: true,
        config_version: 'config-1'
      },
      {
        account_id: 'account-B',
        employee_id: 'employee-B',
        platform: 'wechat',
        server_paused: true,
        config_version: null
      }
    ])
    await login('autoreply_app')
    const authority = new AccountAuthority(pg.db)
    const first = await authority.register(a.enrollmentCode, 'fca55e8a-0bb4-40cc-a3c0-d4e6eb647a21')
    const second = await authority.register(
      b.enrollmentCode,
      '98633598-87c3-4bd3-9763-29211e0edce1'
    )
    expect(await authority.authenticate(first.credential)).toMatchObject({
      tenant_id: 'A',
      employee_id: 'employee-A',
      account_id: 'account-A',
      platform: 'wework'
    })
    expect(await authority.authenticate(second.credential)).toMatchObject({
      tenant_id: 'A',
      employee_id: 'employee-B',
      account_id: 'account-B',
      platform: 'wechat'
    })
  })
  it('requires both dedicated DB role and an enabled administrator binding', async () => {
    await login('autoreply_app')
    await expect(admin.accounts('A')).rejects.toThrow('DENIED')
    await login()
    await expect(admin.accounts('B')).rejects.toThrow('DENIED')
    await privileged('UPDATE admin_database_principals SET enabled=false')
    await login()
    await expect(admin.accounts('A')).rejects.toThrow('DENIED')
    await privileged(
      "UPDATE admin_database_principals SET enabled=true; UPDATE employees SET enabled=false WHERE id='admin-A'"
    )
    await login()
    await expect(admin.accounts('A')).rejects.toThrow('DENIED')
  })
  it('rejects privileged migration login even if an operator added a binding', async () => {
    await privileged(
      "INSERT INTO admin_database_principals(login_name,tenant_id,employee_id) VALUES(session_user,'A','admin-A') ON CONFLICT DO NOTHING"
    )
    await expect(admin.accounts('A')).rejects.toThrow('DENIED')
  })
  it('rejects a normal-looking administrator login that can assume a privileged role', async () => {
    await privileged('GRANT postgres TO synthetic_admin')
    await login()
    try {
      expect(
        (
          await pg.sql.query(
            'SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=session_user'
          )
        ).rows
      ).toEqual([{ rolsuper: false, rolbypassrls: false }])
      await expect(admin.accounts('A')).rejects.toThrow('DENIED')
    } finally {
      await privileged('REVOKE postgres FROM synthetic_admin')
      await login()
    }
  })
  it('enforces tenant isolation even when the admin changes the raw SQL tenant setting', async () => {
    await privileged(
      "INSERT INTO employees(tenant_id,id,role) VALUES('B','employee-B','employee'); INSERT INTO accounts(tenant_id,id,employee_id,platform) VALUES('B','account-B','employee-B','wechat')"
    )
    await login()
    await pg.sql.query("SELECT set_config('app.tenant_id','B',false)")
    expect((await pg.sql.query('SELECT id FROM accounts')).rows).toEqual([])
    await expect(
      pg.sql.query("UPDATE accounts SET paused=false WHERE tenant_id='B'")
    ).resolves.toMatchObject({ affectedRows: 0 })
    await expect(
      pg.sql.query("INSERT INTO employees(tenant_id,id,role) VALUES('B','intruder','employee')")
    ).rejects.toThrow(/row.level security/i)
  })
  it('provisions paused accounts idempotently without rebinding or elevating employees', async () => {
    await admin.provision('A', {
      employeeId: 'employee-A',
      accountId: 'account-A',
      platform: 'wework'
    })
    expect(await admin.accounts('A')).toMatchObject([
      { account_id: 'account-A', employee_id: 'employee-A', server_paused: true }
    ])
    await expect(
      admin.provision('A', {
        employeeId: 'employee-new',
        accountId: 'account-A',
        platform: 'wechat'
      })
    ).rejects.toThrow('ACCOUNT_CONFLICT')
    await expect(
      admin.provision('A', { employeeId: 'admin-A', accountId: 'new', platform: 'wechat' })
    ).rejects.toThrow('ACCOUNT_CONFLICT')
    const rows = await pg.db.transaction('A', (db) =>
      db.query("SELECT id FROM employees WHERE id='employee-new'")
    )
    expect(rows.rowCount).toBe(0)
  })
  it('creates a hashed ten-minute one-use enrollment and never puts the code into audit', async () => {
    const result = await admin.enroll('A', 'account-A')
    expect(result.enrollmentCode).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(result.validForSeconds).toBe(600)
    const saved = await pg.db.transaction('A', (db) =>
      db.query('SELECT code_hash,expires_at>clock_timestamp() AS live FROM enrollment_codes')
    )
    expect(saved.rows).toEqual([{ code_hash: tokenHash(result.enrollmentCode), live: true }])
    const audit = await pg.db.transaction('A', (db) =>
      db.query('SELECT actor_id,kind,details_json FROM audit_events')
    )
    expect(audit.rows.every((row) => row.actor_id === 'admin-A')).toBe(true)
    expect(JSON.stringify(audit.rows)).not.toContain(result.enrollmentCode)
    await login('autoreply_app')
    const authority = new AccountAuthority(pg.db)
    const registered = await authority.register(
      result.enrollmentCode,
      'fca55e8a-0bb4-40cc-a3c0-d4e6eb647a21'
    )
    expect(registered.scope.account_id).toBe('account-A')
    await expect(
      authority.register(result.enrollmentCode, '98633598-87c3-4bd3-9763-29211e0edce1')
    ).rejects.toThrow('DENIED')
  })
  it('publishes immutable full contents atomically, stays paused and checks generator/scope', async () => {
    await admin.publish('A', 'account-A', p)
    await admin.publish('A', 'account-A', p)
    expect(await admin.accounts('A')).toMatchObject([
      { server_paused: true, config_version: 'config-1', automatic_enabled: false }
    ])
    await expect(
      admin.publish('A', 'account-A', { ...p, textGeneratorVersion: 'changed' })
    ).rejects.toThrow('PUBLICATION_INVALID')
    await expect(
      admin.publish('A', 'account-A', { ...p, evidence: [{ ...p.evidence[0], tenantId: 'B' }] })
    ).rejects.toThrow('TASK_CONFLICT')
    await expect(
      admin.publish('A', 'account-A', {
        ...p,
        evidence: [{ ...p.evidence[0], content: 'changed' }]
      })
    ).rejects.toThrow('TASK_CONFLICT')
    await privileged(`CREATE FUNCTION autoreply.fail_admin_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.kind='configuration_published' THEN RAISE EXCEPTION 'synthetic_disk_failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_publication_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION autoreply.fail_admin_audit()`)
    await login()
    const next = { ...p, configuration: { ...p.configuration, configVersion: 'config-2' } }
    try {
      await expect(admin.publish('A', 'account-A', next)).rejects.toThrow('synthetic_disk_failure')
    } finally {
      await privileged(
        'DROP TRIGGER reject_publication_audit ON audit_events; DROP FUNCTION autoreply.fail_admin_audit()'
      )
      await login()
    }
    expect(await admin.accounts('A')).toMatchObject([{ config_version: 'config-1' }])
    expect(
      (
        await pg.db.transaction('A', (db) =>
          db.query("SELECT 1 FROM generation_publications WHERE config_version='config-2'")
        )
      ).rowCount
    ).toBe(0)
  })
  it('does not resume without a valid publication or with unresolved execution records', async () => {
    await expect(admin.resume('A', 'account-A')).rejects.toThrow('CONFIGURATION_UNAVAILABLE')
    await admin.publish('A', 'account-A', p)
    await admin.resume('A', 'account-A')
    expect(await admin.accounts('A')).toMatchObject([{ server_paused: false }])
    await admin.pause('A', 'account-A')
    await privileged(`INSERT INTO agents(tenant_id,id,account_id,employee_id,token_hash) VALUES('A','agent-A','account-A','employee-A','synthetic-hash');
      INSERT INTO execution_permits(tenant_id,account_id,id,agent_id,lease_version,task_id,draft_hash,status)
      VALUES('A','account-A','unknown-permit','agent-A',1,'unknown-task','hash','unknown')`)
    await login()
    await expect(admin.resume('A', 'account-A')).rejects.toThrow('UNRESOLVED_EXECUTION')
    expect(await admin.unresolved('A', 'account-A')).toMatchObject([
      { permit_id: 'unknown-permit', status: 'unknown' }
    ])
    await expect(
      pg.db.transaction('A', (db) => db.query("UPDATE execution_permits SET status='not_sent'"))
    ).rejects.toThrow(/permission denied/i)
  })
  it('revokes only the scoped device, pauses the account and preserves unknown permits and lease versions', async () => {
    const token = 'A'.repeat(43)
    await privileged(`INSERT INTO agents(tenant_id,id,account_id,employee_id,token_hash) VALUES('A','agent-A','account-A','employee-A','${tokenHash(token)}');
      INSERT INTO account_leases(tenant_id,account_id,agent_id,login_epoch,client_instance_id,version,expires_at)
      VALUES('A','account-A','agent-A',1,'client-A',7,clock_timestamp()+interval '10 seconds');
      INSERT INTO execution_permits(tenant_id,account_id,id,agent_id,lease_version,task_id,draft_hash,status)
      VALUES('A','account-A','unknown-permit','agent-A',7,'unknown-task','hash','unknown')`)
    await login()
    await expect(admin.revoke('A', 'account-A', 'other')).rejects.toThrow('AGENT_NOT_FOUND')
    await admin.revoke('A', 'account-A', 'agent-A')
    await admin.revoke('A', 'account-A', 'agent-A')
    expect(await admin.accounts('A')).toMatchObject([
      { server_paused: true, unresolved_count: 1, lease_version: 7, lease_live: false }
    ])
    expect(await admin.unresolved('A', 'account-A')).toMatchObject([{ status: 'unknown' }])
    await login('autoreply_app')
    await expect(new AccountAuthority(pg.db).authenticate(token)).rejects.toThrow('DENIED')
  })
})
