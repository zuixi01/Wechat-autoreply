import { createHash, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { embeddedPostgres } from '../fixtures/embedded-postgres'
import { listenFetchLoopback } from '../fixtures/fetch-loopback'
import { AccountAuthority, tokenHash } from '../../server/src/auth/account-authority'
import { Administration } from '../../server/src/admin/administration'
import { RestorePauseAuthority } from '../../server/src/execution/restore-pause-authority'
import { createApplication } from '../../server/src/http/application'
import { hashContext } from '../../src/core/reply/hashes'
import type { RestoreInventoryItem } from '../../src/shared/contracts/restore-inventory'
import { executeAdminCommand, parseAdminCommand } from '../../server/src/admin/command'
import { Ledger } from '../../src/core/persistence/ledger'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { createLedgerBackup, restoreLedgerBackup } from '../../src/core/persistence/ledger-backup'
import { AgentRegistration } from '../../src/main/services/agent-registration'
import { DesktopAgentRuntime } from '../../src/main/services/desktop-agent-runtime'

let pg: Awaited<ReturnType<typeof embeddedPostgres>>, server: Server, origin: string
let admin: Administration,
  caseId: string,
  context: ReturnType<typeof makeContext>,
  challengeId: string
const token = 'A'.repeat(43),
  otherToken = 'B'.repeat(43)
const scope = {
  tenant_id: 'A',
  employee_id: 'employee',
  account_id: 'account',
  agent_id: 'target',
  platform: 'wechat' as const
}
const identity = {
  tenantId: 'A',
  employeeId: 'employee',
  accountId: 'account',
  agentId: 'target',
  platform: 'wechat' as const,
  loginEpoch: 3,
  clientInstanceId: 'old-process'
}
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
function message(sequence: number): Extract<RestoreInventoryItem, { kind: 'message' }> {
  return {
    kind: 'message',
    key: `m:${hashContext({ identity, conversationId: 'customer' })}:${String(sequence).padStart(16, '0')}`,
    identity,
    conversationId: 'customer',
    sourceMessageId: `synthetic-${sequence}`,
    sequence,
    observedAt: 100 + sequence,
    sequenceComplete: true,
    direction: 'inbound',
    contentHash: 'c'.repeat(64),
    handledBy: null,
    identityVerified: true,
    messageIdVerified: true,
    hasGap: false,
    humanOwned: false,
    lastSequence: 3,
    revision: 0
  }
}
function manifest(items: RestoreInventoryItem[] = [message(1), message(2), message(3)]) {
  const messages = items.filter((i) => i.kind === 'message'),
    executions = items.filter((i) => i.kind === 'execution')
  const summary = {
    conversations: items.some((i) => i.kind === 'message' || i.conversation) ? 1 : 0,
    messages: messages.length,
    inbound: messages.length,
    handledInbound: messages.filter((i) => i.handledBy !== null).length,
    unhandledInbound: messages.filter((i) => i.handledBy === null).length,
    executions: executions.length,
    unknownExecutions: executions.filter(
      (i) => i.status === 'unknown' || i.receiptStatus === 'unknown' || i.permitStatus === 'unknown'
    ).length,
    pendingCentral: executions.filter((i) => i.phase !== null && i.phase !== 'settled').length
  }
  const digest = createHash('sha256').update(hashContext({ formatVersion: 1, context, scope }))
  for (const item of items) digest.update(hashContext(item))
  return {
    formatVersion: 1,
    evidenceKind: 'local_restored_metadata',
    context,
    scope,
    basisHash: digest.update(hashContext(summary)).digest('hex'),
    canRelease: false,
    externalEvidenceRequired: true,
    summary
  }
}
async function login(role: string) {
  await pg.sql.exec(
    `SET SESSION AUTHORIZATION postgres; RESET ROLE; SET SESSION AUTHORIZATION ${role}`
  )
}
async function post(operation: string, input: unknown, bearer = token) {
  return fetch(`${origin}/v1/restorations/${operation}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
    body: JSON.stringify(input)
  })
}
async function start(m = manifest(), requestId = randomUUID()) {
  const input = { caseId, requestId, challengeId, manifest: m }
  const response = await post('inventory/start', input)
  expect(response.status).toBe(200)
  return {
    input,
    receipt: (await response.json()) as {
      uploadId: string
      manifestHash: string
      expiresAt: number
    }
  }
}
async function page(
  uploadId: string,
  index: number,
  items: RestoreInventoryItem[] = [message(index + 1)]
) {
  return post('inventory/page', { uploadId, index, items })
}
beforeAll(async () => {
  pg = await embeddedPostgres()
  await login('postgres')
  await pg.sql.exec(
    'CREATE ROLE restore_inventory_admin LOGIN NOSUPERUSER NOBYPASSRLS; GRANT autoreply_admin TO restore_inventory_admin'
  )
  admin = new Administration(pg.db)
  const authority = new AccountAuthority(pg.db)
  server = createServer(
    createApplication(authority, { restoration: new RestorePauseAuthority(authority) })
  )
  origin = await listenFetchLoopback(server)
}, 20000)
afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  if (pg) await pg.db.close()
})
beforeEach(async () => {
  await login('postgres')
  await pg.sql.exec(`TRUNCATE tenants CASCADE;
    INSERT INTO tenants(id,name) VALUES('A','synthetic');
    INSERT INTO employees(tenant_id,id,role) VALUES('A','admin','admin'),('A','employee','employee');
    INSERT INTO admin_database_principals(login_name,tenant_id,employee_id) VALUES('restore_inventory_admin','A','admin');
    INSERT INTO accounts(tenant_id,id,employee_id,platform,paused) VALUES('A','account','employee','wechat',false);
    INSERT INTO agents(tenant_id,id,account_id,employee_id,token_hash) VALUES('A','target','account','employee','${tokenHash(token)}'),('A','other','account','employee','${tokenHash(otherToken)}');`)
  context = makeContext()
  await login('restore_inventory_admin')
  caseId = (await admin.openRestoreReview('A', 'account', { agentId: 'target', context })).caseId
  await login('autoreply_app')
  const response = await post('challenge', {
    caseId,
    requestId: randomUUID(),
    restoreId: context.restoreId,
    contextHash: context.contextHash
  })
  expect(response.status).toBe(200)
  const challenge = await response.json()
  challengeId = challenge.challengeId
  const observedAt = Date.now()
  expect(
    (
      await post('report', {
        challenge,
        instanceId: randomUUID(),
        runtimeGeneration: 2,
        stoppedAt: observedAt,
        observedAt,
        stopped: {
          observerStopped: true,
          senderQuiescent: true,
          settlementQuiescent: true,
          leaseStopped: true,
          platformStopped: true
        }
      })
    ).status
  ).toBe(200)
})
describe('authenticated immutable restored inventory transfer', () => {
  it('receives every page, independently verifies the complete hash and keeps the account paused', async () => {
    const { input, receipt } = await start()
    expect(receipt.manifestHash).toBe(hashContext(input.manifest))
    expect((await post('inventory/start', input)).status).toBe(200)
    expect(
      (await post('inventory/complete', { uploadId: receipt.uploadId, pageCount: 3 })).status
    ).toBe(409)
    for (let i = 0; i < 3; i++) expect((await page(receipt.uploadId, i)).status).toBe(200)
    const complete = await post('inventory/complete', { uploadId: receipt.uploadId, pageCount: 3 })
    expect(complete.status).toBe(200)
    const ack = await complete.json()
    expect(ack).toMatchObject({
      uploadId: receipt.uploadId,
      basisHash: input.manifest.basisHash,
      itemCount: 3,
      pageCount: 3,
      status: 'inventory_received',
      canRelease: false,
      externalEvidenceRequired: true
    })
    expect(
      await (await post('inventory/complete', { uploadId: receipt.uploadId, pageCount: 3 })).json()
    ).toEqual(ack)
    await login('restore_inventory_admin')
    expect(
      (
        await pg.db.transaction('A', (db) =>
          db.query('SELECT paused FROM accounts WHERE id=$1', ['account'])
        )
      ).rows
    ).toEqual([{ paused: true }])
    await expect(admin.resume('A', 'account')).rejects.toThrow('UNRESOLVED_RESTORE')
  })
  it('rejects altered retries, missing pages, duplicates, out-of-order keys and identity contamination', async () => {
    const { input, receipt } = await start()
    expect(
      (
        await post('inventory/start', {
          ...input,
          manifest: { ...input.manifest, basisHash: 'd'.repeat(64) }
        })
      ).status
    ).toBe(409)
    expect((await page(receipt.uploadId, 1)).status).toBe(409)
    expect((await page(receipt.uploadId, 0, [message(2), message(1)])).status).toBe(400)
    expect(
      (
        await page(receipt.uploadId, 0, [
          { ...message(1), identity: { ...identity, accountId: 'other' } }
        ])
      ).status
    ).toBe(400)
    expect((await page(receipt.uploadId, 0)).status).toBe(200)
    expect((await page(receipt.uploadId, 0)).status).toBe(200)
    expect((await page(receipt.uploadId, 0, [message(2)])).status).toBe(409)
    expect((await page(receipt.uploadId, 1, [message(1)])).status).toBe(409)
    expect((await page(receipt.uploadId, 1)).status).toBe(200)
    expect(
      (await post('inventory/complete', { uploadId: receipt.uploadId, pageCount: 2 })).status
    ).toBe(409)
  })
  it('denies other devices and mismatched provenance and requires a previously recorded pause declaration', async () => {
    const input = { caseId, requestId: randomUUID(), challengeId, manifest: manifest() }
    expect((await post('inventory/start', input, otherToken)).status).toBe(409)
    expect((await post('inventory/start', { ...input, challengeId: randomUUID() })).status).toBe(
      409
    )
    expect(
      (
        await post('inventory/start', {
          ...input,
          manifest: { ...input.manifest, context: { ...context, contextHash: 'd'.repeat(64) } }
        })
      ).status
    ).toBe(400)
    const { receipt } = await start()
    expect((await page(receipt.uploadId, 0)).status).toBe(200)
    expect(
      (
        await post(
          'inventory/page',
          { uploadId: receipt.uploadId, index: 1, items: [message(2)] },
          otherToken
        )
      ).status
    ).toBe(409)
  })
  it('rejects message bodies, forged release flags, oversized requests and corrupted complete basis', async () => {
    expect(
      (
        await post('inventory/start', {
          caseId,
          requestId: randomUUID(),
          challengeId,
          manifest: { ...manifest(), canRelease: true }
        })
      ).status
    ).toBe(400)
    const { receipt } = await start({ ...manifest(), basisHash: 'd'.repeat(64) })
    expect(
      (
        await page(receipt.uploadId, 0, [
          { ...message(1), text: 'private body' } as ReturnType<typeof message>
        ])
      ).status
    ).toBe(400)
    expect(
      (
        await post('inventory/page', {
          uploadId: receipt.uploadId,
          index: 0,
          items: [message(1)],
          extra: 'x'.repeat(524288)
        })
      ).status
    ).toBe(413)
    expect((await page(receipt.uploadId, 0, [message(1), message(2), message(3)])).status).toBe(200)
    expect(
      (await post('inventory/complete', { uploadId: receipt.uploadId, pageCount: 1 })).status
    ).toBe(409)
  })
  it('accepts an empty complete snapshot without accepting empty pages', async () => {
    const { receipt } = await start(manifest([]))
    expect((await page(receipt.uploadId, 0, [])).status).toBe(400)
    expect(
      (await post('inventory/complete', { uploadId: receipt.uploadId, pageCount: 0 })).status
    ).toBe(200)
  })
  it('has append-only grants and target-only RLS, and rejects a device revoked between pages', async () => {
    const { receipt } = await start()
    await expect(
      pg.db.transaction('A', (db) =>
        db.query('UPDATE ledger_restore_inventory_uploads SET manifest_hash=$1 WHERE id=$2', [
          'd'.repeat(64),
          receipt.uploadId
        ])
      )
    ).rejects.toThrow(/permission denied/)
    expect(
      (
        await pg.db.transaction('A', (db) =>
          db.query('SELECT count(*)::int AS count FROM ledger_restore_inventory_uploads')
        )
      ).rows
    ).toEqual([{ count: 0 }])
    await login('postgres')
    await pg.sql.exec("UPDATE agents SET revoked_at=clock_timestamp() WHERE id='target'")
    await login('autoreply_app')
    expect((await page(receipt.uploadId, 0)).status).toBe(401)
  })
  it('allows only the administrator to list uploads and page every complete item through the CLI', async () => {
    const items = Array.from({ length: 503 }, (_, i) => ({ ...message(i + 1), lastSequence: 503 }))
    const { receipt } = await start(manifest(items))
    await expect(admin.restoreInventories('A', 'account', caseId)).rejects.toThrow('DENIED')
    await login('restore_inventory_admin')
    expect(await admin.restoreInventories('A', 'account', caseId)).toMatchObject([
      { uploadId: receipt.uploadId, state: 'receiving', canRelease: false }
    ])
    await expect(
      admin.restoreInventoryItems('A', 'account', caseId, receipt.uploadId)
    ).rejects.toThrow('RESTORE_REVIEW_CONFLICT')
    await login('autoreply_app')
    for (let i = 0; i < 6; i++)
      expect((await page(receipt.uploadId, i, items.slice(i * 100, (i + 1) * 100))).status).toBe(
        200
      )
    expect(
      (await post('inventory/complete', { uploadId: receipt.uploadId, pageCount: 6 })).status
    ).toBe(200)
    await login('restore_inventory_admin')
    expect(await admin.restoreInventories('A', 'account', caseId)).toMatchObject([
      { uploadId: receipt.uploadId, state: 'inventory_received', itemCount: 503, canRelease: false }
    ])
    const keys: string[] = []
    let after: string | undefined
    for (;;) {
      const command = parseAdminCommand([
        'restore-inventory-items',
        '--tenant',
        'A',
        '--account',
        'account',
        '--case',
        caseId,
        '--upload',
        receipt.uploadId,
        '--limit',
        '100',
        ...(after ? ['--after', after] : [])
      ])
      const result = (await executeAdminCommand(admin, command, async () => {
        throw Error('unexpected_file_read')
      })) as { items: { local: RestoreInventoryItem }[]; nextAfter: string | null }
      keys.push(...result.items.map((i) => i.local.key))
      if (!result.nextAfter) break
      after = result.nextAfter
    }
    expect(keys).toEqual(items.map((i) => i.key))
    await expect(admin.restoreInventories('B', 'account', caseId)).rejects.toThrow('DENIED')
    await expect(
      admin.restoreInventoryItems('A', 'account', randomUUID(), receipt.uploadId)
    ).rejects.toThrow('RESTORE_REVIEW_NOT_FOUND')
    await expect(admin.restoreInventoryItems('A', 'account', caseId, randomUUID())).rejects.toThrow(
      'RESTORE_REVIEW_NOT_FOUND'
    )
  })
  it('shows missing central execution evidence without converting local unknown into a confirmed outcome', async () => {
    const executionId = randomUUID()
    const execution: RestoreInventoryItem = {
      kind: 'execution',
      key: `s:${executionId}`,
      identity,
      conversationId: 'customer',
      executionId,
      taskId: 'task',
      taskHash: 'b'.repeat(64),
      draftHash: 'c'.repeat(64),
      inboundRange: { from: 1, to: 1 },
      localRangePresent: false,
      status: 'unknown',
      phase: 'unresolved',
      permitId: 'missing-permit',
      requestHash: 'd'.repeat(64),
      permitHash: 'e'.repeat(64),
      permitStatus: 'unknown',
      centralUpdatedAt: 102,
      conversation: null,
      controlHash: null,
      receiptStatus: 'unknown',
      receiptHash: 'f'.repeat(64),
      evidenceHash: null,
      baselineSequence: null,
      createdAt: 100,
      updatedAt: 102
    }
    const { receipt } = await start(manifest([execution]))
    expect((await page(receipt.uploadId, 0, [execution])).status).toBe(200)
    expect(
      (await post('inventory/complete', { uploadId: receipt.uploadId, pageCount: 1 })).status
    ).toBe(200)
    await login('restore_inventory_admin')
    const result = await admin.restoreInventoryItems('A', 'account', caseId, receipt.uploadId)
    expect(result.items[0]).toMatchObject({
      local: { status: 'unknown' },
      central: null,
      differences: expect.arrayContaining([
        'central_permit_missing',
        'local_unknown',
        'local_range_missing'
      ]),
      requiresOutcomeReview: true
    })
    expect(result.canRelease).toBe(false)
    expect(result.externalEvidenceRequired).toBe(true)
    await expect(admin.resume('A', 'account')).rejects.toThrow('UNRESOLVED_RESTORE')
  })
  it('accepts long valid skip markers and refuses a false complete sequence claim even when the supplied hash matches', async () => {
    const items = [message(1), message(2), { ...message(3), handledBy: 'skip:' + 't'.repeat(128) }]
    const first = await start(manifest(items))
    expect((await page(first.receipt.uploadId, 0, items)).status).toBe(200)
    expect(
      (await post('inventory/complete', { uploadId: first.receipt.uploadId, pageCount: 1 })).status
    ).toBe(200)
    const forged = items.map((i) => ({ ...i, lastSequence: 103, sequenceComplete: true }))
    const second = await start(manifest(forged))
    expect((await page(second.receipt.uploadId, 0, forged)).status).toBe(200)
    expect(
      (await post('inventory/complete', { uploadId: second.receipt.uploadId, pageCount: 1 })).status
    ).toBe(409)
  })
  it('refuses a complete list or item page after a stored row is lost through simulated privileged maintenance', async () => {
    const { receipt } = await start()
    expect((await page(receipt.uploadId, 0, [message(1), message(2), message(3)])).status).toBe(200)
    expect(
      (await post('inventory/complete', { uploadId: receipt.uploadId, pageCount: 1 })).status
    ).toBe(200)
    await login('postgres')
    await pg.sql.query(
      'DELETE FROM ledger_restore_inventory_items WHERE upload_id=$1 AND item_key=$2',
      [receipt.uploadId, message(2).key]
    )
    await login('restore_inventory_admin')
    await expect(admin.restoreInventories('A', 'account', caseId)).rejects.toThrow(
      'RESTORE_REVIEW_CONFLICT'
    )
    await expect(
      admin.restoreInventoryItems('A', 'account', caseId, receipt.uploadId)
    ).rejects.toThrow('RESTORE_REVIEW_CONFLICT')
  })
  it('rejects duplicate source IDs and inconsistent conversation snapshots rather than certifying impossible ledger metadata', async () => {
    const variants = [
      [message(1), { ...message(2), sourceMessageId: message(1).sourceMessageId }, message(3)],
      [message(1), { ...message(2), humanOwned: true }, message(3)],
      [message(1), { ...message(2), hasGap: true }, message(3)],
      [message(1), { ...message(2), revision: 1 }, message(3)]
    ]
    for (const items of variants) {
      const { receipt } = await start(manifest(items))
      expect((await page(receipt.uploadId, 0, items)).status).toBe(200)
      expect(
        (await post('inventory/complete', { uploadId: receipt.uploadId, pageCount: 1 })).status
      ).toBe(409)
    }
  })
  it('compares matching-status receipt hashes and refreshes the central outcome after a late settlement', async () => {
    const executionId = randomUUID(),
      permitId = randomUUID()
    const execution: RestoreInventoryItem = {
      kind: 'execution',
      key: `s:${executionId}`,
      identity,
      conversationId: 'customer',
      executionId,
      taskId: 'task',
      taskHash: 'b'.repeat(64),
      draftHash: 'c'.repeat(64),
      inboundRange: { from: 1, to: 1 },
      localRangePresent: false,
      status: 'confirmed',
      phase: 'settled',
      permitId,
      requestHash: 'd'.repeat(64),
      permitHash: 'e'.repeat(64),
      permitStatus: 'confirmed',
      centralUpdatedAt: 102,
      conversation: null,
      controlHash: null,
      receiptStatus: 'confirmed',
      receiptHash: 'f'.repeat(64),
      evidenceHash: null,
      baselineSequence: null,
      createdAt: 100,
      updatedAt: 102
    }
    await login('postgres')
    await pg.sql.query(
      `INSERT INTO execution_permits(tenant_id,account_id,id,agent_id,lease_version,task_id,task_hash,draft_hash,login_epoch,client_instance_id,conversation_id,status,settlement_hash,settled_at) VALUES('A','account',$1,'target',1,'task',$2,$3,3,'old-process','customer','confirmed',$4,clock_timestamp())`,
      [permitId, execution.taskHash, execution.draftHash, 'e'.repeat(64)]
    )
    await login('autoreply_app')
    const { receipt } = await start(manifest([execution]))
    expect((await page(receipt.uploadId, 0, [execution])).status).toBe(200)
    expect(
      (await post('inventory/complete', { uploadId: receipt.uploadId, pageCount: 1 })).status
    ).toBe(200)
    await login('restore_inventory_admin')
    const first = await admin.restoreInventoryItems('A', 'account', caseId, receipt.uploadId)
    expect(first.items[0].differences).toContain('central_receipt_mismatch')
    await login('postgres')
    await pg.sql.query(
      "UPDATE execution_permits SET status='unknown',settlement_hash=$1 WHERE id=$2",
      ['a'.repeat(64), permitId]
    )
    await login('restore_inventory_admin')
    const second = await admin.restoreInventoryItems('A', 'account', caseId, receipt.uploadId)
    expect(second.items[0]).toMatchObject({
      local: { status: 'confirmed' },
      central: { status: 'unknown' },
      differences: expect.arrayContaining([
        'central_status_changed',
        'central_outcome_unresolved',
        'central_receipt_mismatch'
      ])
    })
    expect(second.basisHash).toBe(first.basisHash)
    expect(second.canRelease).toBe(false)
  })
  it('connects real SQLite, registration HTTP and runtime, and resumes the same upload after restart and a lost completion response', async () => {
    const root = mkdtempSync(join(tmpdir(), 'restore-inventory-http-'))
    const cleanup = resolve(root)
    if (!cleanup.startsWith(resolve(tmpdir()) + sep + 'restore-inventory-http-'))
      throw Error('unexpected_fixture_directory')
    let runtime: DesktopAgentRuntime | undefined
    try {
      const sourcePath = join(root, 'source.sqlite'),
        source = new Ledger(sourcePath)
      for (let i = 1; i <= 125; i++)
        source.observe({
          identity,
          conversationId: 'customer',
          sourceMessageId: `synthetic-${i}`,
          direction: 'inbound',
          kind: 'text',
          text: 'synthetic-private-body',
          observedAt: i,
          identityVerified: true,
          messageIdVerified: true
        })
      source.close()
      const read = new DatabaseSync(sourcePath, { readOnly: true })
      const backup = await createLedgerBackup(read, join(root, 'backups')).finally(() =>
        read.close()
      )
      const restored = await restoreLedgerBackup(backup.directory, join(root, 'restored'))
      await login('restore_inventory_admin')
      const review = await admin.openRestoreReview('A', 'account', {
        agentId: 'target',
        context: restored.restoreContext
      })
      await login('autoreply_app')
      let loseCompletion = true
      const starts: unknown[] = [],
        requestBodies: string[] = []
      const client = new AgentRegistration(
        {
          load: () => ({ serverUrl: origin, encryptedCredential: 'synthetic-cipher', scope }),
          save: () => {}
        },
        { available: () => true, encrypt: () => '', decrypt: () => token },
        async (resource, init) => {
          const path = new URL(resource instanceof Request ? resource.url : String(resource))
            .pathname
          requestBodies.push(String(init?.body ?? ''))
          if (path.endsWith('/inventory/start')) starts.push(JSON.parse(String(init?.body)))
          const response = await fetch(resource, init)
          if (path.endsWith('/inventory/complete') && response.ok && loseCompletion) {
            loseCompletion = false
            await response.arrayBuffer()
            throw Error('synthetic response lost after commit')
          }
          return response
        },
        true
      )
      runtime = new DesktopAgentRuntime(new Ledger(restored.databasePath), client)
      expect(await runtime.submitRestoreInventory({})).toEqual({
        success: false,
        code: 'unavailable'
      })
      await runtime.close()
      runtime = undefined
      const reopened = new Ledger(restored.databasePath)
      runtime = new DesktopAgentRuntime(reopened, client)
      const result = await runtime.submitRestoreInventory({})
      expect(result).toMatchObject({
        success: true,
        caseId: review.caseId,
        itemCount: 125,
        pageCount: 2,
        canRelease: false
      })
      expect(starts).toHaveLength(2)
      expect(starts[1]).toEqual(starts[0])
      expect(requestBodies.join('')).not.toContain('synthetic-private-body')
      expect(reopened.requiresRestoreReview()).toBe(true)
      await login('restore_inventory_admin')
      const uploads = await admin.restoreInventories('A', 'account', review.caseId)
      expect(uploads).toHaveLength(1)
      expect(uploads[0]).toMatchObject({ state: 'inventory_received', itemCount: 125 })
      const first = await admin.restoreInventoryItems(
        'A',
        'account',
        review.caseId,
        uploads[0].uploadId,
        { limit: 100 }
      )
      const second = await admin.restoreInventoryItems(
        'A',
        'account',
        review.caseId,
        uploads[0].uploadId,
        { after: first.nextAfter!, limit: 100 }
      )
      expect(first.items).toHaveLength(100)
      expect(second.items).toHaveLength(25)
      expect(second.nextAfter).toBeNull()
      await expect(admin.resume('A', 'account')).rejects.toThrow('UNRESOLVED_RESTORE')
    } finally {
      await runtime?.close()
      // cleanup was resolved and validated before entering try; use that exact path.
      rmSync(cleanup, { recursive: true, force: true })
    }
  })
})
