import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { embeddedPostgres } from '../fixtures/embedded-postgres'
import { Administration } from '../../server/src/admin/administration'
import { createAdminGateway } from '../../server/src/admin/gateway'
import { AdminConnection } from '../../src/main/services/admin-connection'
import { FileAdminPauseJournal } from '../../src/main/services/admin-pause-journal'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

const token = 'G'.repeat(43)
let pg: Awaited<ReturnType<typeof embeddedPostgres>>, server: Server, url: string
async function root(sql: string) {
  await pg.sql.exec('SET SESSION AUTHORIZATION postgres;RESET ROLE')
  await pg.sql.exec(sql)
}
async function login() {
  await pg.sql.exec('SET SESSION AUTHORIZATION gateway_admin')
}
async function call(
  input: unknown,
  headers: Record<string, string> = {},
  path = '/v1/admin/operations',
  method = 'POST'
) {
  const response = await fetch(url + path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
    ...(method === 'GET' ? {} : { body: JSON.stringify(input) })
  })
  return { status: response.status, body: await response.json() }
}
beforeAll(async () => {
  pg = await embeddedPostgres()
  await root(`CREATE ROLE gateway_admin LOGIN NOSUPERUSER NOBYPASSRLS;GRANT autoreply_admin TO gateway_admin;
    INSERT INTO tenants VALUES('A','synthetic A'),('B','synthetic B');
    INSERT INTO employees(tenant_id,id,role) VALUES('A','admin','admin'),('A','employee','employee'),('B','employee','employee');
    INSERT INTO admin_database_principals VALUES('gateway_admin','A','admin');
    INSERT INTO accounts(tenant_id,id,employee_id,platform,paused) VALUES('A','account','employee','wework',false),('B','account','employee','wechat',false);
    INSERT INTO agents(tenant_id,id,account_id,employee_id,token_hash) VALUES('A','agent','account','employee','synthetic'),('B','agent','account','employee','foreign')`)
  server = createServer(createAdminGateway(new Administration(pg.db), { tenantId: 'A', token }))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing_test_address')
  url = `http://127.0.0.1:${address.port}`
}, 20000)
beforeEach(async () => {
  await root(`TRUNCATE tenant_pause_batches,account_pause_requests,audit_events CASCADE;
    UPDATE accounts SET paused=false;UPDATE employees SET enabled=true,role=CASE WHEN id='admin' THEN 'admin' ELSE 'employee' END`)
  await login()
})
afterAll(async () => {
  if (server)
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
  await pg?.db.close()
})
it('uses the actual mapped operator identity and returns only this tenant device inventory', async () => {
  expect(await call({ operation: 'identity' })).toEqual({
    status: 200,
    body: { result: { tenantId: 'A', actorId: 'admin' } }
  })
  const runtime = await call({ operation: 'runtime-status', input: {} })
  expect(runtime.status).toBe(200)
  expect(runtime.body.result).toMatchObject({
    totalDevices: 1,
    rows: [
      {
        accountId: 'account',
        agentId: 'agent',
        canAuthorizeSend: false,
        physicalStopVerified: false
      }
    ]
  })
  const desktop = new AdminConnection(fetch, true)
  expect((await desktop.connect({ serverUrl: url, token })).success).toBe(true)
  expect(await desktop.runtime({})).toMatchObject({ success: true, value: { totalDevices: 1 } })
  const requestId = randomUUID()
  expect(await desktop.pauseAll({ requestId })).toMatchObject({
    success: true,
    value: { requestId, accountCount: 1 }
  })
  expect(await desktop.pauseAccounts({ requestId, page: {} })).toMatchObject({
    success: true,
    value: { rows: [{ accountId: 'account', active: true }] }
  })
  expect((await desktop.status()).latestPause).toEqual({ requestId, confirmed: true })
  await desktop.disconnect()
})
it('pauses and pages a fixed batch through HTTP, keeps foreign accounts running, and retries without new audits', async () => {
  const requestId = randomUUID(),
    input = { operation: 'request-pause-all', requestId }
  const first = await call(input)
  expect(first).toMatchObject({
    status: 200,
    body: { result: { requestId, accountCount: 1, activeAccounts: 1, canAuthorizeSend: false } }
  })
  expect(await call(input)).toEqual(first)
  expect(await call({ operation: 'pause-all-request', requestId })).toEqual(first)
  expect(
    await call({ operation: 'pause-all-accounts', requestId, input: { limit: 1 } })
  ).toMatchObject({
    status: 200,
    body: { result: { rows: [{ accountId: 'account', active: true }], nextCursor: null } }
  })
  await root('SELECT 1')
  expect(
    (await pg.sql.query('SELECT tenant_id,paused FROM accounts ORDER BY tenant_id')).rows
  ).toEqual([
    { tenant_id: 'A', paused: true },
    { tenant_id: 'B', paused: false }
  ])
  expect((await pg.sql.query('SELECT count(*)::int AS n FROM audit_events')).rows).toEqual([
    { n: 2 }
  ])
})
it('rechecks administrator disable and role removal on every operation', async () => {
  await root("UPDATE employees SET enabled=false WHERE id='admin'")
  await login()
  expect(await call({ operation: 'request-pause-all', requestId: randomUUID() })).toEqual({
    status: 403,
    body: { code: 'denied' }
  })
  await root("UPDATE employees SET enabled=true,role='employee' WHERE id='admin'")
  await login()
  expect(await call({ operation: 'identity' })).toEqual({ status: 403, body: { code: 'denied' } })
})
it('denies employee credentials, browser origins, tenant selection, arbitrary commands and missing retry identifiers', async () => {
  expect(
    await call({ operation: 'identity' }, { authorization: `Bearer ${'A'.repeat(43)}` })
  ).toEqual({ status: 401, body: { code: 'unauthorized' } })
  expect(await call({ operation: 'identity' }, { origin: 'https://operator.invalid' })).toEqual({
    status: 403,
    body: { code: 'origin_rejected' }
  })
  for (const input of [
    { operation: 'identity', tenantId: 'B' },
    { operation: 'resume', accountId: 'account' },
    { operation: 'request-pause-all' },
    { operation: 'runtime-status', input: { limit: 101 } }
  ]) {
    expect(await call(input)).toEqual({ status: 400, body: { code: 'invalid_input' } })
  }
  expect((await call({ operation: 'identity' }, {}, '/v1/admin/operations?tenant=B')).status).toBe(
    404
  )
  expect((await call({}, {}, '/v1/admin/operations', 'GET')).status).toBe(405)
  expect((await call({}, { 'content-type': 'text/plain' })).status).toBe(415)
})
it('bounds input size, rejects malformed UTF-8 and returns safe absent-batch and cursor errors', async () => {
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  for (const bytes of [Buffer.from('{'), Buffer.from([123, 34, 120, 34, 58, 34, 0xff, 34, 125])]) {
    const r = await fetch(url + '/v1/admin/operations', { method: 'POST', headers, body: bytes })
    expect(r.status).toBe(400)
    expect(await r.json()).toEqual({ code: 'invalid_json' })
  }
  expect((await call({ operation: 'identity', junk: 'x'.repeat(17000) })).status).toBe(413)
  expect(await call({ operation: 'pause-all-request', requestId: randomUUID() })).toEqual({
    status: 404,
    body: { code: 'pause_not_found' }
  })
  const requestId = randomUUID()
  await call({ operation: 'request-pause-all', requestId })
  const after = Buffer.from(
    JSON.stringify({ version: 1, tenantId: 'B', requestId, afterAccount: 'account' })
  ).toString('base64url')
  expect(await call({ operation: 'pause-all-accounts', requestId, input: { after } })).toEqual({
    status: 400,
    body: { code: 'invalid_cursor' }
  })
})
it('reopens the actual SQLite desktop journal after a committed HTTP reply is lost without duplicating SQL effects', async () => {
  const rootDirectory = await mkdtemp(join(tmpdir(), 'autoreply-gateway-pause-')),
    directory = join(rootDirectory, 'journal'),
    requestId = randomUUID()
  const journal = new FileAdminPauseJournal(directory)
  let reopened: FileAdminPauseJournal | undefined
  const calls: string[] = []
  const loseReply: typeof fetch = async (input, init) => {
    const operation = JSON.parse(String(init?.body)).operation
    const response = await fetch(input, init)
    if (operation === 'request-pause-all') {
      expect(response.status).toBe(200)
      await response.arrayBuffer()
      throw new Error('synthetic_lost_reply_after_commit')
    }
    return response
  }
  const desktop = new AdminConnection(loseReply, true, journal)
  if (
    !resolve(rootDirectory).startsWith(resolve(tmpdir()) + sep) ||
    !rootDirectory.includes('autoreply-gateway-pause-')
  )
    throw new Error('unsafe_test_cleanup')
  try {
    await desktop.connect({ serverUrl: url, token })
    expect(await desktop.pauseAll({ requestId })).toEqual({
      success: false,
      code: 'operation_unconfirmed'
    })
    await desktop.close()
    reopened = new FileAdminPauseJournal(directory)
    const observed: typeof fetch = async (input, init) => {
      calls.push(JSON.parse(String(init?.body)).operation)
      return fetch(input, init)
    }
    const recovered = new AdminConnection(observed, true, reopened)
    expect(await recovered.connect({ serverUrl: url, token })).toMatchObject({
      success: true,
      value: { latestPause: { requestId, confirmed: false, recovered: true } }
    })
    expect(calls).toEqual(['identity'])
    expect((await recovered.pauseAll({ requestId })).success).toBe(true)
    expect((await recovered.pauseAll({ requestId })).success).toBe(true)
    expect(calls).toEqual(['identity', 'request-pause-all', 'pause-all-request'])
    await recovered.close()
    await root('SELECT 1')
    expect(
      (await pg.sql.query('SELECT count(*)::int AS n FROM tenant_pause_batches')).rows
    ).toEqual([{ n: 1 }])
    expect((await pg.sql.query('SELECT count(*)::int AS n FROM audit_events')).rows).toEqual([
      { n: 2 }
    ])
    expect((await pg.sql.query("SELECT paused FROM accounts WHERE tenant_id='B'")).rows).toEqual([
      { paused: false }
    ])
  } finally {
    await desktop.close()
    await reopened?.close()
    await rm(rootDirectory, { recursive: true, force: true })
  }
})
it('does not expose internal database diagnostics on failure', async () => {
  await root('DROP TABLE tenant_pause_batches CASCADE')
  await login()
  expect(await call({ operation: 'request-pause-all', requestId: randomUUID() })).toEqual({
    status: 503,
    body: { code: 'operation_unconfirmed' }
  })
})
