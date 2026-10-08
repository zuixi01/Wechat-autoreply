import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { Ledger } from '../../src/core/persistence/ledger'
import { taskFixture } from '../fixtures/task'
import { workbenchScopeOf } from '../../src/shared/contracts/workbench'
import { hashDraft, hashContext } from '../../src/core/reply/hashes'
import {
  createLedgerBackup,
  verifyLedgerBackup,
  restoreLedgerBackup
} from '../../src/core/persistence/ledger-backup'

const fixture = taskFixture(),
  scope = workbenchScopeOf(fixture.task.identity)
const event = {
  kind: 'correction' as const,
  task: fixture.task,
  draft: fixture.draft,
  input: { sourceId: 'correction-A', text: '先核对订单状态', reason: '员工明确纠正' },
  at: fixture.now
}
const ledgers: Ledger[] = [],
  directories: string[] = []
afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close()
  for (const directory of directories.splice(0)) {
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep + 'learning-outbox-'))
      throw new Error('unexpected_learning_fixture')
    rmSync(directory, { recursive: true, force: true })
  }
})
function memory() {
  const ledger = new Ledger(':memory:', fixture.now)
  ledgers.push(ledger)
  return ledger
}

describe('durable task-bound learning outbox', () => {
  it('forgets matching account bodies from every local device without touching another customer or account', () => {
    const ledger = memory()
    const otherDevice = {
      ...event,
      task: { ...event.task, identity: { ...event.task.identity, agentId: 'agent-B' } },
      input: { ...event.input, sourceId: 'device-B' }
    }
    const otherCustomer = {
      ...event,
      task: { ...event.task, conversationId: 'customer-B' },
      input: { ...event.input, sourceId: 'customer-B' }
    }
    const otherAccount = {
      ...event,
      task: { ...event.task, identity: { ...event.task.identity, accountId: 'account-B' } },
      input: { ...event.input, sourceId: 'account-B' }
    }
    for (const entry of [event, otherDevice, otherCustomer, otherAccount])
      ledger.learning.enqueue(entry)
    ledger.learning.forgetAccount(scope, fixture.task.conversationId)
    expect(ledger.learning.state(scope, event.input.sourceId)).toBe('forgotten')
    expect(ledger.learning.state(otherDevice.task.identity, otherDevice.input.sourceId)).toBe(
      'forgotten'
    )
    expect(ledger.learning.state(scope, otherCustomer.input.sourceId)).toBe('pending')
    expect(ledger.learning.state(otherAccount.task.identity, otherAccount.input.sourceId)).toBe(
      'pending'
    )
    expect(() => ledger.learning.enqueue(otherDevice)).toThrow('learning_event_forgotten')
  })
  it('persists authoritative customer retention across reopen and applies the original evidence time', () => {
    const directory = mkdtempSync(join(tmpdir(), 'learning-outbox-'))
    directories.push(directory)
    const path = join(directory, 'ledger.sqlite'),
      first = new Ledger(path, fixture.now)
    ledgers.push(first)
    first.learning.enqueue(event)
    first.learning.setRetention(scope, fixture.task.conversationId, 7)
    first.close()
    ledgers.splice(ledgers.indexOf(first), 1)
    const recovered = new Ledger(path, fixture.now + 8 * 86400000)
    ledgers.push(recovered)
    expect(recovered.learning.pending(scope, fixture.now + 8 * 86400000)).toEqual([])
    expect(recovered.learning.state(scope, event.input.sourceId)).toBe('forgotten')
    const inspection = new DatabaseSync(path, { readOnly: true })
    try {
      expect(inspection.prepare('SELECT payload FROM learning_outbox').get()?.payload).toBeNull()
    } finally {
      inspection.close()
    }
  })
  it('keeps customer retention separate and exposes only validated pending conversation selectors', () => {
    const ledger = memory(),
      other = {
        ...event,
        task: { ...event.task, conversationId: 'other-customer' },
        input: { ...event.input, sourceId: 'other-event' }
      }
    ledger.learning.enqueue(event)
    ledger.learning.enqueue(other)
    expect(new Set(ledger.learning.pendingConversations(scope))).toEqual(
      new Set([fixture.task.conversationId, 'other-customer'])
    )
    ledger.learning.setRetention(scope, fixture.task.conversationId, 7)
    ledger.learning.setRetention(scope, 'other-customer', 365)
    expect(ledger.learning.pending(scope, fixture.now + 100 * 86400000)).toEqual([other])
    expect(() => ledger.learning.setRetention(scope, 'other-customer', 0)).toThrow()
    expect(ledger.learning.pendingConversations({ ...scope, accountId: 'foreign' })).toEqual([])
  })
  it('migrates an earlier raw-source outbox in place without resetting its event id or evidence time', () => {
    const directory = mkdtempSync(join(tmpdir(), 'learning-outbox-'))
    directories.push(directory)
    const path = join(directory, 'ledger.sqlite'),
      first = new Ledger(path, fixture.now)
    ledgers.push(first)
    first.learning.enqueue(event)
    first.close()
    ledgers.splice(ledgers.indexOf(first), 1)
    const legacy = new DatabaseSync(path)
    legacy.prepare('UPDATE learning_outbox SET source_id=?').run(event.input.sourceId)
    legacy.exec("DELETE FROM runtime_metadata WHERE key='learning_outbox_source_format'")
    legacy.close()
    const upgraded = new Ledger(path, fixture.now + 1000)
    ledgers.push(upgraded)
    expect(upgraded.learning.pending(scope, fixture.now + 1000)).toEqual([event])
    upgraded.learning.enqueue({ ...event, at: fixture.now + 1000 })
    const inspection = new DatabaseSync(path, { readOnly: true })
    try {
      expect(inspection.prepare('SELECT source_id FROM learning_outbox').all()).toEqual([
        { source_id: hashContext(event.input.sourceId) }
      ])
    } finally {
      inspection.close()
    }
  })
  it('backs up the current schema and restores legacy schema 11 through a forward migration with its fence intact', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'learning-outbox-'))
    directories.push(directory)
    const path = join(directory, 'ledger.sqlite'),
      ledger = new Ledger(path, fixture.now)
    ledgers.push(ledger)
    const source = new DatabaseSync(path)
    try {
      const current = await createLedgerBackup(source, join(directory, 'backups'))
      expect(current.manifest.schemaVersion).toBe(13)
      expect((await verifyLedgerBackup(current.directory)).schemaVersion).toBe(13)
      source.exec(
        'DROP TABLE learning_outbox; DROP TABLE learning_submissions; PRAGMA user_version=11'
      )
      const legacy = await createLedgerBackup(source, join(directory, 'backups'))
      expect(legacy.manifest.schemaVersion).toBe(11)
      const restored = await restoreLedgerBackup(legacy.directory, join(directory, 'restored'))
      const upgraded = new Ledger(restored.databasePath, fixture.now)
      ledgers.push(upgraded)
      expect(upgraded.requiresRestoreReview()).toBe(true)
      expect(upgraded.restoreContext()?.restoreId).toBe(restored.restoreContext.restoreId)
      expect(upgraded.learning.pending(scope, fixture.now)).toEqual([])
      upgraded.learning.enqueue(event)
      expect(upgraded.learning.pending(scope, fixture.now)).toEqual([event])
    } finally {
      source.close()
    }
  })
  it('recovers the same event id after a real SQLite close and reopen without renewing its time', () => {
    const directory = mkdtempSync(join(tmpdir(), 'learning-outbox-'))
    directories.push(directory)
    const path = join(directory, 'ledger.sqlite'),
      first = new Ledger(path, fixture.now)
    ledgers.push(first)
    expect(first.learning.enqueue(event)).toBe(event.input.sourceId)
    first.close()
    ledgers.splice(ledgers.indexOf(first), 1)
    const recovered = new Ledger(path, fixture.now + 1000)
    ledgers.push(recovered)
    expect(recovered.learning.pending(scope, fixture.now + 1000)).toEqual([event])
    expect(recovered.learning.enqueue({ ...event, at: fixture.now + 1000 })).toBe(
      event.input.sourceId
    )
    expect(recovered.learning.pending(scope, fixture.now + 1000)).toEqual([event])
    expect(recovered.learning.state(scope, event.input.sourceId)).toBe('pending')
  })
  it('acknowledges once and retains only the idempotency fingerprint rather than private event text', () => {
    const directory = mkdtempSync(join(tmpdir(), 'learning-outbox-'))
    directories.push(directory)
    const path = join(directory, 'ledger.sqlite'),
      ledger = new Ledger(path, fixture.now)
    ledgers.push(ledger)
    ledger.learning.enqueue(event)
    ledger.learning.acknowledge(scope, event.input.sourceId)
    ledger.learning.acknowledge(scope, event.input.sourceId)
    const inspection = new DatabaseSync(path, { readOnly: true })
    try {
      const receipt = inspection.prepare('SELECT * FROM learning_outbox').get()
      expect(receipt?.payload).toBeNull()
      expect(JSON.stringify(receipt)).not.toContain(event.input.sourceId)
    } finally {
      inspection.close()
    }
    expect(ledger.learning.pending(scope, fixture.now)).toEqual([])
    expect(ledger.learning.state(scope, event.input.sourceId)).toBe('saved')
    ledger.learning.enqueue({ ...event, at: fixture.now + 1000 })
    expect(ledger.learning.pending(scope, fixture.now + 1000)).toEqual([])
    expect(() =>
      ledger.learning.enqueue({ ...event, input: { ...event.input, text: 'changed' } })
    ).toThrow('learning_event_conflict')
  })
  it('keeps accounts and devices separate and does not acknowledge another scope', () => {
    const ledger = memory(),
      other = { ...scope, accountId: 'account-B' },
      otherDevice = { ...scope, agentId: 'agent-B' }
    ledger.learning.enqueue(event)
    expect(ledger.learning.pending(other, fixture.now)).toEqual([])
    expect(ledger.learning.pending(otherDevice, fixture.now)).toEqual([])
    ledger.learning.acknowledge(other, event.input.sourceId)
    expect(ledger.learning.state(scope, event.input.sourceId)).toBe('pending')
    expect(ledger.learning.pending(scope, fixture.now)).toEqual([event])
  })
  it('rejects forged drafts and unexpected credential or scope fields before persistence', () => {
    const ledger = memory()
    expect(() =>
      ledger.learning.enqueue({ ...event, draft: { ...event.draft, text: 'forged' } })
    ).toThrow()
    expect(() =>
      ledger.learning.enqueue({ ...event, draft: { ...event.draft, taskId: 'different' } })
    ).toThrow()
    expect(() =>
      ledger.learning.enqueue({ ...event, credential: 'must-not-be-stored' } as typeof event)
    ).toThrow()
    expect(() =>
      ledger.learning.enqueue({ ...event, input: { ...event.input, scope: {} } } as typeof event)
    ).toThrow()
    expect(ledger.learning.pending(scope, fixture.now)).toEqual([])
  })
  it('forgets a conversation without replaying its event or removing another conversation', () => {
    const ledger = memory(),
      second = {
        ...event,
        task: { ...event.task, taskId: 'task-B', conversationId: 'customer-B' },
        draft: { ...event.draft, taskId: 'task-B' },
        input: { ...event.input, sourceId: 'correction-B' }
      }
    ledger.learning.enqueue(event)
    ledger.learning.enqueue(second)
    ledger.learning.forget(scope, fixture.task.conversationId)
    expect(ledger.learning.pending(scope, fixture.now)).toEqual([second])
    expect(() => ledger.learning.enqueue(event)).toThrow('learning_event_forgotten')
    ledger.learning.acknowledge(scope, event.input.sourceId)
    expect(ledger.learning.state(scope, event.input.sourceId)).toBe('forgotten')
    ledger.learning.forget(scope)
    expect(ledger.learning.pending(scope, fixture.now)).toEqual([])
    expect(() => ledger.learning.enqueue(second)).toThrow('learning_event_forgotten')
  })
  it('expires against original task time and clears pending private text while preserving a tombstone', () => {
    const ledger = memory(),
      end = event.task.createdAt + 7 * 86400000
    ledger.learning.enqueue({ ...event, at: end - 1 })
    expect(ledger.learning.pending(scope, end - 1, 7)).toHaveLength(1)
    expect(ledger.learning.pending(scope, end, 7)).toEqual([])
    expect(ledger.learning.state(scope, event.input.sourceId)).toBe('forgotten')
    expect(() => ledger.learning.enqueue({ ...event, at: end })).toThrow('learning_event_forgotten')
  })
  it('persists separate explicit adoption and outcome events without implying a send', () => {
    const ledger = memory()
    ledger.learning.enqueue({
      ...event,
      kind: 'feedback',
      input: { sourceId: 'adopt-A', kind: 'adopted', reason: '明确采纳' }
    })
    ledger.learning.enqueue({
      ...event,
      kind: 'result',
      input: { sourceId: 'result-A', outcome: 'resolved', reason: '员工确认解决' }
    })
    expect(ledger.learning.pending(scope, fixture.now).map((item) => item.kind)).toEqual([
      'feedback',
      'result'
    ])
    expect(ledger.findTask(fixture.task.identity, fixture.task.taskId)).toBeUndefined()
  })
  it('detects durable payload tampering and never returns a forged stored event', () => {
    const directory = mkdtempSync(join(tmpdir(), 'learning-outbox-'))
    directories.push(directory)
    const path = join(directory, 'ledger.sqlite'),
      ledger = new Ledger(path, fixture.now)
    ledgers.push(ledger)
    ledger.learning.enqueue(event)
    ledger.close()
    ledgers.splice(ledgers.indexOf(ledger), 1)
    const database = new DatabaseSync(path)
    database.prepare('UPDATE learning_outbox SET payload=?').run(
      JSON.stringify({
        ...event,
        draft: { ...event.draft, text: 'tampered', draftHash: hashDraft('tampered') }
      })
    )
    database.close()
    const reopened = new Ledger(path, fixture.now)
    ledgers.push(reopened)
    expect(() => reopened.learning.pending(scope, fixture.now)).toThrow('learning_outbox_corrupt')
  })
})
