import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { embeddedPostgres } from '../fixtures/embedded-postgres'
import { evaluationPlan } from '../fixtures/evaluation-data'
import { JevReplayJournal } from '../../server/src/generation/jev-replay-journal'
import { PublicationSchema } from '../../server/src/generation/publication'
import { evaluationSnapshotHash } from '../../server/src/generation/evaluation-authorization'
import { replayCaseInputHash } from '../../evals/jev/replay-input'
import { hashContext } from '../../src/core/reply/hashes'
import { preQuestions } from '../../server/src/reply/jev-pipeline'
import type { ReplayCallBinding } from '../../evals/jev/replay-providers'

let pg: Awaited<ReturnType<typeof embeddedPostgres>>, journal: JevReplayJournal
let publication: ReturnType<typeof PublicationSchema.parse>
const plan = evaluationPlan()
const cases = plan.assignments.map((a, i) => ({
  ...a,
  conversationId: `synthetic-peer-${i}`,
  inbound: ['合成业务咨询']
}))
plan.replayProtocol = 'jev-abc-v1'
plan.assignments = plan.assignments.map((a, i) => ({
  ...a,
  inputHash: replayCaseInputHash(cases[i])
}))
const input = { datasetId: plan.datasetId, split: 'holdout', cases: cases.slice(100) }
const start = {
  provider: 'text' as const,
  requestHash: 'a'.repeat(64),
  requestedModel: 'synthetic-text'
}
const response = { outcome: 'response' as const, durationMs: 12, actualModel: 'synthetic-text' }
async function privileged(text: string) {
  await pg.sql.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE')
  await pg.sql.exec(text)
}
async function login(name = 'synthetic_jev_admin') {
  await pg.sql.exec(
    `SET SESSION AUTHORIZATION postgres; RESET ROLE; SET SESSION AUTHORIZATION ${name}`
  )
}
async function freeze(runId = 'run-A') {
  await privileged(`INSERT INTO evaluation_runs(tenant_id,account_id,id,snapshot_hash,publication_json,plan_json,created_by)
    VALUES('A','account-A','${runId}','${evaluationSnapshotHash(publication)}','${JSON.stringify(publication).replaceAll("'", "''")}'::jsonb,'${JSON.stringify(plan)}'::jsonb,'admin-A')`)
  await login()
}
async function begin(runId = 'run-A', maxRunAttempts = 20) {
  return journal.begin({
    tenantId: 'A',
    accountId: 'account-A',
    runId,
    fullRawCases: input,
    maxRunAttempts
  })
}
async function binding(
  arm: 'A' | 'B' | 'C' = 'A',
  caseId = 'case-100'
): Promise<ReplayCallBinding> {
  await begin()
  return journal.bindAssignment({ runId: 'run-A', caseId, arm, assignmentId: randomUUID() })
}
beforeAll(async () => {
  pg = await embeddedPostgres()
  const migration = await readFile('server/migrations/045-jev-replay-journal.sql', 'utf8')
  await pg.sql.exec(migration)
  await pg.sql.exec(migration)
  publication = PublicationSchema.parse(
    JSON.parse(await readFile('server/admin/publication.example.json', 'utf8'))
  )
  await privileged(`CREATE ROLE synthetic_jev_admin LOGIN NOSUPERUSER NOBYPASSRLS; GRANT autoreply_admin TO synthetic_jev_admin;
    CREATE ROLE synthetic_jev_device LOGIN NOSUPERUSER NOBYPASSRLS; GRANT autoreply_app TO synthetic_jev_device;
    INSERT INTO tenants(id,name) VALUES('A','synthetic A'),('B','synthetic B');
    INSERT INTO employees(tenant_id,id,role) VALUES('A','admin-A','admin'),('A','employee-A','employee'),('B','admin-B','admin');
    INSERT INTO accounts(tenant_id,id,employee_id,platform) VALUES('A','account-A','employee-A','wechat');
    INSERT INTO admin_database_principals(login_name,tenant_id,employee_id) VALUES('synthetic_jev_admin','A','admin-A');`)
}, 20000)
beforeEach(async () => {
  await privileged(`TRUNCATE jev_replay_results,jev_replay_attempts,jev_replay_assignments,jev_replay_executions,jev_replay_limits,evaluation_runs CASCADE;
    UPDATE accounts SET enabled=true,paused=true; UPDATE employees SET enabled=true;`)
  journal = new JevReplayJournal(pg.db, publication.textGeneratorVersion)
  await freeze()
})
afterAll(async () => {
  await pg.db.close()
})

describe('independent administrator Jev replay journal', () => {
  it('requires an explicitly configured finite limit without enabling production or learning', async () => {
    const b = await binding()
    await expect(journal.reserve(b, 'text', start)).rejects.toThrow('LIMIT_UNCONFIGURED')
    for (const dailyAttemptLimit of [-1, Infinity, 100001, 0.5])
      await expect(journal.setLimit('A', 'account-A', { dailyAttemptLimit })).rejects.toThrow()
    await journal.setLimit('A', 'account-A', { dailyAttemptLimit: 0 })
    await expect(journal.reserve(b, 'text', start)).rejects.toThrow('LIMIT_REACHED')
    const a = await pg.db.transaction('A', (db) =>
      db.query('SELECT paused FROM accounts WHERE id=$1', ['account-A'])
    )
    expect(a.rows[0].paused).toBe(true)
  })
  it('authenticates actual database logins for begin, limit changes and reads; GUCs do not confer authority', async () => {
    const b = await binding()
    await login('synthetic_jev_device')
    await pg.sql.exec("SELECT set_config('app.tenant_id','A',false)")
    await expect(begin()).rejects.toThrow()
    await expect(journal.setLimit('A', 'account-A', { dailyAttemptLimit: 10 })).rejects.toThrow()
    await expect(journal.readAttempts(b)).rejects.toThrow()
    await expect(
      pg.db.transaction('A', (db) =>
        db.query("INSERT INTO jev_replay_limits VALUES('A','account-A',100,1)")
      )
    ).rejects.toThrow()
    await login()
    await expect(journal.setLimit('B', 'account-A', { dailyAttemptLimit: 10 })).rejects.toThrow()
  })
  it('rejects a previously authenticated journal and receipt after its admin mapping is revoked', async () => {
    await journal.setLimit('A', 'account-A', { dailyAttemptLimit: 10 })
    const b = await binding()
    const handle = await journal.reserve(b, 'text', start)
    await privileged(
      "UPDATE admin_database_principals SET enabled=false WHERE login_name='synthetic_jev_admin'"
    )
    await login()
    try {
      await expect(journal.readAttempts(b)).rejects.toThrow('CONTEXT_UNAVAILABLE')
      await expect(journal.reserve(b, 'text', start)).rejects.toThrow('CONTEXT_UNAVAILABLE')
      await expect(handle.finish(response)).rejects.toThrow('CONTEXT_UNAVAILABLE')
    } finally {
      await privileged(
        "UPDATE admin_database_principals SET enabled=true WHERE login_name='synthetic_jev_admin'"
      )
      await login()
    }
    expect((await journal.readAttempts(b))[0].result).toBeNull()
    await handle.finish(response)
    expect((await journal.readAttempts(b))[0].result).toMatchObject(response)
    expect(await journal.readLimit('A', 'account-A')).toMatchObject({ usedAttempts: 1 })
  })
  it('requires the complete exact frozen split and rejects source files, duplicates and changed content', async () => {
    for (const fullRawCases of [
      'input.json',
      { ...input, cases: input.cases.slice(1) },
      { ...input, cases: [input.cases[0], ...input.cases.slice(0, -1)] },
      { ...input, cases: input.cases.map((c, i) => (i ? c : { ...c, inbound: ['替换内容'] })) }
    ])
      await expect(
        journal.begin({
          tenantId: 'A',
          accountId: 'account-A',
          runId: 'run-A',
          fullRawCases,
          maxRunAttempts: 20
        })
      ).rejects.toThrow()
    expect((await begin()).input.cases).toHaveLength(200)
  })
  it('preserves one execution and assignment per run/split/case/arm instead of starting paid work again', async () => {
    const first = await begin()
    const other = new JevReplayJournal(pg.db, publication.textGeneratorVersion)
    expect(
      (
        await other.begin({
          tenantId: 'A',
          accountId: 'account-A',
          runId: 'run-A',
          fullRawCases: input,
          maxRunAttempts: 20
        })
      ).executionId
    ).toBe(first.executionId)
    const assignment = {
      runId: 'run-A',
      caseId: 'case-100',
      arm: 'A' as const,
      assignmentId: randomUUID()
    }
    expect(await journal.bindAssignment(assignment)).toEqual(await other.bindAssignment(assignment))
    await expect(
      journal.bindAssignment({ ...assignment, assignmentId: randomUUID() })
    ).rejects.toThrow()
    await expect(
      journal.begin({
        tenantId: 'A',
        accountId: 'account-A',
        runId: 'run-A',
        fullRawCases: input,
        maxRunAttempts: 21
      })
    ).rejects.toThrow()
  })
  it('rejects a second bound run before committing any new execution row', async () => {
    const first = await begin()
    await freeze('run-B')
    await expect(begin('run-B')).rejects.toThrow()
    const rows = await pg.db.transaction('A', (db) =>
      db.query('SELECT id FROM jev_replay_executions')
    )
    expect(rows.rows).toEqual([{ id: first.executionId }])
  })
  it('checks actual stored input/plan/publication/questions even when the claimed hash columns are retained', async () => {
    const b = await binding()
    const original = (
      await pg.db.transaction('A', (db) => db.query('SELECT * FROM jev_replay_executions'))
    ).rows[0]
    const changes: Record<string, unknown>[] = [
      {
        input_json: {
          ...input,
          cases: input.cases.map((c, i) => (i ? c : { ...c, inbound: ['篡改模型原文'] }))
        }
      },
      { plan_json: { ...plan, datasetId: 'different-dataset' } },
      { plan_json: { ...plan, unexpected: 'must-not-reuse-prior-validation' } },
      { publication_json: { ...publication, textGeneratorVersion: 'changed-generator' } },
      { pre_question_hash: 'b'.repeat(64) },
      { post_question_hash: 'b'.repeat(64) }
    ]
    for (const change of changes) {
      const column = Object.keys(change)[0]
      await privileged('ALTER TABLE jev_replay_executions DISABLE TRIGGER jev_replay_immutable')
      await pg.sql.query(`UPDATE jev_replay_executions SET ${column}=$1`, [
        column.endsWith('_json') ? JSON.stringify(change[column]) : change[column]
      ])
      await login()
      await expect(journal.readAttempts(b)).rejects.toThrow()
      await expect(
        new JevReplayJournal(pg.db, publication.textGeneratorVersion).begin({
          tenantId: 'A',
          accountId: 'account-A',
          runId: 'run-A',
          fullRawCases: input,
          maxRunAttempts: 20
        })
      ).rejects.toThrow()
      await privileged('ALTER TABLE jev_replay_executions ENABLE TRIGGER jev_replay_immutable')
      await privileged('ALTER TABLE jev_replay_executions DISABLE TRIGGER jev_replay_immutable')
      await pg.sql.query(`UPDATE jev_replay_executions SET ${column}=$1`, [
        column.endsWith('_json') ? JSON.stringify(original[column]) : original[column]
      ])
      await privileged('ALTER TABLE jev_replay_executions ENABLE TRIGGER jev_replay_immutable')
      await login()
    }
    expect(await journal.readAttempts(b)).toEqual([])
  })
  it('commits reservations first and retains pending usage as unknown after a fresh process restart', async () => {
    await journal.setLimit('A', 'account-A', { dailyAttemptLimit: 10 })
    const b = await binding()
    await journal.reserve(b, 'text', start)
    const other = new JevReplayJournal(pg.db, publication.textGeneratorVersion)
    for (const changed of [
      { employeeId: 'other-employee' },
      { platform: 'wework' as const },
      { snapshotHash: 'b'.repeat(64) },
      { executionPlanHash: 'b'.repeat(64) },
      { inputHash: 'b'.repeat(64) }
    ]) {
      await expect(other.readAttempts({ ...b, ...changed })).rejects.toThrow()
      await expect(other.reserve({ ...b, ...changed }, 'text', start)).rejects.toThrow()
    }
    expect(await other.readAttempts(b)).toEqual([
      expect.objectContaining({ stage: 'text', start, result: null })
    ])
    await expect(other.reserve(b, 'text', start)).rejects.toThrow()
    await expect(
      other.reserve({ ...b, arm: 'C' }, 'pre', { ...start, provider: 'jev' })
    ).rejects.toThrow()
  })
  it('records each retry, keeps response without usage unknown, and closes successful stages', async () => {
    await journal.setLimit('A', 'account-A', { dailyAttemptLimit: 10 })
    const b = await binding('B')
    const pre = {
      provider: 'jev' as const,
      requestHash: start.requestHash,
      requestedModel: publication.policy.modelAlias,
      questionHash: hashContext(preQuestions())
    }
    const first = await journal.reserve(b, 'pre', pre)
    await first.finish({ outcome: 'error', durationMs: 1, failureCode: 'UNAVAILABLE' })
    const second = await journal.reserve(b, 'pre', pre)
    await second.finish(response)
    const records = await journal.readAttempts(b)
    expect(records).toHaveLength(2)
    expect(records[1].result).toEqual(response)
    expect(records[1].result).not.toHaveProperty('usage')
    await expect(journal.reserve(b, 'pre', pre)).rejects.toThrow()
    const exhausted = await binding('B', 'case-101')
    await (await journal.reserve(exhausted, 'pre', pre)).finish({ outcome: 'error', durationMs: 1 })
    await (await journal.reserve(exhausted, 'pre', pre)).finish({ outcome: 'error', durationMs: 1 })
    await expect(journal.reserve(exhausted, 'pre', pre)).rejects.toThrow()
    const text = await binding('A', 'case-102')
    await (await journal.reserve(text, 'text', start)).finish({ outcome: 'error', durationMs: 1 })
    await expect(journal.reserve(text, 'text', start)).rejects.toThrow()
  })
  it('shares the UTC daily count across runs, and changing limits never clears spent attempts', async () => {
    expect(await journal.readLimit('A', 'account-A')).toBeNull()
    await journal.setLimit('A', 'account-A', { dailyAttemptLimit: 1 })
    await (await journal.reserve(await binding(), 'text', start)).finish(response)
    await freeze('run-B')
    journal = new JevReplayJournal(pg.db, publication.textGeneratorVersion)
    await begin('run-B')
    const b = await journal.bindAssignment({
      runId: 'run-B',
      caseId: 'case-100',
      arm: 'A',
      assignmentId: randomUUID()
    })
    await expect(journal.reserve(b, 'text', start)).rejects.toThrow('LIMIT_REACHED')
    await journal.setLimit('A', 'account-A', { dailyAttemptLimit: 2 })
    await journal.reserve(b, 'text', start)
    const rows = await pg.db.transaction('A', (db) =>
      db.query(
        "SELECT count(*)::int AS n,bool_and(usage_day=(clock_timestamp() AT TIME ZONE 'UTC')::date) AS utc FROM jev_replay_attempts"
      )
    )
    expect(rows.rows[0]).toEqual({ n: 2, utc: true })
    expect(await journal.readLimit('A', 'account-A')).toEqual({
      dailyAttemptLimit: 2,
      usedAttempts: 2,
      remainingAttempts: 0
    })
  })
  it('enforces run ceilings independently from account daily limits', async () => {
    await journal.setLimit('A', 'account-A', { dailyAttemptLimit: 10 })
    await begin('run-A', 1)
    const a = await journal.bindAssignment({
      runId: 'run-A',
      caseId: 'case-100',
      arm: 'A',
      assignmentId: randomUUID()
    })
    const b = await journal.bindAssignment({
      runId: 'run-A',
      caseId: 'case-101',
      arm: 'A',
      assignmentId: randomUUID()
    })
    await (await journal.reserve(a, 'text', start)).finish(response)
    await expect(journal.reserve(b, 'text', start)).rejects.toThrow('LIMIT_REACHED')
  })
  it('validates ABC stages, pre/text order, model/question binding and changed retry hashes', async () => {
    await journal.setLimit('A', 'account-A', { dailyAttemptLimit: 10 })
    const b = await binding('B')
    await expect(journal.reserve(b, 'text', start)).rejects.toThrow()
    await expect(journal.reserve(b, 'post', { ...start, provider: 'jev' })).rejects.toThrow()
    const pre = {
      ...start,
      provider: 'jev' as const,
      requestedModel: publication.policy.modelAlias,
      questionHash: hashContext(preQuestions())
    }
    await expect(
      journal.reserve(b, 'pre', { ...pre, questionHash: 'b'.repeat(64) })
    ).rejects.toThrow()
    await (await journal.reserve(b, 'pre', pre)).finish({ outcome: 'error', durationMs: 1 })
    await expect(
      journal.reserve(b, 'pre', { ...pre, requestHash: 'b'.repeat(64) })
    ).rejects.toThrow()
    await (
      await journal.reserve(b, 'pre', pre)
    ).finish({ ...response, actualModel: publication.policy.modelAlias })
    await journal.reserve(b, 'text', start)
  })
  it('makes finish exact-idempotent and results immutable, including known usage', async () => {
    await journal.setLimit('A', 'account-A', { dailyAttemptLimit: 10 })
    const b = await binding(),
      handle = await journal.reserve(b, 'text', start)
    const result = { ...response, usage: { inputTokens: 3, outputTokens: 4 } }
    await handle.finish(result)
    await handle.finish(structuredClone(result))
    await expect(handle.finish({ ...result, durationMs: 13 })).rejects.toThrow()
    expect((await journal.readAttempts(b))[0].result).toEqual(result)
    await expect(
      pg.db.transaction('A', (db) =>
        db.query('UPDATE jev_replay_results SET result_json=$1::jsonb', [JSON.stringify(response)])
      )
    ).rejects.toThrow()
    await expect(
      pg.db.transaction('A', (db) => db.query('DELETE FROM jev_replay_attempts'))
    ).rejects.toThrow()
  })
  it('allows finishing reserved calls after disable/expiry while refusing any new reservation', async () => {
    await journal.setLimit('A', 'account-A', { dailyAttemptLimit: 10 })
    const b = await binding(),
      handle = await journal.reserve(b, 'text', start)
    await privileged(
      "UPDATE accounts SET enabled=false;UPDATE evaluation_runs SET expires_at=clock_timestamp()-interval '1 second'"
    )
    await login()
    await handle.finish(response)
    expect((await journal.readAttempts(b))[0].result).toEqual(response)
    await expect(journal.reserve(b, 'text', start)).rejects.toThrow()
    await privileged('UPDATE accounts SET enabled=true')
    await login()
    await expect(journal.reserve(b, 'text', start)).rejects.toThrow()
    await expect(begin()).rejects.toThrow()
  })
  it('rejects new pause heads even when production was already paused at evaluation start', async () => {
    await journal.setLimit('A', 'account-A', { dailyAttemptLimit: 10 })
    const b = await binding(),
      handle = await journal.reserve(b, 'text', start)
    const id = randomUUID()
    await privileged(`INSERT INTO account_pause_requests(tenant_id,account_id,id,actor_id) VALUES('A','account-A','${id}','admin-A');
      INSERT INTO account_pause_heads VALUES('A','account-A','${id}')`)
    await login()
    await handle.finish({ outcome: 'error', durationMs: 1 })
    await expect(journal.reserve(b, 'text', start)).rejects.toThrow()
  })
  it('applies SQL insert guards to raw admin requests without allowing forged usage dates or stage bypass', async () => {
    await journal.setLimit('A', 'account-A', { dailyAttemptLimit: 1 })
    const b = await binding()
    const other = await binding('A', 'case-101')
    const insert = (stage: string, rawStart: unknown, assignmentId = b.assignmentId) =>
      pg.db.transaction('A', (db) =>
        db.query(
          `INSERT INTO jev_replay_attempts(tenant_id,account_id,id,assignment_id,stage,start_json,usage_day,attempt_number)
      VALUES('A','account-A',$1,$2,$3,$4::jsonb,'1900-01-01',999)`,
          [randomUUID(), assignmentId, stage, JSON.stringify(rawStart)]
        )
      )
    await expect(insert('pre', { ...start, provider: 'jev' })).rejects.toThrow('stage_invalid')
    await insert('text', start)
    const row = await pg.db.transaction('A', (db) =>
      db.query(
        "SELECT attempt_number,usage_day=(clock_timestamp() AT TIME ZONE 'UTC')::date AS utc FROM jev_replay_attempts"
      )
    )
    expect(row.rows[0]).toEqual({ attempt_number: 1, utc: true })
    await expect(insert('text', start)).rejects.toThrow('unfinished')
    await expect(insert('text', start, other.assignmentId)).rejects.toThrow('limit_reached')
    await privileged('UPDATE accounts SET enabled=false')
    await login()
    await expect(insert('text', start, other.assignmentId)).rejects.toThrow('account_invalid')
  })
})
