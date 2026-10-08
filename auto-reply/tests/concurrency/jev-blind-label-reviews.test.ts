import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Pool, type PoolClient } from 'pg'
import type { z } from 'zod'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Postgres } from '../../server/src/database/postgres'
import { Administration } from '../../server/src/admin/administration'
import { JevReplayJournal } from '../../server/src/generation/jev-replay-journal'
import { JevBlindPacketSeals } from '../../server/src/generation/jev-blind-packet-seals'
import {
  JevBlindLabelReviews,
  type JevBlindLabelReviewReceipt
} from '../../server/src/generation/jev-blind-label-reviews'
import { PublicationSchema } from '../../server/src/generation/publication'
import {
  createJevBlindReview,
  type BlindLabelsSchema,
  type PrivateBlindReviewPacket
} from '../../evals/jev/blind-review'
import {
  JEV_BASELINE_ROUTE,
  JEV_REPLAY_PROTOCOL,
  type JevReplayArmArtifact
} from '../../evals/jev/replay'
import { replayCaseInputHash } from '../../evals/jev/replay-input'
import { hashContext } from '../../src/core/reply/hashes'
import { evaluationPlan } from '../fixtures/evaluation-data'

const suffix = randomUUID().replaceAll('-', '')
const database = `jev_labels_${suffix}`,
  adminLogin = `jev_labels_admin_${suffix}`,
  reviewerLogin = `jev_labels_reviewer_${suffix}`,
  otherReviewerLogin = `jev_labels_other_${suffix}`
const poolErrors: { pool: string; code: string }[] = []
function observePoolErrors(pool: Pool, name: string) {
  // Retain SQLSTATE only; driver messages/configuration can contain test credentials.
  pool.on('error', (error: Error & { code?: string }) => {
    poolErrors.push({
      pool: name,
      code:
        typeof error.code === 'string' && /^[A-Z0-9]{5}$/.test(error.code) ? error.code : 'unknown'
    })
  })
}
type Labels = z.infer<typeof BlindLabelsSchema>
type Lock = {
  client: PoolClient
  pid: number
  xid: string
  release: (commit: boolean) => Promise<void>
}
let cluster: Pool,
  root: Pool,
  admin: Postgres,
  reviewerDatabases: Postgres[],
  reviewers: JevBlindLabelReviews[],
  verifier: JevBlindLabelReviews,
  packet: PrivateBlindReviewPacket,
  labels: Labels

const scope = () => ({
  tenantId: 'A',
  accountId: 'account-A',
  runId: packet.frozen.runId,
  packetId: packet.packetId
})
const submit = (index: number, payload = labels) =>
  reviewers[index].submit({ ...scope(), labels: payload })
const verify = (receipt: JevBlindLabelReviewReceipt, payload = labels) =>
  verifier.verify({
    ...scope(),
    packetHash: packet.packetHash,
    reviewId: receipt.reviewId,
    labels: payload
  })

beforeAll(async () => {
  const uri = process.env.AUTOREPLY_POSTGRES_TEST_URL,
    password = process.env.AUTOREPLY_POSTGRES_TEST_PASSWORD
  if (!uri || !password || !/^[a-f0-9]{64}$/.test(password))
    throw new Error('use_isolated_postgres_runner')
  const url = new URL(uri)
  if (
    url.hostname !== '127.0.0.1' ||
    url.username !== 'postgres' ||
    !/^\/autoreply_concurrency_[a-f0-9]{32}$/.test(url.pathname) ||
    !process.env.AUTOREPLY_POSTGRES_TEST_REPORT
  )
    throw new Error('use_isolated_postgres_runner')
  cluster = new Pool({ connectionString: uri, max: 1 })
  observePoolErrors(cluster, 'cluster')
  await cluster.query(`CREATE DATABASE ${database}`)
  url.pathname = `/${database}`
  root = new Pool({
    connectionString: url.href,
    max: 4,
    options: '-c search_path=autoreply,public'
  })
  observePoolErrors(root, 'operator')
  const migrations = (await readdir(resolve('server/migrations')))
    .filter((f) => /^\d{3}-.+\.sql$/.test(f))
    .sort()
  expect(migrations).toContain('048-jev-blind-label-reviews.sql')
  for (const name of migrations) {
    const source = await readFile(resolve('server/migrations', name), 'utf8')
    await root.query(source)
    await root.query(source)
  }
  for (const [name, group] of [
    [adminLogin, 'autoreply_admin'],
    [reviewerLogin, 'autoreply_jev_reviewer'],
    [otherReviewerLogin, 'autoreply_jev_reviewer']
  ])
    await root.query(
      `CREATE ROLE ${name} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${password}'; GRANT ${group} TO ${name}`
    )
  url.username = adminLogin
  url.password = password
  admin = new Postgres(url.href)
  observePoolErrors(admin.pool, 'administrator')
  // Two pools for one real LOGIN and a third for another real LOGIN; no SET ROLE.
  reviewerDatabases = [reviewerLogin, reviewerLogin, otherReviewerLogin].map((login) => {
    const connection = new URL(url)
    connection.username = login
    return new Postgres(connection.href)
  })
  reviewerDatabases.forEach((db, index) => observePoolErrors(db.pool, `reviewer-${index}`))
  reviewers = reviewerDatabases.map((db) => new JevBlindLabelReviews(db))
  verifier = new JevBlindLabelReviews(admin)
  await root.query(`INSERT INTO tenants(id,name) VALUES('A','synthetic blind review concurrency');
    INSERT INTO employees(tenant_id,id,role) VALUES('A','admin-A','admin'),('A','employee-A','employee'),('A','reviewer-A','employee'),('A','reviewer-B','employee');
    INSERT INTO accounts(tenant_id,id,employee_id,platform,paused) VALUES('A','account-A','employee-A','wechat',true)`)
  await root.query(
    "INSERT INTO admin_database_principals(login_name,tenant_id,employee_id) VALUES($1,'A','admin-A')",
    [adminLogin]
  )
  for (const [login, employee] of [
    [reviewerLogin, 'reviewer-A'],
    [otherReviewerLogin, 'reviewer-B']
  ])
    await root.query(
      "INSERT INTO jev_reviewer_database_principals(login_name,tenant_id,account_id,employee_id) VALUES($1,'A','account-A',$2)",
      [login, employee]
    )
  for (const [index, db] of reviewerDatabases.entries()) {
    const actual = await db.transaction('A', (client) =>
      client.query(`SELECT session_user AS login,r.rolsuper,r.rolbypassrls,
        pg_has_role(session_user,'autoreply_jev_reviewer','USAGE') AS reviewer,
        pg_has_role(session_user,'autoreply_admin','MEMBER') AS administrator
        FROM pg_roles r WHERE r.rolname=session_user`)
    )
    expect(actual.rows).toEqual([
      {
        login: index === 2 ? otherReviewerLogin : reviewerLogin,
        rolsuper: false,
        rolbypassrls: false,
        reviewer: true,
        administrator: false
      }
    ])
  }
  const publication = PublicationSchema.parse(
      JSON.parse(await readFile('server/admin/publication.example.json', 'utf8'))
    ),
    plan = evaluationPlan()
  // Intended publication needed for freeze admission only; never published or activated.
  publication.configuration.automaticEnabled = true
  publication.policy.mode = 'enforced'
  publication.policy.evaluationApproved = true
  const cases = plan.assignments.map((assignment) => ({
    ...assignment,
    conversationId: `synthetic-${assignment.caseId}`,
    inbound: ['请转人工客服']
  }))
  plan.replayProtocol = 'jev-abc-v1'
  plan.assignments = plan.assignments.map((assignment, i) => ({
    ...assignment,
    inputHash: replayCaseInputHash(cases[i])
  }))
  expect(plan.assignments).toHaveLength(300)
  const run = await new Administration(admin, publication.textGeneratorVersion).freezeEvaluation(
    'A',
    'account-A',
    { publication, plan }
  )
  const input = { datasetId: plan.datasetId, split: 'calibration', cases: cases.slice(0, 100) }
  const prepared = await new JevReplayJournal(admin, publication.textGeneratorVersion).begin({
    tenantId: 'A',
    accountId: 'account-A',
    runId: run.runId,
    fullRawCases: input,
    maxRunAttempts: 1000
  })
  // Operator-only bulk synthetic no-call handoffs prepare SQL fixtures, not
  // measured HTTP executions or business labels. The 047 seal below is real.
  const artifacts: JevReplayArmArtifact[] = input.cases.flatMap((c) =>
    (['A', 'B', 'C'] as const).map((arm) => ({
      runId: run.runId,
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
  const fixture = await root.connect()
  try {
    await fixture.query('BEGIN')
    await fixture.query('ALTER TABLE jev_replay_assignments DISABLE TRIGGER USER')
    await fixture.query('ALTER TABLE jev_replay_artifact_seals DISABLE TRIGGER USER')
    await fixture.query(
      `INSERT INTO jev_replay_assignments(tenant_id,account_id,execution_id,id,case_id,arm,input_hash)
       SELECT 'A','account-A',$1,x.id,x.case_id,x.arm,x.input_hash
       FROM jsonb_to_recordset($2::jsonb) x(id uuid,case_id text,arm text,input_hash text)`,
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
    await fixture.query(
      `INSERT INTO jev_replay_artifact_seals(tenant_id,account_id,assignment_id,artifact_hash,ledger_hash,attempt_count)
       SELECT 'A','account-A',x.id,x.hash,$1,0 FROM jsonb_to_recordset($2::jsonb) x(id uuid,hash text)`,
      [
        hashContext([]),
        JSON.stringify(artifacts.map((a) => ({ id: a.assignmentId, hash: hashContext(a) })))
      ]
    )
    await fixture.query('ALTER TABLE jev_replay_assignments ENABLE TRIGGER USER')
    await fixture.query('ALTER TABLE jev_replay_artifact_seals ENABLE TRIGGER USER')
    await fixture.query('COMMIT')
  } catch (error) {
    await fixture.query('ROLLBACK')
    throw error
  } finally {
    fixture.release()
  }
  const frozen = await new Administration(
    admin,
    publication.textGeneratorVersion
  ).readFrozenEvaluation('A', 'account-A', run.runId)
  packet = createJevBlindReview({
    frozen,
    rawCases: input,
    artifacts,
    dataKind: 'synthetic',
    rubricRef: 'synthetic-rubric',
    priorAnnotations: {
      annotatedBy: 'synthetic-fixture-annotator',
      cases: input.cases.map((c) => ({
        caseId: c.caseId,
        category: 'handoff',
        eligible: false,
        expectedHandoff: true,
        intentCount: 1
      }))
    }
  }).privatePacket
  const seal = await new JevBlindPacketSeals(admin, publication.textGeneratorVersion).seal({
    tenantId: 'A',
    accountId: 'account-A',
    runId: run.runId,
    packet,
    artifacts
  })
  expect(seal).toMatchObject({
    packetId: packet.packetId,
    packetHash: packet.packetHash,
    centralRecordVerified: true,
    releaseAuthorized: false
  })
  expect(packet.input.cases).toHaveLength(100)
  expect(packet.mapping).toHaveLength(300)
  labels = {
    adjudicatedBy: 'reviewer-A',
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
})

beforeEach(async () => {
  await root.query(`TRUNCATE jev_holdout_lineages,jev_blind_label_reviews;
    UPDATE employees SET enabled=true;
    UPDATE jev_reviewer_database_principals SET enabled=true`)
})

afterEach(async () => {
  if (!root) return
  const counts = (
    await root.query(`SELECT
      (SELECT count(*)::int FROM jev_replay_assignments) AS assignments,
      (SELECT count(*)::int FROM jev_replay_artifact_seals) AS artifact_seals,
      (SELECT count(*)::int FROM jev_blind_packet_seals) AS packets,
      (SELECT count(*)::int FROM jev_replay_attempts) AS attempts,
      (SELECT count(*)::int FROM evaluation_approvals) AS approvals,
      (SELECT count(*)::int FROM generation_tasks) AS tasks,
      (SELECT count(*)::int FROM account_leases) AS leases,
      (SELECT count(*)::int FROM execution_permits) AS permits`)
  ).rows[0]
  expect(counts).toEqual({
    assignments: 300,
    artifact_seals: 300,
    packets: 1,
    attempts: 0,
    approvals: 0,
    tasks: 0,
    leases: 0,
    permits: 0
  })
})

afterAll(async () => {
  const closures = await Promise.allSettled([
    ...(reviewerDatabases ?? []).map((db) => db.close()),
    admin?.close(),
    root?.end()
  ])
  try {
    // Inspect every close result without serializing errors containing connection secrets.
    expect(closures.map((result) => result.status)).toEqual(closures.map(() => 'fulfilled'))
    if (cluster) {
      await vi.waitFor(
        async () => {
          const state = await cluster.query(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND backend_type='client backend'",
            [database]
          )
          expect(state.rows[0].n).toBe(0)
        },
        { timeout: 1500, interval: 20 }
      )
      await cluster.query(`DROP DATABASE IF EXISTS ${database}`)
    }
  } finally {
    const completion = await Promise.allSettled([cluster?.end()])
    expect(completion.map((result) => result.status)).toEqual(['fulfilled'])
    expect(poolErrors).toEqual([])
  }
})

async function begin(client: PoolClient): Promise<Lock> {
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    await client.query("SELECT set_config('app.tenant_id','A',true)")
    const state = (await client.query('SELECT pg_backend_pid() AS pid,txid_current()::text AS xid'))
      .rows[0]
    let released = false
    return {
      client,
      pid: state.pid,
      xid: state.xid,
      release: async (commit) => {
        if (released) return
        released = true
        try {
          await client.query(commit ? 'COMMIT' : 'ROLLBACK')
        } finally {
          client.release()
        }
      }
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
    throw error
  }
}

async function holdAccount(): Promise<Lock> {
  const lock = await begin(await root.connect())
  try {
    await lock.client.query(
      "SELECT 1 FROM accounts WHERE tenant_id='A' AND id='account-A' FOR UPDATE"
    )
    return lock
  } catch (error) {
    await lock.release(false)
    throw error
  }
}

/** Observe actual blocked server backends and their blocking transaction; no sleep inference. */
async function waitForLocks(lock: Lock, logins: string[], count: number, queryPrefix: string) {
  let rows: { pid: number; transactionid: string | null; blockers: number[] }[] = []
  await expect
    .poll(
      async () => {
        rows = (
          await root.query(
            `SELECT a.pid,l.transactionid::text,pg_blocking_pids(a.pid) AS blockers
             FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid AND NOT l.granted
             WHERE a.datname=current_database() AND a.usename=ANY($1::name[])
               AND a.wait_event_type='Lock' AND a.query LIKE $2`,
            [logins, `${queryPrefix}%`]
          )
        ).rows
        return new Set(rows.map((row) => row.pid)).size
      },
      { timeout: 1500, interval: 20 }
    )
    .toBe(count)
  expect(
    rows.some((row) => row.transactionid === lock.xid && row.blockers.includes(lock.pid))
  ).toBe(true)
  expect(rows.every((row) => row.blockers.length > 0)).toBe(true)
  return rows
}

async function storedReviews() {
  return (
    await root.query(
      `SELECT id,revision::int,reviewer_id,reviewer_login,labels_json,labels_hash
       FROM jev_blind_label_reviews WHERE tenant_id='A' AND account_id='account-A' ORDER BY revision`
    )
  ).rows
}

describe('real PostgreSQL independent Jev blind label review concurrency', () => {
  it('serializes identical simultaneous submissions by one actual reviewer and preserves one receipt', async () => {
    const lock = await holdAccount(),
      pending = Promise.allSettled([submit(0), submit(1, structuredClone(labels))])
    try {
      expect(
        new Set(
          (
            await waitForLocks(
              lock,
              [reviewerLogin],
              2,
              'SELECT * FROM autoreply.submit_jev_blind_labels'
            )
          ).map((row) => row.pid)
        ).size
      ).toBe(2)
      expect(await storedReviews()).toEqual([])
      await lock.release(true)
      const outcomes = await pending
      expect(outcomes.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled'])
      if (outcomes[0].status !== 'fulfilled' || outcomes[1].status !== 'fulfilled')
        throw new Error('unexpected_review_rejection')
      expect(outcomes[1].value).toEqual(outcomes[0].value)
      expect(outcomes[0].value).toMatchObject({
        revision: 1,
        reviewerId: 'reviewer-A',
        labelsHash: hashContext(labels),
        releaseAuthorized: false
      })
      expect(await verify(outcomes[0].value)).toEqual(outcomes[0].value)
      expect(await storedReviews()).toEqual([
        expect.objectContaining({
          id: outcomes[0].value.reviewId,
          revision: 1,
          reviewer_login: reviewerLogin,
          labels_json: labels
        })
      ])
    } finally {
      await lock.release(false)
      await pending
    }
  })

  it('serializes two independent reviewer corrections into global revisions and rejects the old receipt', async () => {
    const other = structuredClone(labels)
    other.adjudicatedBy = 'reviewer-B'
    other.labels[0].incorrectlyBlocked = true
    const lock = await holdAccount(),
      pending = Promise.allSettled([submit(0), submit(2, other)])
    try {
      await waitForLocks(
        lock,
        [reviewerLogin, otherReviewerLogin],
        2,
        'SELECT * FROM autoreply.submit_jev_blind_labels'
      )
      await lock.release(true)
      const outcomes = await pending
      expect(outcomes.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled'])
      const receipts = outcomes
        .flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
        .sort((a, b) => a.revision - b.revision)
      expect(receipts.map((r) => r.revision)).toEqual([1, 2])
      expect(receipts[0].reviewId).not.toBe(receipts[1].reviewId)
      const rows = await storedReviews()
      expect(rows).toHaveLength(2)
      expect(rows.map((row) => row.revision)).toEqual([1, 2])
      expect(new Set(rows.map((row) => row.reviewer_login))).toEqual(
        new Set([reviewerLogin, otherReviewerLogin])
      )
      await expect(verify(receipts[0], rows[0].labels_json)).rejects.toThrow(
        'jev_blind_review_stale'
      )
      expect(await verify(receipts[1], rows[1].labels_json)).toEqual(receipts[1])
      expect((await storedReviews()).map((row) => row.id)).toEqual(rows.map((row) => row.id))
    } finally {
      await lock.release(false)
      await pending
    }
  })

  it.each(['mapping', 'employee'] as const)(
    'rechecks reviewer %s disablement committed while submit waits for the account lock',
    async (target) => {
      const lock = await holdAccount(),
        pending = Promise.allSettled([submit(0)])
      try {
        await waitForLocks(
          lock,
          [reviewerLogin],
          1,
          'SELECT * FROM autoreply.submit_jev_blind_labels'
        )
        if (target === 'mapping')
          await root.query(
            "UPDATE jev_reviewer_database_principals SET enabled=false WHERE login_name=$1 AND tenant_id='A' AND account_id='account-A'",
            [reviewerLogin]
          )
        else
          await root.query(
            "UPDATE employees SET enabled=false WHERE tenant_id='A' AND id='reviewer-A'"
          )
        await lock.release(true)
        expect(await pending).toEqual([
          {
            status: 'rejected',
            reason: expect.objectContaining({ message: 'jev_blind_reviewer_denied' })
          }
        ])
        expect(await storedReviews()).toEqual([])
      } finally {
        await lock.release(false)
        await pending
      }
    }
  )

  it.each(['mapping', 'employee'] as const)(
    'holds reviewer %s FOR SHARE through actual administrator verification until commit',
    async (target) => {
      const receipt = await submit(0),
        verification = await begin(await admin.pool.connect())
      let operator: Lock | undefined
      let pending: Promise<PromiseSettledResult<unknown>[]> | undefined
      try {
        const actual = await verification.client.query(
          'SELECT session_user AS actual_admin,v.* FROM autoreply.verify_jev_blind_labels($1,$2,$3,$4,$5,$6,$7::jsonb) v',
          [
            'A',
            'account-A',
            packet.frozen.runId,
            packet.packetId,
            packet.packetHash,
            receipt.reviewId,
            JSON.stringify(labels)
          ]
        )
        expect(actual.rows).toEqual([
          expect.objectContaining({
            actual_admin: adminLogin,
            id: receipt.reviewId,
            reviewer_login: reviewerLogin
          })
        ])
        operator = await begin(await root.connect())
        const update =
          target === 'mapping'
            ? operator.client.query(
                "UPDATE jev_reviewer_database_principals SET enabled=false WHERE login_name=$1 AND tenant_id='A' AND account_id='account-A'",
                [reviewerLogin]
              )
            : operator.client.query(
                "UPDATE employees SET enabled=false WHERE tenant_id='A' AND id='reviewer-A'"
              )
        pending = Promise.allSettled([update])
        await waitForLocks(
          verification,
          ['postgres'],
          1,
          target === 'mapping' ? 'UPDATE jev_reviewer_database_principals' : 'UPDATE employees'
        )
        await verification.release(true)
        expect((await pending).map((result) => result.status)).toEqual(['fulfilled'])
        await operator.release(true)
        await expect(verify(receipt)).rejects.toThrow('jev_blind_reviewer_denied')
        expect(await storedReviews()).toEqual([
          expect.objectContaining({ id: receipt.reviewId, revision: 1, labels_json: labels })
        ])
      } finally {
        await verification.release(false)
        await pending
        await operator?.release(false)
      }
    }
  )
})
