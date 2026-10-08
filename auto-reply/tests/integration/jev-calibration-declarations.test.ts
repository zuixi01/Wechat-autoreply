import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { embeddedPostgres } from '../fixtures/embedded-postgres'
import { evaluationPlan } from '../fixtures/evaluation-data'
import { Administration } from '../../server/src/admin/administration'
import { PublicationSchema } from '../../server/src/generation/publication'
import { JevCalibrationDeclarations } from '../../server/src/generation/jev-calibration-declarations'
import { JevReplayJournal } from '../../server/src/generation/jev-replay-journal'
import { replayCaseInputHash } from '../../evals/jev/replay-input'
import { hashContext } from '../../src/core/reply/hashes'

let pg: Awaited<ReturnType<typeof embeddedPostgres>>
let publication: ReturnType<typeof PublicationSchema.parse>
let declarations: JevCalibrationDeclarations, admin: Administration, runId: string
let network: ReturnType<typeof vi.spyOn>
const plan = evaluationPlan()
const cases = plan.assignments.map((a, i) => ({
  ...a,
  conversationId: `synthetic-peer-${i}`,
  inbound: ['请转人工客服']
}))
plan.replayProtocol = 'jev-abc-v1'
plan.assignments = plan.assignments.map((a, i) => ({
  ...a,
  inputHash: replayCaseInputHash(cases[i])
}))
const settings = () => ({
  candidates: [publication.policy],
  targets: {
    maximumErrorReleaseRate: 0.01,
    minimumAutomaticCoverage: 0.5,
    minimumAutomaticReplies: 30
  }
})
const request = () => ({ tenantId: 'A', accountId: 'account-A', runId, settings: settings() })
async function login(name = 'calibration_admin') {
  await pg.sql.exec(
    `SET SESSION AUTHORIZATION postgres; RESET ROLE; SET SESSION AUTHORIZATION ${name}`
  )
}
async function privileged(sql: string) {
  await pg.sql.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE')
  await pg.sql.exec(sql)
  await login()
}
async function begin() {
  return new JevReplayJournal(pg.db, publication.textGeneratorVersion).begin({
    tenantId: 'A',
    accountId: 'account-A',
    runId,
    fullRawCases: { datasetId: plan.datasetId, split: 'holdout', cases: cases.slice(100) },
    maxRunAttempts: 10
  })
}
async function rows() {
  return (
    await pg.db.transaction('A', (db) => db.query('SELECT * FROM jev_calibration_declarations'))
  ).rows
}
beforeAll(async () => {
  pg = await embeddedPostgres()
  for (const name of [
    '045-jev-replay-journal.sql',
    '046-jev-replay-artifact-seals.sql',
    '047-jev-blind-packet-seals.sql',
    '048-jev-blind-label-reviews.sql',
    '049-jev-calibration-declarations.sql'
  ]) {
    const sql = await readFile(`server/migrations/${name}`, 'utf8')
    await pg.sql.exec(sql)
    await pg.sql.exec(sql)
  }
  await pg.sql
    .exec(`CREATE ROLE calibration_admin LOGIN NOSUPERUSER NOBYPASSRLS; GRANT autoreply_admin TO calibration_admin;
    CREATE ROLE calibration_other LOGIN NOSUPERUSER NOBYPASSRLS; GRANT autoreply_admin TO calibration_other;
    CREATE ROLE calibration_mixed LOGIN NOSUPERUSER NOBYPASSRLS; GRANT autoreply_admin,autoreply_app TO calibration_mixed;
    INSERT INTO tenants(id,name) VALUES('A','Synthetic A'),('B','Synthetic B');
    INSERT INTO employees(tenant_id,id,role) VALUES('A','admin-A','admin'),('A','other-A','admin'),('A','employee-A','employee');
    INSERT INTO admin_database_principals(login_name,tenant_id,employee_id) VALUES('calibration_admin','A','admin-A'),('calibration_other','A','other-A'),('calibration_mixed','A','admin-A');`)
  await login()
  publication = PublicationSchema.parse(
    JSON.parse(await readFile('server/admin/publication.example.json', 'utf8'))
  )
  publication.configuration.automaticEnabled = true
  publication.policy.mode = 'enforced'
  publication.policy.evaluationApproved = true
  admin = new Administration(pg.db, publication.textGeneratorVersion)
  await admin.provision('A', {
    accountId: 'account-A',
    employeeId: 'employee-A',
    platform: 'wechat'
  })
  declarations = new JevCalibrationDeclarations(pg.db, publication.textGeneratorVersion)
}, 20000)
beforeEach(async () => {
  network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected_http'))
  await privileged(
    `TRUNCATE evaluation_runs CASCADE; UPDATE accounts SET enabled=true,paused=true,platform='wechat'; UPDATE employees SET enabled=true;`
  )
  runId = (await admin.freezeEvaluation('A', 'account-A', { publication, plan })).runId
})
afterEach(() => {
  expect(network).not.toHaveBeenCalled()
  network.mockRestore()
})
afterAll(async () => {
  await pg.db.close()
})

describe('central calibration candidate predeclaration', () => {
  it('stores original scope and database-hashed canonical settings with no execution or approval', async () => {
    const receipt = await declarations.declare(request())
    expect(receipt).toMatchObject({
      runId,
      settingsHash: hashContext(settings()),
      candidatePredeclarationVerified: true,
      releaseAuthorized: false
    })
    const stored = await rows()
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({
      login_name: 'calibration_admin',
      actor_id: 'admin-A',
      employee_id: 'employee-A',
      platform: 'wechat',
      settings_json: settings(),
      settings_hash: receipt.settingsHash
    })
    expect(Date.parse(receipt.declaredAt)).toBeGreaterThan(0)
    const counts = (
      await pg.db.transaction('A', (db) =>
        db.query(`SELECT
      (SELECT count(*)::int FROM jev_replay_executions) AS executions,
      (SELECT count(*)::int FROM evaluation_approvals) AS approvals,
      (SELECT count(*)::int FROM execution_permits) AS permits`)
      )
    ).rows[0]
    expect(counts).toEqual({ executions: 0, approvals: 0, permits: 0 })
  })
  it('recovers the same declaration after a full holdout execution has begun', async () => {
    const first = await declarations.declare(request())
    expect((await begin()).input.cases).toHaveLength(200)
    expect(await declarations.declare(request())).toEqual(first)
    expect(await declarations.verify(request())).toEqual(first)
    expect(await rows()).toHaveLength(1)
  })
  it('refuses retroactive registration even when only holdout has started', async () => {
    await begin()
    await expect(declarations.declare(request())).rejects.toThrow(
      'jev_calibration_declaration_too_late'
    )
    expect(await rows()).toHaveLength(0)
  })
  it('does not create missing declarations during verification', async () => {
    await expect(declarations.verify(request())).rejects.toThrow(
      'jev_calibration_declaration_missing'
    )
    expect(await rows()).toHaveLength(0)
  })
  it.each(['threshold', 'target'])('refuses changing the registered %s', async (kind) => {
    const original = await declarations.declare(request())
    const changed = structuredClone(request())
    if (kind === 'threshold') changed.settings.candidates[0].minimumChoiceProbability -= 0.01
    else changed.settings.targets.maximumErrorReleaseRate += 0.01
    await expect(declarations.declare(changed)).rejects.toThrow(
      'jev_calibration_declaration_changed'
    )
    await expect(declarations.verify(changed)).rejects.toThrow(
      'jev_calibration_declaration_changed'
    )
    expect(await declarations.verify(request())).toEqual(original)
  })
  it('rejects fixed policy changes and invalid threshold bounds in the SQL boundary', async () => {
    const invalid = [
      { ...settings(), candidates: [{ ...publication.policy, automaticIntents: ['price'] }] },
      { ...settings(), candidates: [{ ...publication.policy, minimumChoiceProbability: 1.01 }] },
      { ...settings(), candidates: [{ ...publication.policy, presentIntentProbability: 0.5 }] },
      { ...settings(), targets: { ...settings().targets, minimumAutomaticReplies: 30.5 } }
    ]
    for (const value of invalid)
      await expect(
        pg.db.transaction('A', (db) =>
          db.query('SELECT * FROM autoreply.jev_calibration_declaration($1,$2,$3,$4,true)', [
            'A',
            'account-A',
            runId,
            JSON.stringify(value)
          ])
        )
      ).rejects.toThrow('jev_calibration_settings_invalid')
    expect(await rows()).toHaveLength(0)
  })
  it('binds actor and login and rejects mapped mixed-role administrators', async () => {
    await declarations.declare(request())
    await login('calibration_other')
    await expect(declarations.verify(request())).rejects.toThrow(
      'jev_calibration_declaration_context_invalid'
    )
    await login('calibration_mixed')
    await expect(declarations.verify(request())).rejects.toThrow(
      'jev_calibration_declaration_denied'
    )
    await login()
    await expect(declarations.verify({ ...request(), tenantId: 'B' })).rejects.toThrow()
  })
  it('blocks account identity drift and expired original freezes', async () => {
    await declarations.declare(request())
    await privileged("UPDATE accounts SET platform='wework' WHERE id='account-A'")
    await expect(declarations.verify(request())).rejects.toThrow(
      'jev_calibration_declaration_changed'
    )
    await privileged(
      "UPDATE accounts SET platform='wechat'; ALTER TABLE evaluation_runs DISABLE TRIGGER ALL; UPDATE evaluation_runs SET expires_at=clock_timestamp()-interval '1 second'; ALTER TABLE evaluation_runs ENABLE TRIGGER ALL;"
    )
    await expect(declarations.verify(request())).rejects.toThrow('EVALUATION_NOT_FOUND')
  })
  it('denies direct administrator mutation even with the correct tenant GUC', async () => {
    await declarations.declare(request())
    await expect(
      pg.db.transaction('A', (db) =>
        db.query('UPDATE jev_calibration_declarations SET settings_hash=$1', ['f'.repeat(64)])
      )
    ).rejects.toThrow('permission denied')
    await expect(
      pg.db.transaction('A', (db) => db.query('DELETE FROM jev_calibration_declarations'))
    ).rejects.toThrow('permission denied')
    expect(await rows()).toHaveLength(1)
  })
})
