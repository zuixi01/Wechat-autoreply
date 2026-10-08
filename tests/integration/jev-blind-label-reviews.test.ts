import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { embeddedPostgres } from '../fixtures/embedded-postgres'
import { evaluationPlan } from '../fixtures/evaluation-data'
import { hashContext } from '../../src/core/reply/hashes'
import { replayCaseInputHash } from '../../evals/jev/replay-input'
import { createJevBlindReview, type PrivateBlindReviewPacket } from '../../evals/jev/blind-review'
import {
  JEV_BASELINE_ROUTE,
  JEV_REPLAY_PROTOCOL,
  type JevReplayArmArtifact
} from '../../evals/jev/replay'
import { PublicationSchema } from '../../server/src/generation/publication'
import { evaluationSnapshotHash } from '../../server/src/generation/evaluation-authorization'
import { Administration } from '../../server/src/admin/administration'
import { JevReplayJournal } from '../../server/src/generation/jev-replay-journal'
import { JevBlindPacketSeals } from '../../server/src/generation/jev-blind-packet-seals'
import {
  JevBlindLabelReviews,
  type JevBlindLabelReviewReceipt
} from '../../server/src/generation/jev-blind-label-reviews'

let pg: Awaited<ReturnType<typeof embeddedPostgres>>,
  reviews: JevBlindLabelReviews,
  packet: PrivateBlindReviewPacket
const unicodeReviewer = '评审"\\员\n甲'
let labels: {
  adjudicatedBy: string
  annotationSource: 'blinded_business_adjudication'
  labels: {
    reviewId: string
    substantialCorrection: boolean | null
    severeFactError: boolean
    unauthorizedPromise: boolean
    incorrectlyBlocked: boolean
    coveredIntents: number
  }[]
}
const request = () => ({
  tenantId: 'A',
  accountId: 'account-A',
  runId: 'run-A',
  packetId: packet.packetId,
  labels
})
async function privileged(sql: string) {
  await pg.sql.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE')
  await pg.sql.exec(sql)
}
async function login(name = 'synthetic_label_reviewer') {
  await pg.sql.exec(
    `SET SESSION AUTHORIZATION postgres; RESET ROLE; SET SESSION AUTHORIZATION ${name}`
  )
}
async function verify(receipt: JevBlindLabelReviewReceipt, raw = labels) {
  await login('synthetic_label_admin')
  return reviews.verify({
    ...request(),
    labels: raw,
    packetHash: packet.packetHash,
    reviewId: receipt.reviewId
  })
}

beforeAll(async () => {
  pg = await embeddedPostgres()
  for (const name of [
    '045-jev-replay-journal.sql',
    '046-jev-replay-artifact-seals.sql',
    '047-jev-blind-packet-seals.sql',
    '048-jev-blind-label-reviews.sql',
    '052-jev-review-single-digest.sql'
  ]) {
    const source = await readFile(`server/migrations/${name}`, 'utf8')
    await pg.sql.exec(source)
    await pg.sql.exec(source)
  }
  await privileged(`CREATE ROLE synthetic_label_admin LOGIN NOSUPERUSER NOBYPASSRLS;GRANT autoreply_admin TO synthetic_label_admin;
    CREATE ROLE synthetic_label_other_admin LOGIN NOSUPERUSER NOBYPASSRLS;GRANT autoreply_admin TO synthetic_label_other_admin;
    CREATE ROLE synthetic_label_reviewer LOGIN NOSUPERUSER NOBYPASSRLS;GRANT autoreply_jev_reviewer TO synthetic_label_reviewer;
    CREATE ROLE synthetic_label_reviewer_two LOGIN NOSUPERUSER NOBYPASSRLS;GRANT autoreply_jev_reviewer TO synthetic_label_reviewer_two;
    CREATE ROLE synthetic_label_executor LOGIN NOSUPERUSER NOBYPASSRLS;GRANT autoreply_jev_reviewer TO synthetic_label_executor;
    CREATE ROLE synthetic_label_creator LOGIN NOSUPERUSER NOBYPASSRLS;GRANT autoreply_jev_reviewer TO synthetic_label_creator;
    CREATE ROLE synthetic_label_mixed LOGIN NOSUPERUSER NOBYPASSRLS;GRANT autoreply_jev_reviewer,autoreply_admin TO synthetic_label_mixed;
    CREATE ROLE synthetic_label_device LOGIN NOSUPERUSER NOBYPASSRLS;GRANT autoreply_jev_reviewer,autoreply_app TO synthetic_label_device;
    CREATE ROLE synthetic_label_worker LOGIN NOSUPERUSER NOBYPASSRLS;GRANT autoreply_jev_reviewer,autoreply_learning_worker TO synthetic_label_worker;
    CREATE ROLE synthetic_label_bypass LOGIN NOSUPERUSER BYPASSRLS;GRANT autoreply_jev_reviewer TO synthetic_label_bypass;
    INSERT INTO tenants VALUES('A','Synthetic A'),('B','Synthetic B');
    INSERT INTO employees(tenant_id,id,role) VALUES('A','admin-A','admin'),('A','other-admin','admin'),('A','creator-A','admin'),('A','employee-A','employee'),('A','reviewer-two','employee');
    INSERT INTO accounts(tenant_id,id,employee_id,platform) VALUES('A','account-A','employee-A','wechat'),('A','account-B','employee-A','wechat');
    INSERT INTO admin_database_principals(login_name,tenant_id,employee_id) VALUES('synthetic_label_admin','A','admin-A'),('synthetic_label_other_admin','A','other-admin');`)
  await pg.sql.query("INSERT INTO employees(tenant_id,id,role) VALUES('A',$1,'employee')", [
    unicodeReviewer
  ])
  const mappings = [
    ['synthetic_label_reviewer', unicodeReviewer],
    ['synthetic_label_reviewer_two', 'reviewer-two'],
    ['synthetic_label_executor', 'admin-A'],
    ['synthetic_label_creator', 'creator-A'],
    ['synthetic_label_mixed', unicodeReviewer],
    ['synthetic_label_device', unicodeReviewer],
    ['synthetic_label_worker', unicodeReviewer],
    ['synthetic_label_bypass', unicodeReviewer]
  ]
  for (const [name, employee] of mappings)
    await pg.sql.query(
      "INSERT INTO jev_reviewer_database_principals(login_name,tenant_id,account_id,employee_id) VALUES($1,'A','account-A',$2)",
      [name, employee]
    )
  const publication = PublicationSchema.parse(
      JSON.parse(await readFile('server/admin/publication.example.json', 'utf8'))
    ),
    plan = evaluationPlan()
  const cases = plan.assignments.map((a) => ({
    ...a,
    conversationId: `synthetic-${a.caseId}`,
    inbound: ['请转人工客服']
  }))
  plan.replayProtocol = 'jev-abc-v1'
  plan.assignments = plan.assignments.map((a, i) => ({
    ...a,
    inputHash: replayCaseInputHash(cases[i])
  }))
  await pg.sql.query(
    `INSERT INTO evaluation_runs(tenant_id,account_id,id,snapshot_hash,publication_json,plan_json,created_by)
    VALUES('A','account-A','run-A',$1,$2::jsonb,$3::jsonb,'creator-A')`,
    [evaluationSnapshotHash(publication), JSON.stringify(publication), JSON.stringify(plan)]
  )
  await login('synthetic_label_admin')
  const input = { datasetId: plan.datasetId, split: 'calibration', cases: cases.slice(0, 100) }
  const prepared = await new JevReplayJournal(pg.db, publication.textGeneratorVersion).begin({
    tenantId: 'A',
    accountId: 'account-A',
    runId: 'run-A',
    fullRawCases: input,
    maxRunAttempts: 1000
  })
  // Synthetic bulk no-call handoffs only exercise SQL identity/seal boundaries;
  // they are not 300 measured HTTP calls or evidence of business accuracy.
  const artifacts: JevReplayArmArtifact[] = input.cases.flatMap((c) =>
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
      status: 'handoff',
      wouldRelease: false,
      releaseAuthorized: false,
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
      usageSource: 'recorded_http_attempts',
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
    rubricRef: 'synthetic-rubric',
    priorAnnotations: {
      annotatedBy: 'fixture-annotator',
      cases: input.cases.map((c) => ({
        caseId: c.caseId,
        category: 'handoff',
        eligible: false,
        expectedHandoff: true,
        intentCount: 1
      }))
    }
  }).privatePacket
  await new JevBlindPacketSeals(pg.db, publication.textGeneratorVersion).seal({
    tenantId: 'A',
    accountId: 'account-A',
    runId: 'run-A',
    packet,
    artifacts
  })
  labels = {
    adjudicatedBy: unicodeReviewer,
    annotationSource: 'blinded_business_adjudication',
    labels: packet.mapping.map((m) => ({
      reviewId: m.reviewId,
      substantialCorrection: null,
      severeFactError: false,
      unauthorizedPromise: false,
      incorrectlyBlocked: false,
      coveredIntents: 0
    }))
  }
  reviews = new JevBlindLabelReviews(pg.db)
}, 20000)
beforeEach(async () => {
  await privileged(`TRUNCATE jev_blind_label_reviews;UPDATE employees SET enabled=true;UPDATE jev_reviewer_database_principals SET enabled=true;
    UPDATE accounts SET enabled=true,employee_id='employee-A',platform='wechat';GRANT autoreply_jev_reviewer TO synthetic_label_reviewer`)
  await pg.sql.query("UPDATE evaluation_runs SET expires_at=$1 WHERE id='run-A'", [
    packet.frozen.expiresAt
  ])
  await login()
})
afterAll(async () => {
  if (pg) await pg.db.close()
})

describe('authenticated independent Jev business label reviews', () => {
  it('submits by actual ordinary reviewer, preserves Unicode/JSON escaping canonical hash, and verifies by original executor', async () => {
    const receipt = await reviews.submit({ ...request(), packetId: packet.packetId.toUpperCase() })
    expect(receipt).toMatchObject({
      packetId: packet.packetId,
      packetHash: packet.packetHash,
      labelsHash: hashContext(labels),
      reviewerId: unicodeReviewer,
      revision: 1,
      centralReviewVerified: true,
      releaseAuthorized: false
    })
    expect(Number.isFinite(Date.parse(receipt.reviewedAt))).toBe(true)
    expect(await verify(receipt)).toEqual(receipt)
    expect(
      await reviews.verify({
        ...request(),
        packetId: packet.packetId.toUpperCase(),
        reviewId: receipt.reviewId.toUpperCase(),
        packetHash: packet.packetHash
      })
    ).toEqual(receipt)
    const row = (
      await pg.db.transaction('A', (db) =>
        db.query(`SELECT reviewer_login,labels_json,(SELECT count(*)::int FROM evaluation_approvals) AS approvals,
      (SELECT count(*)::int FROM generation_tasks) AS tasks,(SELECT count(*)::int FROM account_leases) AS leases,(SELECT count(*)::int FROM execution_permits) AS permits FROM jev_blind_label_reviews`)
      )
    ).rows[0]
    expect(row).toMatchObject({
      reviewer_login: 'synthetic_label_reviewer',
      labels_json: labels,
      approvals: 0,
      tasks: 0,
      leases: 0,
      permits: 0
    })
  })
  it('is idempotent only for identical latest labels and appends corrections without editing old rows', async () => {
    const first = await reviews.submit(request())
    expect(await reviews.submit(structuredClone(request()))).toEqual(first)
    const changed = structuredClone(labels)
    changed.labels[0].incorrectlyBlocked = true
    const second = await reviews.submit({ ...request(), labels: changed })
    expect(second.revision).toBe(2)
    expect(second.reviewId).not.toBe(first.reviewId)
    expect(await reviews.submit({ ...request(), labels: changed })).toEqual(second)
    await expect(verify(first)).rejects.toThrow('jev_blind_review_stale')
    expect(await verify(second, changed)).toEqual(second)
    const rows = (
      await pg.db.transaction('A', (db) =>
        db.query('SELECT revision,labels_json FROM jev_blind_label_reviews ORDER BY revision')
      )
    ).rows
    expect(rows.map((row) => ({ ...row, revision: Number(row.revision) }))).toEqual([
      { revision: 1, labels_json: labels },
      { revision: 2, labels_json: changed }
    ])
  })
  it('uses one shared revision stream across independent reviewers; returning to old labels still creates a new revision', async () => {
    const first = await reviews.submit(request())
    await login('synthetic_label_reviewer_two')
    const other = { ...labels, adjudicatedBy: 'reviewer-two' }
    const second = await reviews.submit({ ...request(), labels: other })
    expect(second.revision).toBe(2)
    await login()
    const third = await reviews.submit(request())
    expect(third.revision).toBe(3)
    await expect(verify(first)).rejects.toThrow('stale')
    await expect(verify(second, other)).rejects.toThrow('stale')
    expect(await verify(third)).toEqual(third)
  })
  it('denies claimed adjudicator impersonation, executor identity and run creator identity', async () => {
    await expect(
      reviews.submit({ ...request(), labels: { ...labels, adjudicatedBy: 'reviewer-two' } })
    ).rejects.toThrow('identity_or_count')
    for (const [name, employee] of [
      ['synthetic_label_executor', 'admin-A'],
      ['synthetic_label_creator', 'creator-A']
    ]) {
      await login(name)
      await expect(
        reviews.submit({ ...request(), labels: { ...labels, adjudicatedBy: employee } })
      ).rejects.toThrow('independence')
    }
  })
  it('denies admin/app/worker/bypass roles even when they hold the reviewer group and a matching mapping', async () => {
    for (const name of [
      'synthetic_label_mixed',
      'synthetic_label_device',
      'synthetic_label_worker',
      'synthetic_label_bypass'
    ]) {
      await login(name)
      await expect(reviews.submit(request())).rejects.toThrow('reviewer_denied')
    }
    await login('synthetic_label_admin')
    await expect(reviews.submit(request())).rejects.toThrow()
  })
  it('denies reviewer access to private executions, packets, principal bindings, and raw table writes', async () => {
    for (const table of [
      'jev_replay_executions',
      'jev_blind_packet_seals',
      'jev_reviewer_database_principals',
      'jev_blind_label_reviews'
    ])
      await expect(
        pg.db.transaction('A', (db) => db.query(`SELECT * FROM ${table}`))
      ).rejects.toThrow('permission denied')
    await expect(
      pg.db.transaction('A', (db) => db.query('INSERT INTO jev_blind_label_reviews DEFAULT VALUES'))
    ).rejects.toThrow('permission denied')
    await expect(
      pg.db.transaction('A', (db) =>
        db.query('INSERT INTO jev_reviewer_database_principals DEFAULT VALUES')
      )
    ).rejects.toThrow('permission denied')
  })
  it('rejects cross-tenant/account/run/packet and disabled account while preserving no authority', async () => {
    for (const changed of [
      { tenantId: 'B' },
      { accountId: 'account-B' },
      { runId: 'other-run' },
      { packetId: randomUUID() }
    ])
      await expect(reviews.submit({ ...request(), ...changed })).rejects.toThrow()
    await privileged('UPDATE accounts SET enabled=false')
    await login()
    await expect(reviews.submit(request())).rejects.toThrow('reviewer_denied')
  })
  it('requires current enabled employee and mapping both on submit and on later verification', async () => {
    const receipt = await reviews.submit(request())
    for (const sql of [
      "UPDATE jev_reviewer_database_principals SET enabled=false WHERE login_name='synthetic_label_reviewer'",
      "UPDATE employees SET enabled=false WHERE role='employee'"
    ]) {
      await privileged(sql)
      await login()
      await expect(reviews.submit(request())).rejects.toThrow('reviewer_denied')
      await expect(verify(receipt)).rejects.toThrow()
      await privileged(
        'UPDATE employees SET enabled=true;UPDATE jev_reviewer_database_principals SET enabled=true'
      )
      await login()
    }
  })
  it('rejects changed labels/hash/packet/review references and a different administrator verifying old receipts', async () => {
    const receipt = await reviews.submit(request())
    const changed = structuredClone(labels)
    changed.labels[0].coveredIntents = 1
    await expect(verify(receipt, changed)).rejects.toThrow('changed')
    await expect(
      reviews.verify({ ...request(), reviewId: receipt.reviewId, packetHash: 'a'.repeat(64) })
    ).rejects.toThrow('changed')
    await expect(
      reviews.verify({ ...request(), reviewId: randomUUID(), packetHash: packet.packetHash })
    ).rejects.toThrow('changed')
    await login('synthetic_label_other_admin')
    await expect(
      reviews.verify({ ...request(), reviewId: receipt.reviewId, packetHash: packet.packetHash })
    ).rejects.toThrow('context_invalid')
  })
  it('rehashes actual stored labels even when complete caller JSON matches', async () => {
    const receipt = await reviews.submit(request())
    await privileged(`ALTER TABLE jev_blind_label_reviews DISABLE TRIGGER jev_blind_reviews_immutable;
      UPDATE jev_blind_label_reviews SET labels_hash=repeat('a',64);
      ALTER TABLE jev_blind_label_reviews ENABLE TRIGGER jev_blind_reviews_immutable`)
    try {
      await expect(verify(receipt)).rejects.toThrow('changed')
    } finally {
      await privileged(`ALTER TABLE jev_blind_label_reviews DISABLE TRIGGER jev_blind_reviews_immutable;
        UPDATE jev_blind_label_reviews SET labels_hash='${receipt.labelsHash}';
        ALTER TABLE jev_blind_label_reviews ENABLE TRIGGER jev_blind_reviews_immutable`)
    }
    expect(await verify(receipt)).toEqual(receipt)
  })
  it('rejects a decimal-scale raw SQL label even when jsonb values compare equal', async () => {
    const receipt = await reviews.submit(request())
    const canonical = JSON.stringify(labels)
    const scaled = canonical.replace(
      /"coveredIntents":(\d+)/,
      (_, integer) => `"coveredIntents":${integer}.0`
    )
    expect(scaled).not.toBe(canonical)
    await login('synthetic_label_admin')
    expect(
      await pg.db.transaction(
        'A',
        async (db) =>
          (
            await db.query(
              'SELECT $1::jsonb=$2::jsonb AS value_equal,$1::jsonb::text=$2::jsonb::text AS text_equal',
              [canonical, scaled]
            )
          ).rows[0]
      )
    ).toEqual({ value_equal: true, text_equal: false })
    await expect(
      pg.db.transaction('A', (db) =>
        db.query('SELECT * FROM verify_jev_blind_labels($1,$2,$3,$4,$5,$6,$7::jsonb)', [
          'A',
          'account-A',
          'run-A',
          packet.packetId,
          packet.packetHash,
          receipt.reviewId,
          scaled
        ])
      )
    ).rejects.toThrow('changed')
    expect(await verify(receipt)).toEqual(receipt)
  })
  it('rejects SQL NULL for the expected packet hash', async () => {
    const receipt = await reviews.submit(request())
    await login('synthetic_label_admin')
    await expect(
      pg.db.transaction('A', (db) =>
        db.query('SELECT * FROM verify_jev_blind_labels($1,$2,$3,$4,$5,$6,$7::jsonb)', [
          'A',
          'account-A',
          'run-A',
          packet.packetId,
          null,
          receipt.reviewId,
          JSON.stringify(labels)
        ])
      )
    ).rejects.toThrow('changed')
    expect(await verify(receipt)).toEqual(receipt)
  })
  it('refuses oversized, duplicate, unnormalized, incomplete and raw SQL invalid label objects', async () => {
    const duplicate = structuredClone(labels)
    duplicate.labels[1] = duplicate.labels[0]
    for (const raw of [
      duplicate,
      { ...labels, adjudicatedBy: ` ${unicodeReviewer} ` },
      { ...labels, labels: labels.labels.slice(1) },
      {
        ...labels,
        labels: Array.from({ length: 6001 }, () => ({
          ...labels.labels[0],
          reviewId: randomUUID()
        }))
      }
    ])
      await expect(reviews.submit({ ...request(), labels: raw })).rejects.toThrow()
    await expect(
      pg.db.transaction('A', (db) =>
        db.query('SELECT * FROM submit_jev_blind_labels($1,$2,$3,$4,$5::jsonb)', [
          'A',
          'account-A',
          'run-A',
          packet.packetId,
          JSON.stringify({ ...labels, unexpected: true })
        ])
      )
    ).rejects.toThrow('labels_invalid')
  })
  it('checks current run expiry, identity drift and reviewer group revocation during verification', async () => {
    const receipt = await reviews.submit(request())
    await privileged("UPDATE evaluation_runs SET expires_at=clock_timestamp()-interval '1 second'")
    await login()
    await expect(reviews.submit(request())).rejects.toThrow('context_invalid')
    await expect(verify(receipt)).rejects.toThrow('context_invalid')
    await privileged('RESET ROLE')
    await pg.sql.query("UPDATE evaluation_runs SET expires_at=$1 WHERE id='run-A'", [
      packet.frozen.expiresAt
    ])
    await privileged("UPDATE accounts SET platform='wework'")
    await expect(verify(receipt)).rejects.toThrow('context_invalid')
    await privileged(
      "UPDATE accounts SET platform='wechat';REVOKE autoreply_jev_reviewer FROM synthetic_label_reviewer"
    )
    await expect(verify(receipt)).rejects.toThrow('reviewer_denied')
  })
  it('keeps all originals immutable and gives administrators/workers no insert/update/delete path', async () => {
    await reviews.submit(request())
    await login('synthetic_label_admin')
    for (const sql of [
      'INSERT INTO jev_blind_label_reviews DEFAULT VALUES',
      "UPDATE jev_blind_label_reviews SET reviewer_id='admin-A'",
      'DELETE FROM jev_blind_label_reviews'
    ])
      await expect(pg.db.transaction('A', (db) => db.query(sql))).rejects.toThrow(
        'permission denied'
      )
    await expect(privileged('DELETE FROM jev_blind_label_reviews')).rejects.toThrow('immutable')
    await login('synthetic_label_worker')
    await expect(
      pg.db.transaction('A', (db) => db.query('INSERT INTO jev_blind_label_reviews DEFAULT VALUES'))
    ).rejects.toThrow('permission denied')
  })
})
