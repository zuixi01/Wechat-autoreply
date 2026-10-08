import { createServer, type Server } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { Ledger } from '../../src/core/persistence/ledger'
import { createLedgerBackup, restoreLedgerBackup } from '../../src/core/persistence/ledger-backup'
import { AgentRegistration } from '../../src/main/services/agent-registration'
import {
  DesktopAgentRuntime,
  type RuntimePlatform
} from '../../src/main/services/desktop-agent-runtime'
import { embeddedPostgres } from '../fixtures/embedded-postgres'
import { AccountAuthority, tokenHash } from '../../server/src/auth/account-authority'
import { Administration } from '../../server/src/admin/administration'
import { executeAdminCommand, parseAdminCommand } from '../../server/src/admin/command'
import * as restoration from '../../server/src/execution/restore-pause-authority'
import { createApplication } from '../../server/src/http/application'
import { hashContext } from '../../src/core/reply/hashes'
import type { RestorePauseChallenge } from '../../src/shared/contracts/restoration'

let pg: Awaited<ReturnType<typeof embeddedPostgres>>,
  admin: Administration,
  server: Server,
  origin: string
let opened: { caseId: string }, context: ReturnType<typeof makeContext>
const token = 'A'.repeat(43),
  otherToken = 'B'.repeat(43)
function makeContext() {
  const descriptor = {
    formatVersion: 1,
    restoreId: randomUUID(),
    backupId: randomUUID(),
    sourceSha256: 'a'.repeat(64),
    restoredAt: new Date().toISOString(),
    previousRestoreId: null,
    previousContextHash: null,
    requiresReconciliation: true
  }
  return { ...descriptor, contextHash: hashContext(descriptor) }
}
async function privileged(sql: string) {
  await pg.sql.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE')
  await pg.sql.exec(sql)
}
async function login(role: string) {
  await pg.sql.exec(
    `SET SESSION AUTHORIZATION postgres; RESET ROLE; SET SESSION AUTHORIZATION ${role}`
  )
}
const input = () => ({
  caseId: opened.caseId,
  requestId: randomUUID(),
  restoreId: context.restoreId,
  contextHash: context.contextHash
})
async function post(path: string, data: unknown, bearer = token) {
  return fetch(origin + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
    body: JSON.stringify(data)
  })
}
async function challenge(request = input()): Promise<RestorePauseChallenge> {
  const response = await post('/v1/restorations/challenge', request)
  expect(response.status).toBe(200)
  return response.json()
}
const report = (c: RestorePauseChallenge) => ({
  challenge: c,
  instanceId: randomUUID(),
  runtimeGeneration: 2,
  stoppedAt: Date.now(),
  observedAt: Date.now(),
  stopped: {
    observerStopped: true,
    senderQuiescent: true,
    settlementQuiescent: true,
    leaseStopped: true,
    platformStopped: true
  }
})
beforeAll(async () => {
  pg = await embeddedPostgres()
  await privileged(
    'CREATE ROLE restore_pause_admin LOGIN NOSUPERUSER NOBYPASSRLS; GRANT autoreply_admin TO restore_pause_admin'
  )
  admin = new Administration(pg.db)
  const authority = new AccountAuthority(pg.db)
  const service = restoration.RestorePauseAuthority
    ? new restoration.RestorePauseAuthority(authority)
    : undefined
  server = createServer(createApplication(authority, { restoration: service }))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('missing_test_port')
  origin = `http://127.0.0.1:${address.port}`
}, 20000)
afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  if (pg) await pg.db.close()
})
beforeEach(async () => {
  await privileged(`TRUNCATE tenants CASCADE;
    INSERT INTO tenants(id,name) VALUES('A','合成公司');
    INSERT INTO employees(tenant_id,id,role) VALUES('A','admin','admin'),('A','employee','employee');
    INSERT INTO admin_database_principals(login_name,tenant_id,employee_id) VALUES('restore_pause_admin','A','admin');
    INSERT INTO accounts(tenant_id,id,employee_id,platform,paused) VALUES('A','account','employee','wechat',false);
    INSERT INTO agents(tenant_id,id,account_id,employee_id,token_hash) VALUES('A','target','account','employee','${tokenHash(token)}'),('A','other','account','employee','${tokenHash(otherToken)}');
    INSERT INTO account_leases(tenant_id,account_id,agent_id,login_epoch,client_instance_id,version,expires_at) VALUES('A','account','target',3,'old-process',7,clock_timestamp()-interval '1 second');`)
  context = makeContext()
  await login('restore_pause_admin')
  opened = await admin.openRestoreReview('A', 'account', { agentId: 'target', context })
  await login('autoreply_app')
})
describe('authenticated target restoration pause protocol over actual HTTP', () => {
  it('discovers only the credential-owned restoration case from the exact local source without issuing a lease or challenge', async () => {
    const request = { restoreId: context.restoreId, contextHash: context.contextHash }
    const response = await post('/v1/restorations/lookup', request)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      caseId: opened.caseId,
      scope: {
        tenant_id: 'A',
        employee_id: 'employee',
        account_id: 'account',
        agent_id: 'target',
        platform: 'wechat'
      },
      ...request
    })
    expect((await post('/v1/restorations/lookup', request, otherToken)).status).toBe(409)
    expect(
      (await post('/v1/restorations/lookup', { ...request, contextHash: 'f'.repeat(64) })).status
    ).toBe(409)
    expect(
      (await post('/v1/restorations/lookup', { ...request, scope: { agent_id: 'other' } })).status
    ).toBe(400)
    await login('restore_pause_admin')
    expect(
      (
        await pg.db.transaction('A', (db) =>
          db.query('SELECT count(*)::int AS count FROM ledger_restore_challenges')
        )
      ).rows
    ).toEqual([{ count: 0 }])
  })
  it('lets only the authenticated administrator page declarations and inspect the exact immutable report', async () => {
    const c1 = await challenge(),
      c2 = await challenge()
    const proof1 = report(c1),
      proof2 = report(c2)
    expect((await post('/v1/restorations/report', proof1)).status).toBe(200)
    expect((await post('/v1/restorations/report', proof2)).status).toBe(200)
    await expect(admin.restorePauseReports('A', 'account', opened.caseId)).rejects.toThrow('DENIED')
    await login('restore_pause_admin')
    const first = await admin.restorePauseReports('A', 'account', opened.caseId, { limit: 1 })
    const second = await admin.restorePauseReports('A', 'account', opened.caseId, {
      after: first[0].challengeId,
      limit: 1
    })
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(1)
    expect(new Set([...first, ...second].map((r) => r.challengeId))).toEqual(
      new Set([c1.challengeId, c2.challengeId])
    )
    expect(
      await admin.restorePauseReports('A', 'account', opened.caseId, {
        after: second[0].challengeId
      })
    ).toEqual([])
    const detail = await admin.restorePauseReport('A', 'account', opened.caseId, c1.challengeId)
    expect(detail).toMatchObject({
      reportHash: hashContext(proof1),
      report: proof1,
      declarationKind: 'target_main_process',
      receiptStatus: 'target_pause_report_recorded',
      requiresReconciliation: true
    })
    expect(detail.recordedAt).toBeGreaterThanOrEqual(c1.issuedAt)
    expect(first[0]).not.toHaveProperty('report')
    await expect(
      admin.restorePauseReport('A', 'account', randomUUID(), c1.challengeId)
    ).rejects.toThrow('RESTORE_REVIEW_NOT_FOUND')
    await expect(admin.restorePauseReports('A', 'missing', opened.caseId)).rejects.toThrow(
      'ACCOUNT_NOT_FOUND'
    )
    await expect(admin.restorePauseReports('B', 'account', opened.caseId)).rejects.toThrow('DENIED')
    await expect(
      admin.restorePauseReports('A', 'account', opened.caseId, { limit: 101 })
    ).rejects.toThrow()
    await expect(admin.resume('A', 'account')).rejects.toThrow('UNRESOLVED_RESTORE')
  })
  it('reads a historical receipt after device revocation without claiming the device is currently stopped', async () => {
    const c = await challenge(),
      proof = report(c)
    expect((await post('/v1/restorations/report', proof)).status).toBe(200)
    await privileged("UPDATE agents SET revoked_at=clock_timestamp() WHERE id='target'")
    await login('restore_pause_admin')
    const result = await admin.restorePauseReport('A', 'account', opened.caseId, c.challengeId)
    expect(result).toMatchObject({
      report: proof,
      receiptStatus: 'target_pause_report_recorded',
      requiresReconciliation: true
    })
    expect(result).not.toHaveProperty('currentlyStopped')
    expect(result).not.toHaveProperty('allDevicesStopped')
    await privileged("UPDATE employees SET enabled=false WHERE id='admin'")
    await login('restore_pause_admin')
    await expect(
      admin.restorePauseReport('A', 'account', opened.caseId, c.challengeId)
    ).rejects.toThrow('DENIED')
  })
  it('rejects corrupted report or nonce contents when an administrator reads saved evidence', async () => {
    const c = await challenge(),
      proof = report(c)
    expect((await post('/v1/restorations/report', proof)).status).toBe(200)
    await privileged(
      `UPDATE ledger_restore_pause_reports SET report_json=jsonb_set(report_json,'{instanceId}','"${randomUUID()}"')`
    )
    await login('restore_pause_admin')
    await expect(admin.restorePauseReports('A', 'account', opened.caseId)).rejects.toThrow(
      'RESTORE_REVIEW_CONFLICT'
    )
    await privileged(
      `UPDATE ledger_restore_pause_reports SET report_json='${JSON.stringify(proof)}'::jsonb; UPDATE ledger_restore_challenges SET challenge_json=jsonb_set(challenge_json,'{frontierHash}','"${'f'.repeat(64)}"')`
    )
    await login('restore_pause_admin')
    await expect(
      admin.restorePauseReport('A', 'account', opened.caseId, c.challengeId)
    ).rejects.toThrow('RESTORE_REVIEW_CONFLICT')
  })
  it('routes strictly parsed administrator report commands to real scoped reads', async () => {
    const c = await challenge(),
      proof = report(c)
    expect((await post('/v1/restorations/report', proof)).status).toBe(200)
    await login('restore_pause_admin')
    const listed = parseAdminCommand([
      'restore-pause-reports',
      '--tenant',
      'A',
      '--account',
      'account',
      '--case',
      opened.caseId,
      '--limit',
      '1'
    ])
    expect(
      await executeAdminCommand(admin, listed, async () => {
        throw Error('unexpected_file_read')
      })
    ).toMatchObject({ reports: [{ challengeId: c.challengeId, reportHash: hashContext(proof) }] })
    const detail = parseAdminCommand([
      'restore-pause-report',
      '--tenant',
      'A',
      '--account',
      'account',
      '--case',
      opened.caseId,
      '--challenge',
      c.challengeId
    ])
    expect(
      await executeAdminCommand(admin, detail, async () => {
        throw Error('unexpected_file_read')
      })
    ).toMatchObject({ report: proof })
    expect(() =>
      parseAdminCommand([
        'restore-pause-report',
        '--tenant',
        'A',
        '--account',
        'account',
        '--case',
        opened.caseId,
        '--challenge',
        c.challengeId,
        '--challenge',
        c.challengeId
      ])
    ).toThrow()
    expect(() =>
      parseAdminCommand([
        'restore-pause-reports',
        '--tenant',
        'A',
        '--account',
        'account',
        '--case',
        opened.caseId,
        '--file',
        'ignored.json'
      ])
    ).toThrow()
  })
  it('binds all 1001 permit snapshots rather than the first frontier page and rejects later snapshot changes', async () => {
    await privileged(`INSERT INTO execution_permits(tenant_id,account_id,id,agent_id,lease_version,task_id,draft_hash,status)
      SELECT 'A','account','permit-'||lpad(n::text,4,'0'),'target',7,'task-'||n,'${'b'.repeat(64)}','confirmed' FROM generate_series(1,1001) n`)
    context = makeContext()
    await login('restore_pause_admin')
    const review = await admin.openRestoreReview('A', 'account', { agentId: 'target', context })
    opened = review
    expect(review.permitCount).toBe(1001)
    const snapshots = await pg.db.transaction('A', (db) =>
      db.query(
        'SELECT permit_id,snapshot_json FROM ledger_restore_review_permits WHERE case_id=$1 ORDER BY permit_id',
        [review.caseId]
      )
    )
    expect(snapshots.rows).toHaveLength(1001)
    const expected = createHash('sha256').update(hashContext(review))
    for (const row of snapshots.rows)
      expected.update(hashContext({ permitId: row.permit_id, snapshot: row.snapshot_json }))
    await login('autoreply_app')
    const c = await challenge()
    expect(c.frontierHash).toBe(expected.digest('hex'))
    const proof = report(c)
    expect((await post('/v1/restorations/report', proof)).status).toBe(200)
    await login('restore_pause_admin')
    expect(await admin.restorePauseReports('A', 'account', opened.caseId)).toMatchObject([
      { challengeId: c.challengeId }
    ])
    await privileged(
      `UPDATE ledger_restore_review_permits SET snapshot_json=snapshot_json||'{"status":"unknown"}'::jsonb WHERE case_id='${review.caseId}' AND permit_id='permit-1001'`
    )
    await login('autoreply_app')
    expect((await post('/v1/restorations/report', proof)).status).toBe(409)
    await login('restore_pause_admin')
    await expect(admin.restorePauseReports('A', 'account', opened.caseId)).rejects.toThrow(
      'RESTORE_REVIEW_CONFLICT'
    )
  })
  it('connects a real restored SQLite ledger, registration client and desktop runtime without reading or sending chats', async () => {
    const root = mkdtempSync(join(tmpdir(), 'restore-pause-http-'))
    let runtime: DesktopAgentRuntime | undefined
    try {
      const sourcePath = join(root, 'source.sqlite'),
        sourceLedger = new Ledger(sourcePath)
      sourceLedger.close()
      const source = new DatabaseSync(sourcePath, { readOnly: true })
      let backup
      try {
        backup = await createLedgerBackup(source, join(root, 'backups'))
      } finally {
        source.close()
      }
      const restored = await restoreLedgerBackup(backup.directory, join(root, 'restored'))
      await login('restore_pause_admin')
      const review = await admin.openRestoreReview('A', 'account', {
        agentId: 'target',
        context: restored.restoreContext
      })
      await login('autoreply_app')
      const paths: string[] = []
      const scope = {
        tenant_id: 'A',
        employee_id: 'employee',
        account_id: 'account',
        agent_id: 'target',
        platform: 'wechat' as const
      }
      const client = new AgentRegistration(
        {
          load: () => ({ serverUrl: origin, encryptedCredential: 'synthetic-cipher', scope }),
          save: () => {}
        },
        { available: () => true, encrypt: () => '', decrypt: () => token },
        async (resource, init) => {
          paths.push(
            new URL(resource instanceof Request ? resource.url : String(resource)).pathname
          )
          return fetch(resource, init)
        },
        true
      )
      const platform: RuntimePlatform = {
        capabilities: () => ({ backgroundRead: false, nonInterferingSend: false }),
        binding: vi.fn(async () => {
          throw Error('chat_binding_forbidden')
        }),
        observe: vi.fn(async () => {
          throw Error('chat_observation_forbidden')
        }),
        stop: vi.fn(async () => {}),
        readCurrent: vi.fn(async () => {
          throw Error('chat_read_forbidden')
        }),
        dispatch: vi.fn(async () => {
          throw Error('chat_send_forbidden')
        })
      }
      const ledger = new Ledger(restored.databasePath)
      runtime = new DesktopAgentRuntime(ledger, client, platform)
      expect(runtime.restorationStatus()).toEqual({ state: 'review_required' })
      const result = await runtime.submitRestorePause({})
      expect(result).toMatchObject({ success: true, status: 'target_pause_report_recorded' })
      if (!result.success) throw Error('restore_report_failed')
      expect(paths).toEqual([
        '/v1/restorations/lookup',
        '/v1/restorations/challenge',
        '/v1/restorations/report'
      ])
      expect(result).toMatchObject({ caseId: review.caseId })
      expect(runtime.restorationStatus()).toEqual({ state: 'pause_report_recorded' })
      expect(ledger.requiresRestoreReview()).toBe(true)
      expect(platform.binding).not.toHaveBeenCalled()
      expect(platform.observe).not.toHaveBeenCalled()
      expect(platform.dispatch).not.toHaveBeenCalled()
      await runtime.close()
      runtime = undefined
      const reopened = new Ledger(restored.databasePath)
      try {
        expect(hashContext(reopened.restorePauseReport(result.challengeId))).toBe(result.reportHash)
        expect(reopened.requiresRestoreReview()).toBe(true)
      } finally {
        reopened.close()
      }
    } finally {
      await runtime?.close()
      expect(resolve(root).startsWith(resolve(tmpdir()) + sep + 'restore-pause-http-')).toBe(true)
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('issues a bounded challenge, records exactly the same report twice, and keeps the account fenced', async () => {
    const request = input(),
      c = await challenge(request)
    expect(await challenge(request)).toEqual(c)
    expect(c).toMatchObject({
      caseId: opened.caseId,
      requestId: request.requestId,
      context,
      scope: { account_id: 'account', agent_id: 'target' }
    })
    expect(c.expiresAt - c.issuedAt).toBe(30000)
    const proof = report(c),
      first = await post('/v1/restorations/report', proof)
    expect(first.status).toBe(200)
    const ack = await first.json()
    expect(ack).toEqual({
      challengeId: c.challengeId,
      reportHash: hashContext(proof),
      status: 'target_pause_report_recorded'
    })
    expect(await (await post('/v1/restorations/report', proof)).json()).toEqual(ack)
    await login('restore_pause_admin')
    expect(
      (
        await pg.db.transaction('A', (db) =>
          db.query('SELECT count(*)::int AS count FROM ledger_restore_pause_reports')
        )
      ).rows
    ).toEqual([{ count: 1 }])
    await expect(admin.resume('A', 'account')).rejects.toThrow('UNRESOLVED_RESTORE')
  })
  it('rejects another device, wrong recovery context, incomplete stop and a changed nonce binding', async () => {
    expect((await post('/v1/restorations/challenge', input(), otherToken)).status).toBe(409)
    expect(
      (await post('/v1/restorations/challenge', { ...input(), contextHash: 'f'.repeat(64) })).status
    ).toBe(409)
    const c = await challenge(),
      proof = report(c)
    expect(
      (
        await post('/v1/restorations/report', {
          ...proof,
          stopped: { ...proof.stopped, senderQuiescent: false }
        })
      ).status
    ).toBe(400)
    expect(
      (
        await post('/v1/restorations/report', {
          ...proof,
          challenge: { ...c, frontierHash: 'f'.repeat(64) }
        })
      ).status
    ).toBe(409)
    expect((await post('/v1/restorations/report', proof, otherToken)).status).toBe(409)
    expect((await post('/v1/restorations/report', proof, 'not-a-credential')).status).toBe(401)
  })
  it('rechecks lease and revoked authority between challenge and report and does not accept future observations', async () => {
    const c = await challenge(),
      proof = report(c)
    expect(
      (await post('/v1/restorations/report', { ...proof, observedAt: Date.now() + 60000 })).status
    ).toBe(400)
    expect(
      (await post('/v1/restorations/report', { ...proof, observedAt: Date.now() + 5000 })).status
    ).toBe(409)
    await privileged("UPDATE account_leases SET expires_at=clock_timestamp()+interval '1 minute'")
    await login('autoreply_app')
    expect((await post('/v1/restorations/report', proof)).status).toBe(409)
    await privileged(
      "UPDATE account_leases SET expires_at=clock_timestamp()-interval '1 second'; UPDATE agents SET revoked_at=clock_timestamp() WHERE id='target'"
    )
    await login('autoreply_app')
    expect((await post('/v1/restorations/report', proof)).status).toBe(401)
  })
  it('denies modified retries after persistence and protects the report against ordinary database changes', async () => {
    const c = await challenge(),
      proof = report(c)
    expect((await post('/v1/restorations/report', proof)).status).toBe(200)
    expect(
      (await post('/v1/restorations/report', { ...proof, instanceId: randomUUID() })).status
    ).toBe(409)
    await login('restore_pause_admin')
    await expect(
      pg.db.transaction('A', (db) => db.query('DELETE FROM ledger_restore_pause_reports'))
    ).rejects.toThrow()
    await expect(
      pg.db.transaction('A', (db) =>
        db.query("UPDATE ledger_restore_pause_reports SET report_hash='x'")
      )
    ).rejects.toThrow()
  })
})
