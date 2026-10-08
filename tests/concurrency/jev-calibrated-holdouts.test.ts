import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { Postgres } from '../../server/src/database/postgres'
import {
  registerJevCalibratedHoldoutTests,
  type JevHoldoutReadyContext
} from '../fixtures/jev-calibrated-holdout-suite'
import { JevCalibratedHoldouts } from '../../server/src/generation/jev-calibrated-holdouts'
import { JevReplayJournal } from '../../server/src/generation/jev-replay-journal'

let operator: Postgres, adminConnection: string

// Run the same full protocol assertions against native PostgreSQL. Switching
// principals selects independent pools authenticated by actual wire LOGIN;
// SET ROLE / SET SESSION AUTHORIZATION never impersonates a reviewer here.
registerJevCalibratedHoldoutTests(async () => {
  const uri = process.env.AUTOREPLY_POSTGRES_TEST_URL
  const password = process.env.AUTOREPLY_POSTGRES_TEST_PASSWORD
  if (
    !uri ||
    !password ||
    !/^[a-f0-9]{64}$/.test(password) ||
    !process.env.AUTOREPLY_POSTGRES_TEST_REPORT
  )
    throw new Error('use_isolated_postgres_runner')
  const url = new URL(uri)
  if (
    url.hostname !== '127.0.0.1' ||
    url.username !== 'postgres' ||
    !/^\/autoreply_concurrency_[a-f0-9]{32}$/.test(url.pathname)
  )
    throw new Error('use_isolated_postgres_runner')
  const cluster = new Postgres(url.href)
  const database = `jev_holdout_${randomUUID().replaceAll('-', '')}`
  await cluster.pool.query(`CREATE DATABASE ${database}`)
  url.pathname = `/${database}`
  const root = new Postgres(url.href)
  operator = root
  const logins = new Map<string, Postgres>()
  let current = root
  const errors: string[] = []
  const observe = (error: unknown) =>
    errors.push(
      typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : 'database_error'
    )
  root.pool.on('error', observe)
  cluster.pool.on('error', observe)
  async function close(): Promise<void> {
    await Promise.all([root.close(), ...[...logins.values()].map((db) => db.close())])
    // Ended pools can precede server socket shutdown; inspect actual backends.
    for (let n = 0; n < 100; n++) {
      const result = await cluster.pool.query(
        'SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1',
        [database]
      )
      if (result.rows[0].count === 0) break
      if (n === 99) throw new Error('holdout_test_connections_not_closed')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    await cluster.pool.query(`DROP DATABASE ${database}`)
    for (const name of logins.keys()) await cluster.pool.query(`DROP ROLE ${name}`)
    await cluster.close()
    expect(errors).toEqual([])
  }
  const db = {
    get pool() {
      return current.pool
    },
    transaction: <T>(tenant: string, operation: (client: PoolClient) => Promise<T>) =>
      current.transaction(tenant, operation),
    close
  } as Postgres
  try {
    const files = (await readdir('server/migrations'))
      .filter((name) => /^\d{3}-.*\.sql$/.test(name) && Number(name.slice(0, 3)) <= 44)
      .sort()
    expect(files).toHaveLength(44)
    for (const name of files) {
      const source = await readFile(`server/migrations/${name}`, 'utf8')
      await root.pool.query(source)
      await root.pool.query(source)
    }
    return {
      db,
      sql: {
        async exec(statement: string) {
          if (statement === 'SET SESSION AUTHORIZATION postgres; RESET ROLE') {
            current = root
            return
          }
          const login =
            /^SET SESSION AUTHORIZATION postgres; RESET ROLE; SET SESSION AUTHORIZATION (holdout_fixture_(?:admin|reviewer))$/.exec(
              statement
            )?.[1]
          if (login) {
            let selected = logins.get(login)
            if (!selected) {
              // Names are fixed fixture constants, never caller inputs.
              await root.pool.query(`ALTER ROLE ${login} PASSWORD '${password}'`).catch(() => {
                throw new Error('fixture_login_password_setup_failed')
              })
              const loginUrl = new URL(url.href)
              loginUrl.username = login
              loginUrl.password = password
              if (login === 'holdout_fixture_admin') adminConnection = loginUrl.href
              selected = new Postgres(loginUrl.href)
              selected.pool.on('error', observe)
              logins.set(login, selected)
              const actual = (
                await selected.pool.query(
                  'SELECT session_user AS login,pg_backend_pid() AS pid,r.rolsuper,r.rolbypassrls FROM pg_roles r WHERE r.rolname=session_user'
                )
              ).rows[0]
              expect(actual).toMatchObject({ login, rolsuper: false, rolbypassrls: false })
              const operator = (await root.pool.query('SELECT pg_backend_pid() AS pid')).rows[0]
              expect(actual.pid).not.toBe(operator.pid)
            }
            current = selected
            return
          }
          if (statement.includes('SET SESSION AUTHORIZATION') || statement.includes('SET ROLE'))
            throw new Error('fixture_impersonation_forbidden')
          return current.pool.query(statement)
        }
      }
    }
  } catch (error) {
    await close()
    throw error
  }
}, registerRaces)

async function openOrdinaryTransaction(db: Postgres) {
  const client = await db.pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    await client.query("SELECT set_config('app.tenant_id','A',true)")
    const identity = (
      await client.query(
        'SELECT session_user AS login,pg_backend_pid() AS pid,txid_current()::text AS xid'
      )
    ).rows[0]
    expect(identity.login).toBe('holdout_fixture_admin')
    const bound = Object.assign(Object.create(db), {
      transaction: async <T>(_tenant: string, operation: (client: PoolClient) => Promise<T>) =>
        operation(client)
    }) as Postgres
    let released = false
    return {
      ...identity,
      db: bound,
      release: async (commit: boolean) => {
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
async function observeBlocked(lock: { pid: number; xid: string }) {
  let rows: { pid: number; xid: string; blockers: number[] }[] = []
  await expect
    .poll(
      async () => {
        rows = (
          await operator.pool
            .query(`SELECT a.pid,l.transactionid::text AS xid,pg_blocking_pids(a.pid) AS blockers
      FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid AND NOT l.granted
      WHERE a.datname=current_database() AND a.usename='holdout_fixture_admin' AND a.wait_event_type='Lock'
        AND a.query LIKE 'SELECT%FROM accounts%FOR UPDATE'`)
        ).rows
        return rows.length
      },
      { timeout: 1500, interval: 20 }
    )
    .toBeGreaterThan(0)
  expect(
    rows.some(
      (row) => row.pid !== lock.pid && row.xid === lock.xid && row.blockers.includes(lock.pid)
    )
  ).toBe(true)
}
function registerRaces(context: () => JevHoldoutReadyContext): void {
  describe('native full-evidence holdout transaction ordering', () => {
    it.each(['freeze', 'execution', 'retry'] as const)(
      'commits %s first while a distinct backend waits on the actual account lock',
      async (order) => {
        const { request, generatorVersion, holdoutInput } = context()
        const first = new Postgres(adminConnection),
          second = new Postgres(adminConnection)
        const lock = await openOrdinaryTransaction(first)
        let pending: Promise<PromiseSettledResult<unknown>> | undefined
        try {
          const freeze = (db: Postgres) =>
            new JevCalibratedHoldouts(db, generatorVersion).freeze(request)
          const begin = (db: Postgres, runId = request.runId) =>
            new JevReplayJournal(db, generatorVersion).begin({
              tenantId: request.tenantId,
              accountId: request.accountId,
              runId,
              fullRawCases: holdoutInput,
              maxRunAttempts: 1000
            })
          const initial = order === 'execution' ? await begin(lock.db) : await freeze(lock.db)
          pending = Promise.allSettled([order === 'freeze' ? begin(second) : freeze(second)]).then(
            (results) => results[0]
          )
          await observeBlocked(lock)
          await lock.release(true)
          const observed = await pending
          if (order === 'retry') {
            expect(observed.status).toBe('fulfilled')
            if (observed.status === 'fulfilled') expect(observed.value).toEqual(initial)
          } else {
            expect(observed).toMatchObject({
              status: 'rejected',
              reason: {
                message:
                  order === 'execution' ? 'jev_holdout_previously_exposed' : 'RECORD_UNAVAILABLE'
              }
            })
            if (order === 'freeze' && 'receipt' in initial)
              expect((await begin(second, initial.receipt.targetRunId)).input.cases).toHaveLength(
                200
              )
          }
          const stored = (
            await operator.pool
              .query(`SELECT (SELECT count(*)::int FROM autoreply.jev_holdout_lineages) AS lineages,
          (SELECT count(*)::int FROM autoreply.evaluation_runs) AS runs,
          (SELECT count(*)::int FROM autoreply.jev_replay_attempts) AS attempts,
          (SELECT count(*)::int FROM autoreply.evaluation_approvals) AS approvals,
          (SELECT count(*)::int FROM autoreply.execution_permits) AS permits`)
          ).rows[0]
          expect(stored).toEqual({
            lineages: order === 'execution' ? 0 : 1,
            runs: order === 'execution' ? 1 : 2,
            attempts: 600,
            approvals: 0,
            permits: 0
          })
        } finally {
          await lock.release(false)
          await pending
          await Promise.all([first.close(), second.close()])
        }
      }
    )
  })
}
