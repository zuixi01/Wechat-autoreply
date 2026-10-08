import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { embeddedPostgres } from '../fixtures/embedded-postgres'
import { listenFetchLoopback } from '../fixtures/fetch-loopback'
import { AccountAuthority, tokenHash } from '../../server/src/auth/account-authority'
import { RuntimeStatusAuthority } from '../../server/src/monitoring/runtime-status-authority'
import { createApplication } from '../../server/src/http/application'
import {
  AgentRegistration,
  type EncryptedDeviceRecord
} from '../../src/main/services/agent-registration'
import { DesktopAgentRuntime } from '../../src/main/services/desktop-agent-runtime'
import { Ledger } from '../../src/core/persistence/ledger'
import { hashContext } from '../../src/core/reply/hashes'
import type { RuntimeObservation } from '../../src/shared/contracts/runtime-monitoring'

let pg: Awaited<ReturnType<typeof embeddedPostgres>>, server: Server, base: string
const token = 'A'.repeat(43)
const scope = {
  tenant_id: 'A',
  employee_id: 'employee',
  account_id: 'account',
  agent_id: 'agent',
  platform: 'wework' as const
}
const observation: RuntimeObservation = {
  runtimeEpoch: 1,
  sequence: 1,
  status: { state: 'paused', reason: 'user_pause', lease: 'stopped', pauseAcknowledged: true }
}
beforeAll(async () => {
  pg = await embeddedPostgres()
  await pg.adminExec(`INSERT INTO tenants VALUES('A','synthetic'); INSERT INTO employees(tenant_id,id,role) VALUES('A','employee','employee');
    INSERT INTO accounts(tenant_id,id,employee_id,platform) VALUES('A','account','employee','wework');
    INSERT INTO agents(tenant_id,id,account_id,employee_id,token_hash) VALUES('A','agent','account','employee','${tokenHash(token)}')`)
  const authority = new AccountAuthority(pg.db)
  server = createServer(
    createApplication(authority, { monitoring: new RuntimeStatusAuthority(authority) })
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
    record: (next: EncryptedDeviceRecord) => {
      record = next
    }
  }
}
const post = (input: unknown, extra: Record<string, string> = {}) =>
  fetch(base + '/v1/runtime/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...extra },
    body: JSON.stringify(input)
  })
describe('private monitoring over actual loopback HTTP and SQL', () => {
  it('persists the process status without reading a platform or generating/sending a reply, and joins shutdown', async () => {
    const ledger = new Ledger(':memory:'),
      f = client(),
      transport = vi.spyOn(f.registration, 'reportRuntimeStatus')
    const runtime = new DesktopAgentRuntime(ledger, f.registration)
    try {
      runtime.configureMonitoring()
      runtime.configureMonitoring()
      await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce())
      await vi.waitFor(async () =>
        expect(
          (
            await pg.db.transaction('A', (db) =>
              db.query('SELECT sequence FROM device_runtime_status')
            )
          ).rows
        ).toHaveLength(1)
      )
      const row = (
        await pg.db.transaction('A', (db) =>
          db.query('SELECT report_json FROM device_runtime_status')
        )
      ).rows[0].report_json
      expect(row).toMatchObject({
        // ReliableAgent reserves epoch 1 on construction; reporting reserves the next durable epoch.
        runtimeEpoch: 2,
        sequence: 1,
        status: {
          state: 'paused',
          lease: 'stopped',
          readiness: { registered: true, backgroundRead: false, nonInterferingSend: false }
        }
      })
      expect(JSON.stringify(row)).not.toContain(token)
      expect(
        (await pg.db.transaction('A', (db) => db.query('SELECT * FROM account_leases'))).rows
      ).toEqual([])
      const closed = await runtime.close()
      expect(closed.state).toBe('closed')
      expect(transport).toHaveBeenCalledOnce()
    } finally {
      await runtime.close()
    }
  })
  it('checks authentication, origin, byte limits and strict input before persistence', async () => {
    expect((await post(observation, { Authorization: '' })).status).toBe(401)
    expect((await post(observation, { Origin: 'https://untrusted.example' })).status).toBe(403)
    expect((await post({ text: 'x'.repeat(9000) })).status).toBe(413)
    expect((await post({ ...observation, customerText: 'private' })).status).toBe(400)
    const response = await post({ ...observation, runtimeEpoch: 100 })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      scope,
      reportHash: hashContext({ ...observation, runtimeEpoch: 100 }),
      canAuthorizeSend: false
    })
    expect((await post(observation)).status).toBe(409)
  })
  it.each(['scope', 'hash', 'sequence', 'authority'] as const)(
    'rejects a forged %s in a receipt',
    async (field) => {
      const transport = vi.fn<typeof fetch>(async () => {
        const receipt = {
          scope,
          runtimeEpoch: 1,
          sequence: 1,
          reportHash: hashContext(observation),
          receivedAt: Date.now(),
          serverPaused: true,
          canAuthorizeSend: false
        }
        return Response.json(
          field === 'scope'
            ? { ...receipt, scope: { ...scope, account_id: 'other' } }
            : field === 'hash'
              ? { ...receipt, reportHash: 'b'.repeat(64) }
              : field === 'sequence'
                ? { ...receipt, sequence: 2 }
                : { ...receipt, canAuthorizeSend: true }
        )
      })
      await expect(client(transport).registration.reportRuntimeStatus(observation)).rejects.toThrow(
        'INVALID_RESPONSE'
      )
    }
  )
  it('rejects a valid late receipt when the device registration changes during the request', async () => {
    let finish!: (value: Response) => void
    const transport = vi.fn<typeof fetch>(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const f = client(transport),
      pending = f.registration.reportRuntimeStatus(observation)
    f.record({
      serverUrl: base,
      scope: { ...scope, account_id: 'other' },
      encryptedCredential: 'synthetic-cipher'
    })
    finish(
      Response.json({
        scope,
        runtimeEpoch: 1,
        sequence: 1,
        reportHash: hashContext(observation),
        receivedAt: Date.now(),
        serverPaused: true,
        canAuthorizeSend: false
      })
    )
    await expect(pending).rejects.toThrow('DEVICE_SCOPE_CHANGED')
  })
})
