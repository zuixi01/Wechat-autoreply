import { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Postgres } from '../../server/src/database/postgres'
import { tokenHash } from '../../server/src/auth/account-authority'
import { enterpriseAutomaticIteration } from '../fixtures/enterprise-automatic-iteration'

let cluster: Pool, root: Pool
let appDb: Postgres, adminDb: Postgres, workerDb: Postgres
let sequence: ReturnType<typeof enterpriseAutomaticIteration> | undefined
let database: string
const credential = 'I'.repeat(43)

beforeAll(async () => {
  const url = new URL(process.env.AUTOREPLY_POSTGRES_TEST_URL ?? 'about:blank')
  const password = process.env.AUTOREPLY_POSTGRES_TEST_PASSWORD ?? ''
  if (
    url.hostname !== '127.0.0.1' ||
    url.username !== 'postgres' ||
    !/^\/autoreply_concurrency_[a-f0-9]{32}$/.test(url.pathname) ||
    !/^[a-f0-9]{64}$/.test(password) ||
    !process.env.AUTOREPLY_POSTGRES_TEST_REPORT
  )
    throw new Error('use_isolated_postgres_runner')
  const suffix = randomUUID().replaceAll('-', '')
  database = `iteration_${suffix}`
  const logins = {
    app: `iteration_app_${suffix}`,
    admin: `iteration_admin_${suffix}`,
    worker: `iteration_worker_${suffix}`
  }
  cluster = new Pool({ connectionString: url.href, max: 1 })
  await cluster.query(`CREATE DATABASE ${database}`)
  const isolated = new URL(url)
  isolated.pathname = `/${database}`
  root = new Pool({
    connectionString: isolated.href,
    max: 5,
    options: '-c search_path=autoreply,public'
  })
  for (const file of (await readdir(resolve('server/migrations')))
    .filter((file) => /^\d{3}-.+\.sql$/.test(file))
    .sort()) {
    const sql = await readFile(resolve('server/migrations', file), 'utf8')
    await root.query(sql)
    await root.query(sql)
  }
  for (const [kind, login] of Object.entries(logins)) {
    const role =
      kind === 'worker'
        ? 'autoreply_learning_worker'
        : kind === 'admin'
          ? 'autoreply_admin'
          : 'autoreply_app'
    // The name is UUID hexadecimal and the password is validated hexadecimal.
    await root.query(
      `CREATE ROLE ${login} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB PASSWORD '${password}'; GRANT ${role} TO ${login}`
    )
  }
  await root.query(`INSERT INTO tenants(id,name) VALUES('company','合成自动学习企业');
    INSERT INTO employees(tenant_id,id,role) VALUES('company','admin','admin'),('company','employee-A','employee');
    INSERT INTO accounts(tenant_id,id,employee_id,platform,paused) VALUES('company','account-A','employee-A','wework',false);`)
  await root.query(
    'INSERT INTO admin_database_principals(login_name,tenant_id,employee_id) VALUES($1,$2,$3)',
    [logins.admin, 'company', 'admin']
  )
  await root.query(
    'INSERT INTO agents(tenant_id,id,account_id,employee_id,token_hash) VALUES($1,$2,$3,$4,$5)',
    ['company', 'agent-A', 'account-A', 'employee-A', tokenHash(credential)]
  )
  await root.query(
    "INSERT INTO account_leases(tenant_id,account_id,agent_id,login_epoch,client_instance_id,version,expires_at) VALUES('company','account-A','agent-A',1,'process-A',1,clock_timestamp()+interval '60 seconds')"
  )
  const connection = (login: string): string => {
    const copy = new URL(isolated)
    copy.username = login
    copy.password = password
    return copy.href
  }
  appDb = new Postgres(connection(logins.app))
  adminDb = new Postgres(connection(logins.admin))
  workerDb = new Postgres(connection(logins.worker))
  sequence = enterpriseAutomaticIteration(root, appDb, adminDb, workerDb, credential, logins.worker)
})

afterAll(async () => {
  await sequence?.return(true)
  await Promise.allSettled([appDb?.close(), adminDb?.close(), workerDb?.close(), root?.end()])
  if (cluster && /^iteration_[a-f0-9]{32}$/.test(database))
    await cluster.query(`DROP DATABASE ${database}`)
  await cluster?.end()
})

/** The two full calibrations each perform 31 actual HTTP calls with database
 * authorization and accounting. Their 30-second bounds are background test
 * deadlines, not a foreground latency SLA; other phases retain 10 seconds. */
describe('actual PostgreSQL automatic learning and publication', () => {
  it('generates a real draft and learns a pending V1 from its actual correction', async () => {
    expect(await sequence!.next()).toEqual({ done: false, value: 'pending-v1' })
  })
  it('automatically validates five independent engineering cases and rejects the old publication', async () => {
    expect(await sequence!.next()).toEqual({ done: false, value: 'validated-v1' })
  }, 30000)
  it('publishes V1, uses it in generation and automatically proposes V2 from the new correction', async () => {
    expect(await sequence!.next()).toEqual({ done: false, value: 'pending-v2' })
  })
  it('keeps V1 during pending V2 and validates V2 before requiring a new publication', async () => {
    expect(await sequence!.next()).toEqual({ done: false, value: 'validated-v2' })
  }, 30000)
  it('uses freshly published V2 and records rollback as revision 3', async () => {
    expect(await sequence!.next()).toEqual({ done: false, value: 'rollback-v3' })
  })
  it('uses the freshly published rollback and retains exact references without send permits', async () => {
    expect(await sequence!.next()).toEqual({ done: true, value: true })
  })
})
