import { afterEach, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Ledger } from '../../src/core/persistence/ledger'
import { createLedgerBackup, restoreLedgerBackup } from '../../src/core/persistence/ledger-backup'
import { taskFixture } from '../fixtures/task'
import type { DeviceScope } from '../../src/shared/contracts/registration'
import { hashContext } from '../../src/core/reply/hashes'
import { createHash } from 'node:crypto'

const roots: string[] = [],
  execute = promisify(execFile)
const scope: DeviceScope = {
  tenant_id: 'company',
  employee_id: 'employee-A',
  account_id: 'account-A',
  agent_id: 'agent-A',
  platform: 'wework'
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep + 'restore-inventory-'))
      throw Error('unexpected_fixture_root')
    rmSync(root, { recursive: true, force: true })
  }
})
async function setup(central = false, emptyConversation = false) {
  const root = mkdtempSync(join(tmpdir(), 'restore-inventory-'))
  roots.push(root)
  const path = join(root, 'original.sqlite'),
    ledger = new Ledger(path),
    f = taskFixture()
  const message = (id: string, identity = f.task.identity) => ({
    identity,
    conversationId: 'customer-A',
    sourceMessageId: id,
    direction: 'inbound' as const,
    kind: 'text' as const,
    text: '私有内容不能进入核对报告',
    observedAt: 1000,
    identityVerified: true,
    messageIdVerified: true
  })
  ledger.observe(message('handled'))
  ledger.observe(message('unhandled'))
  ledger.observe(message('foreign', { ...f.task.identity, accountId: 'account-B' }))
  ledger.observe(
    message('previous-login', {
      ...f.task.identity,
      loginEpoch: 0,
      clientInstanceId: 'old-process'
    })
  )
  ledger.setHumanOwned(f.task.identity, 'customer-A', true)
  const send = ledger.prepare(f.task, f.draft.draftHash, 1000).record
  ledger.transition(send.executionId, 'prepared', 'dispatching', 1001)
  if (emptyConversation) {
    ledger.prepare(
      { ...f.task, taskId: 'empty-task', conversationId: 'empty-customer' },
      f.draft.draftHash,
      1000
    )
    ledger.markGap(f.task.identity, 'empty-customer')
    ledger.setHumanOwned(f.task.identity, 'empty-customer', false)
  }
  if (central)
    ledger.central.begin(
      send.executionId,
      {
        taskId: f.task.taskId,
        taskHash: hashContext(f.task),
        draftHash: f.draft.draftHash,
        draftRevision: 1,
        loginEpoch: 1,
        clientInstanceId: 'process-A',
        leaseVersion: 7
      },
      1002
    )
  const db = new DatabaseSync(path)
  db.prepare("UPDATE messages SET handled_execution=? WHERE source_id='handled'").run(
    send.executionId
  )
  const backup = await createLedgerBackup(db, join(root, 'backups'))
  db.close()
  ledger.close()
  const restored = await restoreLedgerBackup(backup.directory, join(root, 'restored'))
  return { root, f, restored, send }
}
it('visits all metadata exactly once in source hash order without truncating at the preview page limit', async () => {
  const f = await setup(true, true),
    ledger = new Ledger(f.restored.databasePath)
  try {
    const all: import('../../src/shared/contracts/restore-inventory').RestoreInventoryItem[] = []
    const report = ledger.visitRestoreInventory(scope, (item) => all.push(item))
    expect(all).toHaveLength(report.summary.messages + report.summary.executions)
    expect(all.map((i) => i.key)).toEqual([...all.map((i) => i.key)].sort())
    const digest = createHash('sha256').update(
      hashContext({ formatVersion: 1, context: report.context, scope: report.scope })
    )
    for (const item of all) digest.update(hashContext(item))
    expect(digest.update(hashContext(report.summary)).digest('hex')).toBe(report.basisHash)
    expect(JSON.stringify(all)).not.toContain('私有内容不能进入核对报告')
    expect(ledger.requiresRestoreReview()).toBe(true)
  } finally {
    ledger.close()
  }
})

it('reports exact handled and unhandled local messages across login epochs without exposing other accounts or text', async () => {
  const f = await setup(),
    ledger = new Ledger(f.restored.databasePath)
  try {
    const report = ledger.restoreInventory(scope)
    expect(report).toMatchObject({
      context: f.restored.restoreContext,
      scope,
      canRelease: false,
      externalEvidenceRequired: true,
      summary: {
        conversations: 2,
        messages: 3,
        inbound: 3,
        handledInbound: 1,
        unhandledInbound: 2,
        executions: 1,
        unknownExecutions: 1
      }
    })
    const messages = report.items.filter((item) => item.kind === 'message')
    expect(messages.map((item) => item.sourceMessageId).sort()).toEqual([
      'handled',
      'previous-login',
      'unhandled'
    ])
    expect(messages.find((item) => item.sourceMessageId === 'unhandled')).toMatchObject({
      sequence: 2,
      handledBy: null,
      humanOwned: true
    })
    expect(JSON.stringify(report)).not.toContain('私有内容')
    expect(JSON.stringify(report)).not.toContain('account-B')
    expect(ledger.getSend(f.send.executionId)?.status).toBe('unknown')
    expect(ledger.requiresRestoreReview()).toBe(true)
    expect(() => ledger.prepare(f.f.task, f.f.draft.draftHash, 2000)).toThrow(
      'ledger_restore_reconciliation_required'
    )
  } finally {
    ledger.close()
  }
})

it('binds pagination to all rows, including unseen message progress and execution state', async () => {
  const f = await setup(),
    ledger = new Ledger(f.restored.databasePath)
  try {
    const first = ledger.restoreInventory(scope, { limit: 1 })
    expect(first.items).toHaveLength(1)
    const second = ledger.restoreInventory(scope, {
      limit: 1,
      after: first.nextAfter!,
      expectedBasisHash: first.basisHash
    })
    expect(second.items[0].key).not.toBe(first.items[0].key)
    const db = new DatabaseSync(f.restored.databasePath)
    db.exec("UPDATE messages SET handled_execution='skip:later-review' WHERE source_id='unhandled'")
    db.close()
    expect(() =>
      ledger.restoreInventory(scope, {
        after: first.nextAfter!,
        expectedBasisHash: first.basisHash
      })
    ).toThrow('ledger_restore_inventory_conflict')
    const fresh = ledger.restoreInventory(scope)
    expect(fresh.summary.handledInbound).toBe(2)
    expect(fresh.basisHash).not.toBe(first.basisHash)
  } finally {
    ledger.close()
  }
})

it('marks missing local sequence history instead of treating a high sequence as a complete watermark', async () => {
  const f = await setup(),
    ledger = new Ledger(f.restored.databasePath),
    db = new DatabaseSync(f.restored.databasePath)
  try {
    const before = ledger.restoreInventory(scope)
    db.exec("DELETE FROM messages WHERE source_id='handled'")
    const report = ledger.restoreInventory(scope)
    expect(
      report.items.find((item) => item.kind === 'message' && item.sourceMessageId === 'unhandled')
    ).toMatchObject({ sequence: 2, lastSequence: 2, sequenceComplete: false, handledBy: null })
    expect(report.basisHash).not.toBe(before.basisHash)
    expect(report.canRelease).toBe(false)
  } finally {
    db.close()
    ledger.close()
  }
})

it('binds the original central request to its local task and keeps response loss unresolved', async () => {
  const f = await setup(true),
    ledger = new Ledger(f.restored.databasePath),
    db = new DatabaseSync(f.restored.databasePath)
  try {
    const report = ledger.restoreInventory(scope)
    expect(report.summary).toMatchObject({ unknownExecutions: 1, pendingCentral: 1 })
    expect(report.items.find((item) => item.kind === 'execution')).toMatchObject({
      phase: 'unresolved',
      permitId: null,
      receiptHash: null
    })
    const request = JSON.parse(
      String(db.prepare('SELECT request_json FROM central_attempts').get()?.request_json)
    )
    request.taskHash = 'f'.repeat(64)
    db.prepare('UPDATE central_attempts SET request_json=?').run(JSON.stringify(request))
    expect(() => ledger.restoreInventory(scope)).toThrow('ledger_restore_inventory_invalid')
  } finally {
    db.close()
    ledger.close()
  }
})

it('invalidates pagination when an unseen original request revision or central timestamp changes', async () => {
  const f = await setup(true),
    ledger = new Ledger(f.restored.databasePath),
    db = new DatabaseSync(f.restored.databasePath)
  try {
    const before = ledger.restoreInventory(scope, { limit: 1 })
    const request = JSON.parse(
      String(db.prepare('SELECT request_json FROM central_attempts').get()?.request_json)
    )
    request.draftRevision = 2
    db.prepare('UPDATE central_attempts SET request_json=?,updated_at=9999').run(
      JSON.stringify(request)
    )
    expect(() =>
      ledger.restoreInventory(scope, {
        after: before.nextAfter!,
        expectedBasisHash: before.basisHash
      })
    ).toThrow('ledger_restore_inventory_conflict')
  } finally {
    db.close()
    ledger.close()
  }
})

it('includes the complete stored permit in the basis and counts its unknown status', async () => {
  const f = await setup(true),
    ledger = new Ledger(f.restored.databasePath),
    db = new DatabaseSync(f.restored.databasePath)
  try {
    const permit = {
      permitId: 'permit-A',
      identity: f.f.task.identity,
      taskId: f.f.task.taskId,
      conversationId: 'customer-A',
      taskHash: hashContext(f.f.task),
      draftHash: f.f.draft.draftHash,
      draftRevision: 1,
      leaseVersion: 7,
      issuedAt: 1000,
      expiresAt: 20000,
      status: 'issued',
      newlyIssued: true
    }
    db.prepare('UPDATE central_attempts SET permit_id=?,permit_json=?').run(
      permit.permitId,
      JSON.stringify(permit)
    )
    db.exec("UPDATE sends SET status='confirmed'")
    const before = ledger.restoreInventory(scope)
    permit.status = 'unknown'
    permit.expiresAt = 30000
    permit.newlyIssued = false
    db.prepare('UPDATE central_attempts SET permit_json=?').run(JSON.stringify(permit))
    const after = ledger.restoreInventory(scope)
    expect(after.summary.unknownExecutions).toBe(1)
    expect(after.basisHash).not.toBe(before.basisHash)
  } finally {
    db.close()
    ledger.close()
  }
})

it('rejects duplicated sequence keys even after the messages schema constraints are removed', async () => {
  const f = await setup(),
    ledger = new Ledger(f.restored.databasePath),
    db = new DatabaseSync(f.restored.databasePath)
  try {
    db.exec(
      "ALTER TABLE messages RENAME TO original_messages; CREATE TABLE messages AS SELECT * FROM original_messages; DROP TABLE original_messages; UPDATE messages SET sequence=1 WHERE source_id='unhandled'"
    )
    expect(() => ledger.restoreInventory(scope, { limit: 1 })).toThrow(
      'ledger_restore_inventory_invalid'
    )
  } finally {
    db.close()
    ledger.close()
  }
})

it('rejects orphaned central attempts instead of reporting zero pending executions', async () => {
  const f = await setup(true),
    ledger = new Ledger(f.restored.databasePath),
    db = new DatabaseSync(f.restored.databasePath)
  try {
    db.exec('PRAGMA foreign_keys=OFF; DELETE FROM sends')
    expect(db.prepare('PRAGMA foreign_key_check').get()).toBeDefined()
    expect(() => ledger.restoreInventory(scope)).toThrow('ledger_restore_inventory_invalid')
  } finally {
    db.close()
    ledger.close()
  }
})

it('covers an execution conversation with no messages and binds later human takeover and gap changes', async () => {
  const f = await setup(false, true),
    ledger = new Ledger(f.restored.databasePath)
  try {
    const before = ledger.restoreInventory(scope)
    expect(before.summary.conversations).toBe(3)
    expect(
      before.items.find(
        (item) => item.kind === 'execution' && item.conversationId === 'empty-customer'
      )
    ).toMatchObject({
      localRangePresent: false,
      conversation: { hasGap: true, humanOwned: false, lastSequence: 0 }
    })
    ledger.setHumanOwned(f.f.task.identity, 'empty-customer', true)
    ledger.markGap(f.f.task.identity, 'empty-customer')
    expect(() => ledger.restoreInventory(scope, { expectedBasisHash: before.basisHash })).toThrow(
      'ledger_restore_inventory_conflict'
    )
  } finally {
    ledger.close()
  }
})

it('rejects corrupted message fingerprints and missing restoration provenance without changing the fence', async () => {
  const f = await setup(),
    ledger = new Ledger(f.restored.databasePath),
    db = new DatabaseSync(f.restored.databasePath)
  try {
    db.exec("UPDATE messages SET payload_hash='bad' WHERE source_id='unhandled'")
    expect(() => ledger.restoreInventory(scope)).toThrow('ledger_restore_inventory_invalid')
    db.exec("UPDATE runtime_metadata SET value=0 WHERE key='restore_review_required'")
    expect(() => ledger.restoreInventory(scope)).toThrow('ledger_restore_inventory_invalid')
    expect(ledger.requiresRestoreReview()).toBe(true)
  } finally {
    db.close()
    ledger.close()
  }
})

it('keeps foreign device metadata out of a scoped report and rejects invalid page or role fields', async () => {
  const f = await setup(),
    ledger = new Ledger(f.restored.databasePath)
  try {
    expect(ledger.restoreInventory({ ...scope, agent_id: 'other-agent' }).summary.messages).toBe(0)
    expect(() => ledger.restoreInventory({ ...scope, role: 'admin' })).toThrow(
      'ledger_restore_inventory_invalid'
    )
    expect(() => ledger.restoreInventory(scope, { limit: 101 })).toThrow(
      'ledger_restore_inventory_invalid'
    )
  } finally {
    ledger.close()
  }
})

it('runs the offline inventory CLI against a real restored database without reopening a mutating Ledger', async () => {
  const f = await setup(),
    scopeFile = join(f.root, 'scope.json')
  writeFileSync(scopeFile, JSON.stringify(scope))
  const cli = (...args: string[]) =>
    execute(
      process.execPath,
      [resolve('node_modules/tsx/dist/cli.mjs'), resolve('scripts/ledger-recovery.ts'), ...args],
      { windowsHide: true, timeout: 10000, maxBuffer: 65536 }
    )
  const result = await cli(
    'inspect-inventory',
    '--source',
    f.restored.databasePath,
    '--scope',
    scopeFile,
    '--limit',
    '1'
  )
  const report = JSON.parse(result.stdout)
  expect(report).toMatchObject({
    passed: true,
    command: 'inspect-inventory',
    canRelease: false,
    summary: { messages: 3, executions: 1 }
  })
  const db = new DatabaseSync(f.restored.databasePath, { readOnly: true })
  try {
    expect(db.prepare('SELECT status FROM sends').get()?.status).toBe('dispatching')
  } finally {
    db.close()
  }
  await expect(
    cli(
      'inspect-inventory',
      '--source',
      f.restored.databasePath,
      '--scope',
      scopeFile,
      '--limit',
      '1',
      '--limit',
      '2'
    )
  ).rejects.toThrow()
})
