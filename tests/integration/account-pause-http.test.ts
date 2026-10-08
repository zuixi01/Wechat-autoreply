import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { embeddedPostgres } from '../fixtures/embedded-postgres'
import { listenFetchLoopback } from '../fixtures/fetch-loopback'
import { AccountAuthority, tokenHash } from '../../server/src/auth/account-authority'
import { AccountPauseAuthority } from '../../server/src/monitoring/account-pause-authority'
import { RuntimeStatusAuthority } from '../../server/src/monitoring/runtime-status-authority'
import { Administration } from '../../server/src/admin/administration'
import { createApplication } from '../../server/src/http/application'
import {
  AgentRegistration,
  type EncryptedDeviceRecord
} from '../../src/main/services/agent-registration'
import { DesktopAgentRuntime } from '../../src/main/services/desktop-agent-runtime'
import { Ledger } from '../../src/core/persistence/ledger'
import { hashContext } from '../../src/core/reply/hashes'
import {
  AccountPauseReportSchema,
  type AccountPauseChallenge
} from '../../src/shared/contracts/runtime-pause'
import { RuntimeObservationSchema } from '../../src/shared/contracts/runtime-monitoring'

let pg: Awaited<ReturnType<typeof embeddedPostgres>>, server: Server, base: string
const token = 'P'.repeat(43),
  requestId = randomUUID()
const scope = {
  tenant_id: 'A',
  employee_id: 'employee',
  account_id: 'account',
  agent_id: 'agent',
  platform: 'wework' as const
}
beforeAll(async () => {
  pg = await embeddedPostgres()
  await pg.adminExec(`CREATE ROLE pause_http_admin LOGIN NOSUPERUSER NOBYPASSRLS;GRANT autoreply_admin TO pause_http_admin;
    INSERT INTO tenants VALUES('A','synthetic');INSERT INTO employees(tenant_id,id,role) VALUES('A','admin','admin'),('A','employee','employee');
    INSERT INTO admin_database_principals VALUES('pause_http_admin','A','admin');
    INSERT INTO accounts(tenant_id,id,employee_id,platform) VALUES('A','account','employee','wework');
    INSERT INTO agents(tenant_id,id,account_id,employee_id,token_hash) VALUES('A','agent','account','employee','${tokenHash(token)}')`)
  await pg.sql.exec('SET SESSION AUTHORIZATION pause_http_admin')
  await new Administration(pg.db).requestPause('A', 'account', requestId)
  await pg.sql.exec('SET SESSION AUTHORIZATION postgres;SET ROLE autoreply_app')
  const authority = new AccountAuthority(pg.db)
  server = createServer(
    createApplication(authority, {
      monitoring: new RuntimeStatusAuthority(authority),
      accountPause: new AccountPauseAuthority(authority)
    })
  )
  base = await listenFetchLoopback(server)
}, 20000)
afterAll(async () => {
  server?.closeAllConnections()
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  await pg?.db.close()
})
function client(transport: typeof fetch = fetch) {
  let record: EncryptedDeviceRecord = {
    serverUrl: base,
    scope,
    encryptedCredential: 'synthetic-cipher'
  }
  const registration = new AgentRegistration(
    {
      load: () => record,
      save: (next) => {
        record = next
      }
    },
    { available: () => true, encrypt: () => 'synthetic-cipher', decrypt: () => token },
    transport,
    true
  )
  return {
    registration,
    replace: (next: EncryptedDeviceRecord) => {
      record = next
    }
  }
}
const input = () => ({
  requestId,
  attemptId: randomUUID(),
  runtime: { instanceId: randomUUID(), generation: 1 },
  instanceEpoch: 10
})
const report = (challenge: AccountPauseChallenge) => ({
  challenge,
  elapsedMs: 0,
  stopped: {
    observerStopped: true as const,
    senderQuiescent: true as const,
    settlementQuiescent: true as const,
    leaseStopped: true as const,
    platform: 'absent' as const
  }
})
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  })
describe('account pause through actual HTTP, private SDK and desktop lifecycle', () => {
  it('records a stopped generation, posts matching current state, and joins shutdown without reading or sending', async () => {
    const registration = client().registration,
      ledger = new Ledger(':memory:'),
      runtime = new DesktopAgentRuntime(ledger, registration)
    const confirmations = vi.spyOn(registration, 'confirmAccountPause'),
      status = vi.spyOn(registration, 'reportRuntimeStatus')
    try {
      runtime.configureMonitoring()
      await vi.waitFor(async () => {
        const rows = (
          await pg.adminQuery(
            `SELECT r.report_json,s.report_json AS current FROM account_pause_reports r JOIN device_runtime_status s USING(tenant_id,account_id,agent_id)`
          )
        ).rows
        expect(rows).toHaveLength(1)
        const row = rows[0] as Record<string, unknown>,
          current = RuntimeObservationSchema.parse(row.current),
          confirmation = AccountPauseReportSchema.parse(row.report_json)
        expect(current.runtimeContext).toEqual(confirmation.challenge.runtime)
        expect(current.status).toMatchObject({
          state: 'paused',
          lease: 'stopped',
          pauseAcknowledged: true
        })
      })
      expect(confirmations).toHaveBeenCalledOnce()
      expect(status).toHaveBeenCalledTimes(2)
      expect((await pg.adminQuery('SELECT * FROM account_leases')).rows).toEqual([])
      expect((await pg.adminQuery('SELECT * FROM execution_permits')).rows).toEqual([])
      expect((await pg.adminQuery('SELECT * FROM model_call_attempts')).rows).toEqual([])
      expect(await runtime.close()).toMatchObject({ state: 'closed' })
      expect(confirmations).toHaveBeenCalledOnce()
      expect(status).toHaveBeenCalledTimes(2)
    } finally {
      await runtime.close()
    }
  })
  it('enforces authentication, origin, bytes, strict purpose and obsolete request over HTTP', async () => {
    const path = '/v1/runtime/pause/challenge'
    expect((await post(path, input(), { Authorization: '' })).status).toBe(401)
    expect((await post(path, input(), { Origin: 'https://untrusted.example' })).status).toBe(403)
    expect((await post(path, { text: 'x'.repeat(9000) })).status).toBe(413)
    expect((await post(path, { ...input(), canAuthorizeSend: true })).status).toBe(400)
    expect((await post(path, { ...input(), requestId: randomUUID() })).status).toBe(409)
    const c = await client().registration.accountPauseChallenge(input())
    expect(
      (
        await post('/v1/runtime/pause/report', {
          ...report(c),
          challenge: { ...c, purpose: 'ledger_restore' }
        })
      ).status
    ).toBe(400)
    expect(await client().registration.confirmAccountPause(report(c))).toMatchObject({
      requestId,
      reportHash: hashContext(report(c)),
      physicalStopVerified: false,
      canAuthorizeSend: false
    })
  })
  it.each(['scope', 'attempt', 'runtime', 'epoch', 'authority'] as const)(
    'rejects forged challenge %s in the private SDK',
    async (field) => {
      const i = input(),
        c: AccountPauseChallenge = {
          ...i,
          purpose: 'account_pause',
          scope,
          challengeId: randomUUID(),
          issuedAt: 1,
          expiresAt: 30001
        }
      const forged =
        field === 'scope'
          ? { ...c, scope: { ...scope, account_id: 'other' } }
          : field === 'attempt'
            ? { ...c, attemptId: randomUUID() }
            : field === 'runtime'
              ? { ...c, runtime: { ...c.runtime, generation: 2 } }
              : field === 'epoch'
                ? { ...c, instanceEpoch: 11 }
                : { ...c, canAuthorizeSend: true }
      await expect(
        client(async () => Response.json(forged)).registration.accountPauseChallenge(i)
      ).rejects.toThrow('INVALID_RESPONSE')
    }
  )
  it('rejects a late confirmation receipt after registration changes', async () => {
    const i = input(),
      c: AccountPauseChallenge = {
        ...i,
        purpose: 'account_pause',
        scope,
        challengeId: randomUUID(),
        issuedAt: 1,
        expiresAt: 30001
      },
      body = report(c)
    let finish!: (response: Response) => void
    const f = client(
        () =>
          new Promise((resolve) => {
            finish = resolve
          })
      ),
      pending = f.registration.confirmAccountPause(body)
    f.replace({
      serverUrl: base,
      scope: { ...scope, account_id: 'other' },
      encryptedCredential: 'synthetic-cipher'
    })
    finish(
      Response.json({
        requestId,
        challengeId: c.challengeId,
        reportHash: hashContext(body),
        receivedAt: 2,
        status: 'runtime_stop_confirmation_recorded',
        physicalStopVerified: false,
        canAuthorizeSend: false
      })
    )
    await expect(pending).rejects.toThrow('DEVICE_SCOPE_CHANGED')
  })
})
