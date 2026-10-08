import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Postgres } from '../../server/src/database/postgres'
import { Administration } from '../../server/src/admin/administration'
import { requestAccountPause } from '../../server/src/admin/account-pause'
import { JevReplayJournal } from '../../server/src/generation/jev-replay-journal'
import { JevCalibrationDeclarations } from '../../server/src/generation/jev-calibration-declarations'
import { PublicationSchema, type Publication } from '../../server/src/generation/publication'
import { replayCaseInputHash } from '../../evals/jev/replay-input'
import { executeJevReplayArm } from '../../evals/jev/replay'
import { hashContext } from '../../src/core/reply/hashes'
import { evaluationPlan } from '../fixtures/evaluation-data'

const suffix = randomUUID().replaceAll('-', '')
const database = `jev_replay_${suffix}`,
  adminLogin = `jev_admin_${suffix}`
let cluster: Pool, root: Pool, admins: Postgres[], publication: Publication
const operatorErrors: string[] = []
function recordOperatorError(error: unknown): void {
  const code =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : ''
  // Never serialize the pg Client attached to idle errors: it holds credentials.
  operatorErrors.push(/^[A-Z0-9]{5}$/.test(code) ? code : 'OPERATOR_CONNECTION_ERROR')
}
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
  cluster.on('error', recordOperatorError)
  await cluster.query(`CREATE DATABASE ${database}`)
  url.pathname = `/${database}`
  root = new Pool({
    connectionString: url.href,
    max: 3,
    options: '-c search_path=autoreply,public'
  })
  root.on('error', recordOperatorError)
  const migrations = (await readdir(resolve('server/migrations')))
    .filter((f) => /^\d{3}-.+\.sql$/.test(f))
    .sort()
  expect(migrations).toContain('045-jev-replay-journal.sql')
  expect(migrations).toContain('046-jev-replay-artifact-seals.sql')
  expect(migrations).toContain('049-jev-calibration-declarations.sql')
  for (const file of migrations) {
    const sql = await readFile(resolve('server/migrations', file), 'utf8')
    await root.query(sql)
    await root.query(sql)
  }
  await root.query(
    `CREATE ROLE ${adminLogin} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${password}'; GRANT autoreply_admin TO ${adminLogin}`
  )
  url.username = adminLogin
  url.password = password
  // Independent pools force distinct backend connections, with the same real LOGIN principal.
  admins = [new Postgres(url.href), new Postgres(url.href)]
  publication = PublicationSchema.parse(
    JSON.parse(await readFile('server/admin/publication.example.json', 'utf8'))
  )
  publication.configuration.automaticEnabled = true
  // Synthetic intended publication for SQL admission only; it is never activated.
  publication.policy.mode = 'enforced'
  publication.policy.evaluationApproved = true
})

beforeEach(async () => {
  await root.query('TRUNCATE tenants CASCADE')
  await root.query(`INSERT INTO tenants(id,name) VALUES('A','synthetic journal concurrency');
    INSERT INTO employees(tenant_id,id,role) VALUES('A','admin-A','admin'),('A','employee-A','employee');
    INSERT INTO accounts(tenant_id,id,employee_id,platform,paused) VALUES('A','account-A','employee-A','wechat',true);
    INSERT INTO admin_database_principals(login_name,tenant_id,employee_id) VALUES('${adminLogin}','A','admin-A')`)
  for (const db of admins) {
    const principal = await db.transaction('A', (client) =>
      client.query(
        `SELECT session_user AS login,p.tenant_id,p.actor_id,r.rolsuper,r.rolbypassrls
       FROM autoreply.authenticate_admin('A') p JOIN pg_roles r ON r.rolname=session_user`
      )
    )
    expect(principal.rows).toEqual([
      {
        login: adminLogin,
        tenant_id: 'A',
        actor_id: 'admin-A',
        rolsuper: false,
        rolbypassrls: false
      }
    ])
  }
})

afterAll(async () => {
  const closed = await Promise.allSettled([...(admins ?? []).map((db) => db.close()), root?.end()])
  if (cluster) {
    try {
      // Pool.end() completion may precede the backend's socket shutdown. Verify
      // actual server state before dropping; FORCE can cause a late idle error.
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
    } finally {
      await cluster.end()
    }
  }
  expect(closed.every((result) => result.status === 'fulfilled')).toBe(true)
  expect(operatorErrors).toEqual([])
})

async function prepare(index: number, humanRequest = false) {
  const frozenPlan = structuredClone(plan),
    frozenInput = structuredClone(input)
  if (humanRequest) {
    frozenInput.cases[0].inbound = ['请转人工客服']
    frozenPlan.assignments.find((a) => a.caseId === frozenInput.cases[0].caseId)!.inputHash =
      replayCaseInputHash(frozenInput.cases[0])
  }
  const db = admins[index],
    journal = new JevReplayJournal(db, publication.textGeneratorVersion)
  const run = await new Administration(db, publication.textGeneratorVersion).freezeEvaluation(
    'A',
    'account-A',
    { publication, plan: frozenPlan }
  )
  const prepared = await journal.begin({
    tenantId: 'A',
    accountId: 'account-A',
    runId: run.runId,
    fullRawCases: frozenInput,
    maxRunAttempts: 10
  })
  const assignment = {
    runId: run.runId,
    caseId: 'case-100',
    arm: 'A' as const,
    assignmentId: randomUUID()
  }
  const binding = await journal.bindAssignment(assignment)
  return { journal, prepared, assignment, binding }
}

async function holdAccount(): Promise<{
  client: PoolClient
  pid: number
  xid: string
  release: (commit: boolean) => Promise<void>
}> {
  const client = await root.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT 1 FROM accounts WHERE tenant_id='A' AND id='account-A' FOR UPDATE")
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

/** Prove blocked server transactions, rather than inferring contention from JS timing. */
async function waitForAccountLocks(
  lock: { pid: number; xid: string },
  count: number,
  queryPattern = 'SELECT id FROM accounts%FOR UPDATE'
) {
  let rows: { pid: number; locktype: string; transactionid: string | null; blockers: number[] }[] =
    []
  await expect
    .poll(
      async () => {
        rows = (
          await root.query(
            `SELECT a.pid,l.locktype,l.transactionid::text,pg_blocking_pids(a.pid) AS blockers
       FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid AND NOT l.granted
       WHERE a.datname=current_database() AND a.usename=$1 AND a.wait_event_type='Lock'
         AND a.query LIKE $2`,
            [adminLogin, queryPattern]
          )
        ).rows
        return new Set(rows.map((r) => r.pid)).size
      },
      { timeout: 1500, interval: 20 }
    )
    .toBe(count)
  expect(
    rows.some(
      (r) =>
        r.locktype === 'transactionid' &&
        r.transactionid === lock.xid &&
        r.blockers.includes(lock.pid)
    )
  ).toBe(true)
  expect(rows.every((r) => r.blockers.length > 0)).toBe(true)
  return rows
}

async function calibrationRun(): Promise<string> {
  return (
    await new Administration(admins[0], publication.textGeneratorVersion).freezeEvaluation(
      'A',
      'account-A',
      { publication, plan }
    )
  ).runId
}
function declarationRequest(runId: string) {
  return {
    tenantId: 'A',
    accountId: 'account-A',
    runId,
    settings: {
      candidates: [publication.policy],
      targets: {
        maximumErrorReleaseRate: 0.01,
        minimumAutomaticCoverage: 0.5,
        minimumAutomaticReplies: 30
      }
    }
  }
}
/** An ordinary administrator keeps the real write transaction uncommitted while
 * another actual backend reaches the account lock. No clock sleeps infer order. */
async function openAdminTransaction() {
  const client = await admins[0].pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    await client.query("SELECT set_config('app.tenant_id','A',true)")
    const state = (await client.query('SELECT pg_backend_pid() AS pid,txid_current()::text AS xid'))
      .rows[0]
    let released = false
    const db = Object.assign(Object.create(admins[0]), {
      transaction: async <T>(
        _tenant: string,
        operation: (client: PoolClient) => Promise<T>
      ): Promise<T> => operation(client)
    }) as Postgres
    return {
      ...state,
      db,
      release: async (commit: boolean): Promise<void> => {
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

describe('real PostgreSQL candidate predeclaration concurrency', () => {
  it.each(['same', 'changed'] as const)(
    'serializes two %s grids with one immutable record',
    async (kind) => {
      const runId = await calibrationRun(),
        request = declarationRequest(runId)
      const changed = structuredClone(request)
      if (kind === 'changed') changed.settings.targets.maximumErrorReleaseRate += 0.01
      const services = admins.map(
        (db) => new JevCalibrationDeclarations(db, publication.textGeneratorVersion)
      )
      const lock = await holdAccount()
      const pending = Promise.allSettled([
        services[0].declare(request),
        services[1].declare(changed)
      ])
      try {
        const blocked = await waitForAccountLocks(
          lock,
          2,
          'SELECT employee_id,platform,enabled FROM accounts%FOR UPDATE'
        )
        expect(new Set(blocked.map((row) => row.pid)).size).toBe(2)
        await lock.release(true)
        const results = await pending
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(
          kind === 'same' ? 2 : 1
        )
        if (kind === 'same') expect(results[0]).toEqual(results[1])
        else
          expect(results.find((result) => result.status === 'rejected')).toMatchObject({
            status: 'rejected',
            reason: { message: 'jev_calibration_declaration_changed' }
          })
        expect(
          (await root.query('SELECT count(*)::int AS n FROM jev_calibration_declarations')).rows[0]
            .n
        ).toBe(1)
      } finally {
        await lock.release(false)
        await pending
      }
    }
  )
  it.each(['declaration', 'execution'] as const)(
    'keeps the %s transaction first while the other backend waits',
    async (first) => {
      const runId = await calibrationRun(),
        request = declarationRequest(runId)
      const lock = await openAdminTransaction()
      const begin = (db: Postgres) =>
        new JevReplayJournal(db, publication.textGeneratorVersion).begin({
          tenantId: 'A',
          accountId: 'account-A',
          runId,
          fullRawCases: input,
          maxRunAttempts: 10
        })
      let pending: Promise<PromiseSettledResult<unknown>[]> | undefined
      try {
        if (first === 'declaration')
          await new JevCalibrationDeclarations(lock.db, publication.textGeneratorVersion).declare(
            request
          )
        else expect((await begin(lock.db)).input.cases).toHaveLength(200)
        pending = Promise.allSettled([
          first === 'declaration'
            ? begin(admins[1])
            : new JevCalibrationDeclarations(admins[1], publication.textGeneratorVersion).declare(
                request
              )
        ])
        await waitForAccountLocks(
          lock,
          1,
          'SELECT employee_id,platform,enabled FROM accounts%FOR UPDATE'
        )
        await lock.release(true)
        const [result] = await pending
        if (first === 'declaration') {
          expect(result.status).toBe('fulfilled')
          const receipt = await new JevCalibrationDeclarations(
            admins[1],
            publication.textGeneratorVersion
          ).verify(request)
          const execution = (await root.query('SELECT created_at FROM jev_replay_executions'))
            .rows[0]
          expect(new Date(execution.created_at).getTime()).toBeGreaterThanOrEqual(
            Date.parse(receipt.declaredAt)
          )
        } else
          expect(result).toMatchObject({
            status: 'rejected',
            reason: { message: 'jev_calibration_declaration_too_late' }
          })
        expect(
          (await root.query('SELECT count(*)::int AS n FROM jev_replay_executions')).rows[0].n
        ).toBe(1)
        expect(
          (await root.query('SELECT count(*)::int AS n FROM jev_replay_attempts')).rows[0].n
        ).toBe(0)
      } finally {
        await lock.release(false)
        if (pending) await pending
      }
    }
  )
})

describe('real PostgreSQL Jev replay journal concurrency', () => {
  it('allows either zero-call sealing or reservation to win the account lock, never both', async () => {
    const first = await prepare(0, true)
    await first.journal.setLimit('A', 'account-A', { dailyAttemptLimit: 10 })
    const other = new JevReplayJournal(admins[1], publication.textGeneratorVersion)
    const evaluate = vi.fn(async () => {
      throw new Error('model_call_forbidden')
    })
    const generate = vi.fn(async () => {
      throw new Error('model_call_forbidden')
    })
    const artifact = await executeJevReplayArm(
      'A',
      {
        frozen: first.prepared.source,
        caseInput: first.prepared.input.cases[0],
        identity: {
          ...first.prepared.source.authenticatedScope,
          agentId: 'synthetic-agent',
          loginEpoch: 1,
          clientInstanceId: 'synthetic-process'
        }
      },
      {
        decision: { evaluate },
        generator: { generate },
        textGeneratorVersion: publication.textGeneratorVersion,
        expectedTextModel: 'synthetic-text',
        readAttempts: () => first.journal.readAttempts(first.binding)
      },
      undefined,
      first.assignment.assignmentId
    )
    expect(artifact).toMatchObject({
      status: 'handoff',
      reasons: ['explicit_human_request'],
      attempts: [],
      wouldRelease: false,
      releaseAuthorized: false
    })
    expect(evaluate).not.toHaveBeenCalled()
    expect(generate).not.toHaveBeenCalled()

    const lock = await holdAccount()
    const pending = Promise.allSettled([
      first.journal.sealArtifact(first.binding, artifact),
      other.reserve(first.binding, 'text', start)
    ])
    try {
      expect(new Set((await waitForAccountLocks(lock, 2)).map((r) => r.pid)).size).toBe(2)
      await lock.release(true)
      const outcomes = await pending
      expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      expect(outcomes.filter((r) => r.status === 'rejected')).toEqual([
        { status: 'rejected', reason: expect.objectContaining({ code: 'RECORD_UNAVAILABLE' }) }
      ])
      const counts = (
        await root.query(
          `SELECT
        (SELECT count(*) FROM jev_replay_attempts WHERE assignment_id=$1)::int AS attempts,
        (SELECT count(*) FROM jev_replay_artifact_seals WHERE assignment_id=$1)::int AS seals,
        (SELECT count(*) FROM jev_replay_results r JOIN jev_replay_attempts t ON
          (t.tenant_id,t.account_id,t.id)=(r.tenant_id,r.account_id,r.attempt_id)
          WHERE t.assignment_id=$1)::int AS results`,
          [first.binding.assignmentId]
        )
      ).rows[0]
      if (outcomes[0].status === 'fulfilled') {
        expect(outcomes[1].status).toBe('rejected')
        expect(counts).toEqual({ attempts: 0, seals: 1, results: 0 })
        const seal = (
          await root.query(
            'SELECT artifact_hash,ledger_hash,attempt_count FROM jev_replay_artifact_seals WHERE assignment_id=$1',
            [first.binding.assignmentId]
          )
        ).rows[0]
        expect(seal).toEqual({
          artifact_hash: hashContext(artifact),
          ledger_hash: hashContext([]),
          attempt_count: 0
        })
        await expect(other.reserve(first.binding, 'text', start)).rejects.toMatchObject({
          code: 'RECORD_UNAVAILABLE'
        })
      } else {
        expect(outcomes[1].status).toBe('fulfilled')
        expect(counts).toEqual({ attempts: 1, seals: 0, results: 0 })
        expect(await first.journal.readAttempts(first.binding)).toEqual([
          expect.objectContaining({ stage: 'text', start, result: null })
        ])
        await expect(first.journal.sealArtifact(first.binding, artifact)).rejects.toMatchObject({
          code: 'RECORD_UNAVAILABLE'
        })
      }
    } finally {
      await lock.release(false)
      await pending
    }
  })

  it('serializes different frozen runs on one account and admits exactly one daily-limit attempt', async () => {
    const first = await prepare(0),
      second = await prepare(1)
    expect(first.assignment.runId).not.toBe(second.assignment.runId)
    await first.journal.setLimit('A', 'account-A', { dailyAttemptLimit: 1 })
    const lock = await holdAccount()
    const pending = Promise.allSettled([
      first.journal.reserve(first.binding, 'text', start),
      second.journal.reserve(second.binding, 'text', start)
    ])
    try {
      const waiting = await waitForAccountLocks(lock, 2)
      expect(new Set(waiting.map((r) => r.pid)).size).toBe(2)
      expect(
        (await lock.client.query('SELECT count(*)::int AS n FROM jev_replay_attempts')).rows[0].n
      ).toBe(0)
      await lock.release(true)
      const outcomes = await pending
      expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      expect(outcomes.filter((r) => r.status === 'rejected')).toEqual([
        { status: 'rejected', reason: expect.objectContaining({ code: 'LIMIT_REACHED' }) }
      ])
      expect(
        (await root.query('SELECT count(*)::int AS n FROM jev_replay_attempts')).rows[0].n
      ).toBe(1)
      expect(
        (await root.query('SELECT count(*)::int AS n FROM jev_replay_executions')).rows[0].n
      ).toBe(2)
    } finally {
      await lock.release(false)
      await pending
    }
  })

  it('reads committed pending attempts through a fresh journal and refuses to pay for them again', async () => {
    const first = await prepare(0)
    await first.journal.setLimit('A', 'account-A', { dailyAttemptLimit: 10 })
    await first.journal.reserve(first.binding, 'text', start)
    const restarted = new JevReplayJournal(admins[1], publication.textGeneratorVersion)
    const resumed = await restarted.begin({
      tenantId: 'A',
      accountId: 'account-A',
      runId: first.assignment.runId,
      fullRawCases: input,
      maxRunAttempts: 10
    })
    expect(resumed.executionId).toBe(first.prepared.executionId)
    expect(await restarted.bindAssignment(first.assignment)).toEqual(first.binding)
    expect(await restarted.readAttempts(first.binding)).toEqual([
      expect.objectContaining({ stage: 'text', start, result: null })
    ])
    await expect(restarted.reserve(first.binding, 'text', start)).rejects.toMatchObject({
      code: 'RECORD_UNAVAILABLE'
    })
    const counts = (
      await root.query(`SELECT
      (SELECT count(*) FROM jev_replay_executions)::int AS executions,
      (SELECT count(*) FROM jev_replay_assignments)::int AS assignments,
      (SELECT count(*) FROM jev_replay_attempts)::int AS attempts,
      (SELECT count(*) FROM jev_replay_results)::int AS results`)
    ).rows[0]
    expect(counts).toEqual({ executions: 1, assignments: 1, attempts: 1, results: 0 })
  })

  it('rechecks disablement and a new pause head after lock waits but can finish the existing receipt', async () => {
    for (const change of ['disabled', 'pause-head'] as const) {
      await root.query("UPDATE accounts SET enabled=true WHERE tenant_id='A' AND id='account-A'")
      const first = await prepare(0)
      await first.journal.setLimit('A', 'account-A', { dailyAttemptLimit: 10 })
      const receipt = await first.journal.reserve(first.binding, 'text', start)
      const next = await first.journal.bindAssignment({
        ...first.assignment,
        caseId: 'case-101',
        assignmentId: randomUUID()
      })
      const other = new JevReplayJournal(admins[1], publication.textGeneratorVersion)
      const lock = await holdAccount(),
        pending = Promise.allSettled([other.reserve(next, 'text', start)])
      try {
        await waitForAccountLocks(lock, 1)
        if (change === 'disabled')
          await lock.client.query(
            "UPDATE accounts SET enabled=false WHERE tenant_id='A' AND id='account-A'"
          )
        else await requestAccountPause(lock.client, 'A', 'account-A', 'admin-A', randomUUID())
        await lock.release(true)
        expect(await pending).toEqual([
          { status: 'rejected', reason: expect.objectContaining({ code: 'RECORD_UNAVAILABLE' }) }
        ])
        await receipt.finish(response)
        expect(await other.readAttempts(first.binding)).toEqual([
          expect.objectContaining({ stage: 'text', start, result: response })
        ])
        expect(await other.readAttempts(next)).toEqual([])
        expect(
          (
            await root.query(
              'SELECT count(*)::int AS n FROM jev_replay_attempts WHERE assignment_id=$1',
              [first.binding.assignmentId]
            )
          ).rows[0].n
        ).toBe(1)
      } finally {
        await lock.release(false)
        await pending
      }
    }
  })
})
