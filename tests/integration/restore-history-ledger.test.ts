import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { Ledger } from '../../src/core/persistence/ledger'
import { createLedgerBackup, restoreLedgerBackup } from '../../src/core/persistence/ledger-backup'
import { hashContext } from '../../src/core/reply/hashes'
import type { RestoreInventoryItem } from '../../src/shared/contracts/restore-inventory'
import { taskFixture } from '../fixtures/task'
import { historyFixture } from '../fixtures/restore-history'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep + 'restore-history-'))
      throw Error('fixture_root_invalid')
    rmSync(root, { recursive: true, force: true })
  }
})
it('checks the full restored SQLite visitor across display pages/login epochs and leaves unknown sends and fences unchanged', async () => {
  const root = mkdtempSync(join(tmpdir(), 'restore-history-'))
  roots.push(root)
  const sourcePath = join(root, 'source.sqlite'),
    original = new Ledger(sourcePath),
    f = taskFixture()
  const nowBeforeBackup = Date.now()
  const message = (id: string, identity = f.task.identity) => ({
    identity,
    conversationId: f.task.conversationId,
    sourceMessageId: id,
    direction: 'inbound' as const,
    kind: 'text' as const,
    text: '合成历史证据测试',
    observedAt: nowBeforeBackup - 1000,
    identityVerified: true,
    messageIdVerified: true
  })
  for (let i = 0; i < 55; i++) original.observe(message('source-' + i))
  original.observe(
    message('source-0', {
      ...f.task.identity,
      loginEpoch: 0,
      clientInstanceId: 'synthetic-old-login'
    })
  )
  original.observe(message('foreign-message', { ...f.task.identity, accountId: 'foreign' }))
  const send = original.prepare(f.task, f.draft.draftHash, nowBeforeBackup).record
  original.transition(send.executionId, 'prepared', 'dispatching', nowBeforeBackup)
  original.transition(send.executionId, 'dispatching', 'unknown', nowBeforeBackup)
  const raw = new DatabaseSync(sourcePath)
  let backup: Awaited<ReturnType<typeof createLedgerBackup>>
  try {
    backup = await createLedgerBackup(raw, join(root, 'backups'))
  } finally {
    raw.close()
    original.close()
  }
  const restored = await restoreLedgerBackup(backup.directory, join(root, 'restored'))
  const ledger = new Ledger(restored.databasePath)
  try {
    const scope = {
      tenant_id: f.task.identity.tenantId,
      employee_id: f.task.identity.employeeId,
      account_id: f.task.identity.accountId,
      agent_id: f.task.identity.agentId,
      platform: f.task.identity.platform
    }
    const items: RestoreInventoryItem[] = []
    const inventory = ledger.visitRestoreInventory(scope, (item) => items.push(item))
    expect(items.length).toBe(57)
    const { items: _display, nextAfter: _next, ...manifest } = inventory
    expect(_next).not.toBeNull()
    expect(_display.length).toBe(50)
    const before = hashContext(items),
      beforeContext = ledger.restoreContext()?.contextHash
    const signed = historyFixture(),
      now = Date.now()
    signed.trust.tenantId = scope.tenant_id
    signed.trust.accountId = scope.account_id
    signed.trust.platform = scope.platform
    signed.trust.notBefore = now - 60000
    signed.trust.notAfter = now + 60000
    signed.required = {
      caseId: randomUUID(),
      uploadId: randomUUID(),
      manifest,
      items,
      platformAccountIdHash: signed.required.platformAccountIdHash,
      backupStartedAt: nowBeforeBackup,
      allDevicesStoppedAt: now
    }
    Object.assign(signed.proof, {
      caseId: signed.required.caseId,
      uploadId: signed.required.uploadId,
      restoreId: manifest.context.restoreId,
      contextHash: manifest.context.contextHash,
      inventoryBasisHash: manifest.basisHash,
      scope,
      historyFrom: nowBeforeBackup - 1,
      observedThrough: now,
      capturedAt: now
    })
    const known = new Map<
      string,
      {
        sourceMessageId: string
        position: number
        direction: 'inbound' | 'human_outbound' | 'automation_outbound'
        contentHash: string
        sentAt: number
      }
    >()
    for (const item of items)
      if (item.kind === 'message')
        known.set(item.sourceMessageId, {
          sourceMessageId: item.sourceMessageId,
          position: 0,
          direction: item.direction,
          contentHash: item.contentHash,
          sentAt: item.observedAt
        })
    const messages = [...known.values()].map((value, index) => ({ ...value, position: index + 1 }))
    signed.proof.conversations = [
      {
        conversationId: f.task.conversationId,
        complete: true,
        hasGap: false,
        nextPageToken: null,
        messages
      }
    ]
    const verifier = signed.verifier()
    expect(verifier.check(signed.envelope(), signed.required, now)).toMatchObject({
      messages: 55,
      localMessageAnchors: 55,
      additionalMessages: 0,
      executionOutcomesVerified: false,
      canRelease: false
    })
    const partial = { ...signed.required, items: inventory.items }
    expect(() => verifier.check(signed.envelope(), partial, now)).toThrow(
      'restore_history_inventory_invalid'
    )
    const after: RestoreInventoryItem[] = []
    ledger.visitRestoreInventory(scope, (item) => after.push(item))
    expect(hashContext(after)).toBe(before)
    expect(after.find((item) => item.kind === 'execution')).toMatchObject({ status: 'unknown' })
    expect(ledger.requiresRestoreReview()).toBe(true)
    expect(ledger.restoreContext()?.contextHash).toBe(beforeContext)
    expect(JSON.stringify(signed.proof)).not.toContain('foreign-message')
  } finally {
    ledger.close()
  }
})
