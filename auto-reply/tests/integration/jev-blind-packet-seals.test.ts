import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { embeddedPostgres } from '../fixtures/embedded-postgres'
import { evaluationPlan } from '../fixtures/evaluation-data'
import { PublicationSchema } from '../../server/src/generation/publication'
import { Administration } from '../../server/src/admin/administration'
import { JevReplayJournal } from '../../server/src/generation/jev-replay-journal'
import { JevBlindPacketSeals } from '../../server/src/generation/jev-blind-packet-seals'
import { createJevBlindReview, type PrivateBlindReviewPacket } from '../../evals/jev/blind-review'
import { replayCaseInputHash } from '../../evals/jev/replay-input'
import { evaluationSnapshotHash } from '../../server/src/generation/evaluation-authorization'
import { hashContext } from '../../src/core/reply/hashes'
import {
  JEV_BASELINE_ROUTE,
  JEV_REPLAY_PROTOCOL,
  type JevReplayArmArtifact
} from '../../evals/jev/replay'

let pg: Awaited<ReturnType<typeof embeddedPostgres>>, seals: JevBlindPacketSeals
let packet: PrivateBlindReviewPacket, artifacts: JevReplayArmArtifact[]
let existingSeal: Awaited<ReturnType<JevBlindPacketSeals['seal']>> | undefined
const sealedStateTests = new Set([
  'seals the complete packet idempotently with DB time',
  'verifies a complete sealed packet using a fresh instance without publishing',
  'keeps existing packet seals immutable for ordinary administrators and privileged deletion'
])
const request = () => ({ tenantId: 'A', accountId: 'account-A', runId: 'run-A', packet, artifacts })
async function privileged(sql: string) {
  await pg.sql.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE')
  await pg.sql.exec(sql)
}
async function login(name = 'synthetic_packet_admin') {
  await pg.sql.exec(
    `SET SESSION AUTHORIZATION postgres; RESET ROLE; SET SESSION AUTHORIZATION ${name}`
  )
}
function rehash(p: PrivateBlindReviewPacket) {
  const { packetHash: _hash, ...body } = p
  expect(_hash).toMatch(/^[a-f0-9]{64}$/)
  return { ...body, packetHash: hashContext(body) }
}

beforeAll(async () => {
  pg = await embeddedPostgres()
  for (const name of [
    '045-jev-replay-journal.sql',
    '046-jev-replay-artifact-seals.sql',
    '047-jev-blind-packet-seals.sql'
  ]) {
    const migration = await readFile(`server/migrations/${name}`, 'utf8')
    await pg.sql.exec(migration)
    await pg.sql.exec(migration)
  }
  await privileged(`CREATE ROLE synthetic_packet_admin LOGIN NOSUPERUSER NOBYPASSRLS;GRANT autoreply_admin TO synthetic_packet_admin;
    CREATE ROLE synthetic_packet_other LOGIN NOSUPERUSER NOBYPASSRLS;GRANT autoreply_admin TO synthetic_packet_other;
    CREATE ROLE synthetic_packet_device LOGIN NOSUPERUSER NOBYPASSRLS;GRANT autoreply_app TO synthetic_packet_device;
    CREATE ROLE synthetic_packet_worker LOGIN NOSUPERUSER NOBYPASSRLS;GRANT autoreply_learning_worker TO synthetic_packet_worker;
    INSERT INTO tenants VALUES('A','Synthetic A'),('B','Synthetic B');
    INSERT INTO employees(tenant_id,id,role) VALUES('A','admin-A','admin'),('A','other-admin','admin'),('A','employee-A','employee');
    INSERT INTO accounts(tenant_id,id,employee_id,platform) VALUES('A','account-A','employee-A','wechat');
    INSERT INTO admin_database_principals(login_name,tenant_id,employee_id) VALUES('synthetic_packet_admin','A','admin-A'),('synthetic_packet_other','A','other-admin');`)
  const publication = PublicationSchema.parse(
    JSON.parse(await readFile('server/admin/publication.example.json', 'utf8'))
  )
  const plan = evaluationPlan()
  const cases = plan.assignments.map((a) => ({
    ...a,
    conversationId: `synthetic-peer-${a.caseId}`,
    inbound: ['请转人工客服']
  }))
  plan.replayProtocol = 'jev-abc-v1'
  plan.assignments = plan.assignments.map((a, i) => ({
    ...a,
    inputHash: replayCaseInputHash(cases[i])
  }))
  await pg.sql.query(
    `INSERT INTO evaluation_runs(tenant_id,account_id,id,snapshot_hash,publication_json,plan_json,created_by)
    VALUES('A','account-A','run-A',$1,$2::jsonb,$3::jsonb,'admin-A')`,
    [evaluationSnapshotHash(publication), JSON.stringify(publication), JSON.stringify(plan)]
  )
  await login()
  const journal = new JevReplayJournal(pg.db, publication.textGeneratorVersion)
  const input = { datasetId: plan.datasetId, split: 'calibration', cases: cases.slice(0, 100) }
  const prepared = await journal.begin({
    tenantId: 'A',
    accountId: 'account-A',
    runId: 'run-A',
    fullRawCases: input,
    maxRunAttempts: 1000
  })
  // Precise synthetic SQL fixtures exercise seals/auth/hash binding. These are
  // 300 no-call handoffs, not proof of a complete real HTTP/model evaluation.
  artifacts = input.cases.flatMap((c) =>
    (['A', 'B', 'C'] as const).map((arm) => ({
      runId: 'run-A',
      caseId: c.caseId,
      arm,
      assignmentId: randomUUID(),
      protocol: JEV_REPLAY_PROTOCOL,
      baselineRoute: JEV_BASELINE_ROUTE,
      inputHash: replayCaseInputHash(c),
      executionPlanHash: hashContext(plan),
      snapshotHash: prepared.source.snapshotHash,
      status: 'handoff' as const,
      wouldRelease: false,
      releaseAuthorized: false as const,
      factsVerified: false,
      intents: [],
      reasons: ['explicit_human_request'],
      draft: null,
      pre: null,
      post: null,
      stages: [],
      latencyMs: 1,
      otherProcessingMs: 1,
      attempts: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      usageSource: 'recorded_http_attempts' as const,
      billedCostMicros: null
    }))
  )
  await pg.db.transaction('A', async (db) => {
    await db.query(
      `INSERT INTO jev_replay_assignments(tenant_id,account_id,execution_id,id,case_id,arm,input_hash)
      SELECT 'A','account-A',$1,x.id,x.case_id,x.arm,x.input_hash FROM jsonb_to_recordset($2::jsonb) x(id uuid,case_id text,arm text,input_hash text)`,
      [
        prepared.executionId,
        JSON.stringify(
          artifacts.map((a) => ({
            id: a.assignmentId,
            case_id: a.caseId,
            arm: a.arm,
            input_hash: a.inputHash
          }))
        )
      ]
    )
    await db.query(
      `INSERT INTO jev_replay_artifact_seals(tenant_id,account_id,assignment_id,artifact_hash,ledger_hash,attempt_count)
      SELECT 'A','account-A',x.id,x.hash,$1,0 FROM jsonb_to_recordset($2::jsonb) x(id uuid,hash text)`,
      [
        hashContext([]),
        JSON.stringify(artifacts.map((a) => ({ id: a.assignmentId, hash: hashContext(a) })))
      ]
    )
  })
  const source = await new Administration(
    pg.db,
    publication.textGeneratorVersion
  ).readFrozenEvaluation('A', 'account-A', 'run-A')
  packet = createJevBlindReview({
    frozen: source,
    rawCases: input,
    artifacts,
    dataKind: 'synthetic',
    rubricRef: 'synthetic-rubric-v1',
    priorAnnotations: {
      annotatedBy: 'synthetic-reviewer',
      cases: input.cases.map((c) => ({
        caseId: c.caseId,
        category: 'handoff',
        eligible: false,
        expectedHandoff: true,
        intentCount: 1
      }))
    }
  }).privatePacket
  seals = new JevBlindPacketSeals(pg.db, publication.textGeneratorVersion)
}, 20000)
beforeEach(async ({ task }) => {
  await privileged('TRUNCATE jev_blind_packet_seals')
  await login()
  existingSeal = undefined
  // These scenarios require an existing centrally verified seal. Build that state
  // with the full real SQL workflow, then time only the independent operation.
  if (sealedStateTests.has(task.name)) existingSeal = await seals.seal(request())
})
afterAll(async () => {
  if (pg) await pg.db.close()
})

describe('central immutable Jev blind packet seals', () => {
  it('creates the first complete packet seal within the operation deadline without publishing', async () => {
    const first = await seals.seal(request())
    expect(first).toMatchObject({
      packetId: packet.packetId,
      packetHash: packet.packetHash,
      centralRecordVerified: true,
      releaseAuthorized: false
    })
    expect(Number.isFinite(Date.parse(first.sealedAt))).toBe(true)
    const row = (
      await pg.db.transaction('A', (db) =>
        db.query(`SELECT *,
      (SELECT count(*)::integer FROM evaluation_approvals) AS approvals,
      (SELECT count(*)::integer FROM generation_tasks) AS tasks,
      (SELECT count(*)::integer FROM execution_permits) AS permits,
      (SELECT paused FROM accounts WHERE id='account-A') AS paused
      FROM jev_blind_packet_seals`)
      )
    ).rows[0]
    expect(row).toMatchObject({
      packet_id: first.packetId,
      packet_hash: first.packetHash,
      artifact_set_hash: first.artifactSetHash,
      actor_id: 'admin-A',
      login_name: 'synthetic_packet_admin',
      approvals: 0,
      tasks: 0,
      permits: 0,
      paused: true
    })
    expect(new Date(row.sealed_at).toISOString()).toBe(first.sealedAt)
    expect(row).not.toHaveProperty('packet_json')
    expect(row).not.toHaveProperty('draft')
  })

  it('seals the complete packet idempotently with DB time', async () => {
    const first = existingSeal!
    expect(first).toBeDefined()
    expect(first).toMatchObject({
      packetId: packet.packetId,
      packetHash: packet.packetHash,
      centralRecordVerified: true,
      releaseAuthorized: false
    })
    expect(Number.isFinite(Date.parse(first.sealedAt))).toBe(true)
    expect(await seals.seal(request())).toEqual(first)
    await expect(
      seals.assertCanCreate({
        tenantId: 'A',
        accountId: 'account-A',
        runId: 'run-A',
        split: 'calibration'
      })
    ).rejects.toThrow('jev_blind_packet_already_sealed')
  })
  it('verifies a complete sealed packet using a fresh instance without publishing', async () => {
    const first = existingSeal!
    expect(first).toBeDefined()
    expect(
      await new JevBlindPacketSeals(pg.db, packet.frozen.publication.textGeneratorVersion).verify(
        request()
      )
    ).toEqual(first)
    const row = (
      await pg.db.transaction('A', (db) =>
        db.query(`SELECT *,
      (SELECT count(*)::integer FROM evaluation_approvals) AS approvals,(SELECT count(*)::integer FROM generation_tasks) AS tasks,
      (SELECT count(*)::integer FROM execution_permits) AS permits,(SELECT paused FROM accounts WHERE id='account-A') AS paused
      FROM jev_blind_packet_seals`)
      )
    ).rows[0]
    expect(row).toMatchObject({
      actor_id: 'admin-A',
      login_name: 'synthetic_packet_admin',
      approvals: 0,
      tasks: 0,
      permits: 0,
      paused: true
    })
    expect(row).not.toHaveProperty('packet_json')
    expect(row).not.toHaveProperty('draft')
  })
  it('preflights the original executor and exact split without registering missing executions or packets', async () => {
    const calibration = {
      tenantId: 'A',
      accountId: 'account-A',
      runId: 'run-A',
      split: 'calibration' as const
    }
    await expect(seals.assertCanCreate(calibration)).resolves.toBeUndefined()
    await expect(seals.assertCanCreate({ ...calibration, split: 'holdout' })).rejects.toThrow(
      'jev_blind_packet_execution_missing'
    )
    await login('synthetic_packet_other')
    await expect(seals.assertCanCreate(calibration)).rejects.toThrow('jev_blind_packet_denied')
    await login()
    expect(
      (
        await pg.db.transaction('A', (db) =>
          db.query('SELECT count(*)::integer AS n FROM jev_blind_packet_seals')
        )
      ).rows[0].n
    ).toBe(0)
  })
  it('does not register unsealed local packets during verify', async () => {
    await expect(seals.verify(request())).rejects.toThrow('unsealed')
    expect(
      (
        await pg.db.transaction('A', (db) =>
          db.query('SELECT count(*)::integer AS n FROM jev_blind_packet_seals')
        )
      ).rows[0].n
    ).toBe(0)
  })
  it('rejects modified priors/rubric/dataKind even after the caller recalculates the full packet hash', async () => {
    await seals.seal(request())
    for (const field of ['prior', 'rubric', 'kind'] as const) {
      const changed = structuredClone(packet)
      if (field === 'prior') changed.priorAnnotations.cases[0].eligible = true
      if (field === 'rubric') changed.rubricRef = 'new-rubric'
      if (field === 'kind') changed.dataKind = 'business'
      await expect(seals.verify({ ...request(), packet: rehash(changed) })).rejects.toThrow(
        'changed'
      )
      await expect(seals.seal({ ...request(), packet: rehash(changed) })).rejects.toThrow('changed')
    }
  })
  it('rejects remapped review IDs, assignment/arm/hash changes and duplicate mappings', async () => {
    await seals.seal(request())
    const renamed = structuredClone(packet)
    renamed.mapping[0].reviewId = randomUUID()
    await expect(seals.verify({ ...request(), packet: rehash(renamed) })).rejects.toThrow('changed')
    for (const field of ['arm', 'hash', 'assignment', 'duplicate'] as const) {
      const changed = structuredClone(packet)
      if (field === 'arm') changed.mapping[0].arm = 'B'
      if (field === 'hash') changed.mapping[0].artifactHash = 'a'.repeat(64)
      if (field === 'assignment') changed.mapping[0].assignmentId = randomUUID()
      if (field === 'duplicate') changed.mapping[1] = changed.mapping[0]
      await expect(seals.verify({ ...request(), packet: rehash(changed) })).rejects.toThrow(
        'mapping_invalid'
      )
    }
  })
  it('requires whole unique priors and rejects unnormalized packets or changed hash without registering anything', async () => {
    for (const mode of ['missing', 'duplicate'] as const) {
      const changed = structuredClone(packet)
      if (mode === 'missing') changed.priorAnnotations.cases.pop()
      else changed.priorAnnotations.cases[1] = changed.priorAnnotations.cases[0]
      await expect(seals.seal({ ...request(), packet: rehash(changed) })).rejects.toThrow(
        'priors_incomplete'
      )
    }
    await expect(
      seals.seal({ ...request(), packet: { ...packet, packetHash: 'a'.repeat(64) } })
    ).rejects.toThrow('changed')
    await expect(
      seals.seal({ ...request(), packet: { ...packet, unexpected: true } })
    ).rejects.toThrow()
  })
  it('fixes the first packet per execution and prevents creating a different replacement packet', async () => {
    await seals.seal(request())
    const replacement = rehash({ ...packet, packetId: randomUUID() })
    await expect(seals.seal({ ...request(), packet: replacement })).rejects.toThrow('changed')
    await expect(seals.verify({ ...request(), packet: replacement })).rejects.toThrow('changed')
  })
  it('rejects caller-controlled artifact edits even when all local packet hashes are recomputed', async () => {
    const changed = structuredClone(artifacts)
    changed[0].reasons = ['substituted']
    const p = structuredClone(packet)
    p.mapping[0].artifactHash = hashContext(changed[0])
    await expect(
      seals.seal({ ...request(), packet: rehash(p), artifacts: changed })
    ).rejects.toThrow('RECORD_UNAVAILABLE')
    await expect(seals.seal({ ...request(), artifacts: artifacts.slice(1) })).rejects.toThrow(
      'mapping_invalid'
    )
  })
  it('requires the original actual administrator login and rejects devices, workers and other tenants', async () => {
    await seals.seal(request())
    for (const name of [
      'synthetic_packet_other',
      'synthetic_packet_device',
      'synthetic_packet_worker'
    ]) {
      await login(name)
      await expect(seals.verify(request())).rejects.toThrow()
      await expect(
        pg.db.transaction('A', (db) =>
          db.query('INSERT INTO jev_blind_packet_seals DEFAULT VALUES')
        )
      ).rejects.toThrow()
    }
    await login()
    await expect(seals.verify({ ...request(), tenantId: 'B' })).rejects.toThrow()
    await expect(seals.verify({ ...request(), runId: 'another-run' })).rejects.toThrow()
  })
  it('keeps existing packet seals immutable for ordinary administrators and privileged deletion', async () => {
    expect(existingSeal).toBeDefined()
    await expect(
      pg.db.transaction('A', (db) =>
        db.query("UPDATE jev_blind_packet_seals SET packet_hash=repeat('a',64)")
      )
    ).rejects.toThrow()
    await expect(
      pg.db.transaction('A', (db) => db.query('DELETE FROM jev_blind_packet_seals'))
    ).rejects.toThrow()
    await expect(privileged('DELETE FROM jev_blind_packet_seals')).rejects.toThrow('immutable')
    await login()
    expect(
      (
        await pg.db.transaction('A', (db) =>
          db.query('SELECT packet_hash FROM jev_blind_packet_seals')
        )
      ).rows
    ).toEqual([{ packet_hash: packet.packetHash }])
  })
  it('rejects fresh raw SQL insertion of a false artifact set without an existing packet seal', async () => {
    await expect(
      pg.db.transaction('A', (db) =>
        db.query(
          `INSERT INTO jev_blind_packet_seals(tenant_id,account_id,packet_id,execution_id,run_id,packet_hash,artifact_set_hash,actor_id,login_name)
      SELECT tenant_id,account_id,$1,id,run_id,$2,$2,'','' FROM jev_replay_executions`,
          [randomUUID(), 'a'.repeat(64)]
        )
      )
    ).rejects.toThrow('artifacts_unverified')
    expect(
      (
        await pg.db.transaction('A', (db) =>
          db.query('SELECT count(*)::integer AS n FROM jev_blind_packet_seals')
        )
      ).rows[0].n
    ).toBe(0)
  })
})
