import { afterEach, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { Ledger } from '../../src/core/persistence/ledger'
import { createLedgerBackup, restoreLedgerBackup } from '../../src/core/persistence/ledger-backup'
import { hashContext } from '../../src/core/reply/hashes'
import { taskFixture } from '../fixtures/task'
import type { RestoreApplicationDecision } from '../../src/shared/contracts/restore-application'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep + 'restore-application-'))
      throw Error('unexpected_fixture_root')
    rmSync(root, { recursive: true, force: true })
  }
})
async function setup(extraInbound = 0) {
  const root = mkdtempSync(join(tmpdir(), 'restore-application-'))
  roots.push(root)
  const path = join(root, 'source.sqlite'),
    original = new Ledger(path),
    f = taskFixture()
  const message = (
    id: string,
    identity = f.task.identity,
    direction: 'inbound' | 'automation_outbound' = 'inbound'
  ) => ({
    identity,
    conversationId: f.task.conversationId,
    sourceMessageId: id,
    direction,
    kind: 'text' as const,
    text: 'synthetic private text',
    observedAt: 1000,
    identityVerified: true,
    messageIdVerified: true
  })
  original.observe(message('one'))
  original.observe(message('two'))
  original.observe(message('outbound', f.task.identity, 'automation_outbound'))
  original.observe(message('foreign', { ...f.task.identity, accountId: 'foreign' }))
  original.observe(
    message('old-login', { ...f.task.identity, loginEpoch: 0, clientInstanceId: 'old' })
  )
  const unknown = original.prepare(f.task, f.draft.draftHash, 1000).record
  original.transition(unknown.executionId, 'prepared', 'dispatching', 1001)
  original.transition(unknown.executionId, 'dispatching', 'unknown', 1002)
  const empty = original.prepare(
    { ...f.task, taskId: 'empty-task', conversationId: 'empty-customer' },
    f.draft.draftHash,
    1000
  ).record
  for (let index = 0; index < extraInbound; index++) original.observe(message('extra-' + index))
  const db = new DatabaseSync(path)
  const backup = await createLedgerBackup(db, join(root, 'backup'))
  db.close()
  original.close()
  const restored = await restoreLedgerBackup(backup.directory, join(root, 'restored'))
  const ledger = new Ledger(restored.databasePath),
    scope = {
      tenant_id: f.task.identity.tenantId,
      employee_id: f.task.identity.employeeId,
      account_id: f.task.identity.accountId,
      agent_id: f.task.identity.agentId,
      platform: f.task.identity.platform
    }
  try {
    const inventory = ledger.visitRestoreInventory(scope, () => {})
    const { items: _items, nextAfter: _after, ...manifest } = inventory
    expect(_items.length).toBeGreaterThan(0)
    expect(_after === null).toBe(inventory.summary.messages + inventory.summary.executions <= 50)
    const decision = {
      caseId: randomUUID(),
      uploadId: randomUUID(),
      decisionId: randomUUID(),
      basisHash: 'a'.repeat(64),
      rulingsHash: 'b'.repeat(64),
      historyPolicy: 'quarantine' as const,
      reviewedAllSubjects: true as const,
      restoreId: inventory.context.restoreId,
      targetAgentId: scope.agent_id,
      contextHash: inventory.context.contextHash,
      inventoryBasisHash: inventory.basisHash,
      subjectCount: inventory.summary.messages + inventory.summary.executions + 1,
      decidedBy: 'admin',
      decidedAt: 1000,
      applicationRequired: true as const,
      automaticStart: false as const,
      canRelease: false as const
    }
    const input: RestoreApplicationDecision = {
      scope,
      decision,
      decisionHash: hashContext(decision),
      manifest,
      canRelease: false
    }
    return { root, restored, ledger, f, scope, input, unknown, empty, message }
  } catch (error) {
    ledger.close()
    throw error
  }
}
it('rejects applying a reviewed source to an unrestored ledger and covers more than one display page', async () => {
  const f = await setup(150),
    fresh = new Ledger(':memory:')
  try {
    expect(() => fresh.applyRestoreDecision(f.scope, f.input, 2000)).toThrow('conflict')
    const receipt = f.ledger.applyRestoreDecision(f.scope, f.input, 2000)
    expect(receipt.quarantinedInboundCount).toBe(153)
    expect(
      f.ledger
        .snapshot(f.f.task.identity, f.f.task.conversationId)
        .messages.filter(
          (item) =>
            item.direction === 'inbound' && item.handledBy === `restore:${receipt.applicationId}`
        )
    ).toHaveLength(152)
    expect(f.ledger.requiresRestoreReview()).toBe(true)
  } finally {
    fresh.close()
    f.ledger.close()
  }
})
it('persists only the exact central quarantine acknowledgement across restart and never clears the fence', async () => {
  const f = await setup()
  let ledger = f.ledger
  try {
    const receipt = ledger.applyRestoreDecision(f.scope, f.input, 2000)
    const ack = {
      acknowledgementId: randomUUID(),
      applicationId: receipt.applicationId,
      applicationHash: hashContext(receipt),
      scope: f.scope,
      caseId: receipt.caseId,
      decisionId: receipt.decisionId,
      restoreId: receipt.restoreId,
      contextHash: receipt.contextHash,
      recordedAt: 3000,
      status: 'quarantine_recorded',
      externalEvidenceRequired: true,
      automaticStart: false,
      canRelease: false
    }
    expect(ledger.hasRestoreApplicationAck(f.scope)).toBe(false)
    for (const bad of [
      { ...ack, applicationHash: 'f'.repeat(64) },
      { ...ack, scope: { ...f.scope, account_id: 'foreign' } },
      { ...ack, canRelease: true }
    ])
      expect(() => ledger.saveRestoreApplicationAck(receipt, bad)).toThrow()
    expect(ledger.saveRestoreApplicationAck(receipt, ack)).toEqual(ack)
    expect(ledger.saveRestoreApplicationAck(receipt, ack)).toEqual(ack)
    ledger.close()
    ledger = new Ledger(f.restored.databasePath)
    expect(ledger.hasRestoreApplicationAck(f.scope)).toBe(true)
    expect(ledger.hasRestoreApplicationAck({ ...f.scope, account_id: 'foreign' })).toBe(false)
    expect(ledger.requiresRestoreReview()).toBe(true)
    const source = new DatabaseSync(f.restored.databasePath, { readOnly: true })
    let copy
    try {
      copy = await createLedgerBackup(source, join(f.root, 'applied-backup'))
    } finally {
      source.close()
    }
    const restoredAgain = await restoreLedgerBackup(copy.directory, join(f.root, 'restored-again'))
    const next = new Ledger(restoredAgain.databasePath)
    try {
      expect(next.restoreContext()?.previousRestoreId).toBe(receipt.restoreId)
      expect(next.hasRestoreApplicationAck(f.scope)).toBe(false)
      expect(() => next.applyRestoreDecision(f.scope, f.input, 4000)).toThrow('conflict')
      expect(() => next.saveRestoreApplicationAck(receipt, ack)).toThrow('conflict')
      expect(next.requiresRestoreReview()).toBe(true)
    } finally {
      next.close()
    }
    const db = new DatabaseSync(f.restored.databasePath)
    try {
      expect(() => db.exec('DELETE FROM ledger_restore_application_acks')).toThrow('immutable')
      db.exec(
        "DROP TRIGGER ledger_restore_application_acks_no_update; UPDATE ledger_restore_application_acks SET ack_hash='broken'"
      )
      expect(() => ledger.hasRestoreApplicationAck(f.scope)).toThrow()
    } finally {
      db.close()
    }
  } finally {
    ledger.close()
  }
})
it('atomically quarantines all restored inbound history, preserves outcomes and leaves foreign/outbound data untouched', async () => {
  const f = await setup()
  try {
    const beforeUnknown = f.ledger.getSend(f.unknown.executionId),
      beforeEmpty = f.ledger.getSend(f.empty.executionId)
    const receipt = f.ledger.applyRestoreDecision(f.scope, f.input, 2000)
    expect(receipt).toMatchObject({
      decisionId: f.input.decision.decisionId,
      inventoryBasisHash: f.input.manifest.basisHash,
      quarantinedInboundCount: 3,
      canRelease: false,
      centralConfirmationRequired: true
    })
    const state = f.ledger.snapshot(f.f.task.identity, f.f.task.conversationId)
    expect(state.humanOwned).toBe(true)
    expect(
      state.messages
        .filter((m) => m.direction === 'inbound')
        .every((m) => m.handledBy === `restore:${receipt.applicationId}`)
    ).toBe(true)
    expect(state.messages.find((m) => m.sourceMessageId === 'outbound')!.handledBy).toBeNull()
    const foreign = f.ledger.snapshot(
      { ...f.f.task.identity, accountId: 'foreign' },
      f.f.task.conversationId
    )
    expect(foreign.humanOwned).toBe(false)
    expect(foreign.messages[0].handledBy).toBeNull()
    expect(
      f.ledger.snapshot(
        { ...f.f.task.identity, loginEpoch: 0, clientInstanceId: 'old' },
        f.f.task.conversationId
      ).humanOwned
    ).toBe(true)
    expect(f.ledger.snapshot(f.f.task.identity, 'empty-customer').humanOwned).toBe(true)
    expect(f.ledger.getSend(f.unknown.executionId)).toEqual(beforeUnknown)
    expect(f.ledger.getSend(f.empty.executionId)).toEqual(beforeEmpty)
    expect(f.ledger.requiresRestoreReview()).toBe(true)
    await expect(
      Promise.resolve().then(() =>
        f.ledger.prepare({ ...f.f.task, taskId: 'retry' }, f.f.draft.draftHash, 2001)
      )
    ).rejects.toThrow('ledger_restore_reconciliation_required')
  } finally {
    f.ledger.close()
  }
})
it('returns the same durable application after retries and restart without consuming later observations', async () => {
  const f = await setup()
  let ledger = f.ledger
  try {
    const first = ledger.applyRestoreDecision(f.scope, f.input, 2000)
    expect(ledger.applyRestoreDecision(f.scope, f.input, 3000)).toEqual(first)
    ledger.close()
    ledger = new Ledger(f.restored.databasePath)
    ledger.observe(f.message('later'))
    expect(ledger.applyRestoreDecision(f.scope, f.input, 4000)).toEqual(first)
    expect(
      ledger
        .snapshot(f.f.task.identity, f.f.task.conversationId)
        .messages.find((m) => m.sourceMessageId === 'later')!.handledBy
    ).toBeNull()
    expect(ledger.requiresRestoreReview()).toBe(true)
  } finally {
    ledger.close()
  }
})
it('rejects wrong scope, decision hash, source context and changed source basis before mutating history', async () => {
  const f = await setup()
  try {
    for (const mutate of [
      { decisionHash: 'f'.repeat(64) },
      { scope: { ...f.scope, account_id: 'foreign' } },
      { manifest: { ...f.input.manifest, basisHash: 'f'.repeat(64) } }
    ])
      expect(() =>
        f.ledger.applyRestoreDecision(f.scope, { ...f.input, ...mutate }, 2000)
      ).toThrow()
    f.ledger.observe(f.message('new-before-apply'))
    expect(() => f.ledger.applyRestoreDecision(f.scope, f.input, 2000)).toThrow(
      'restore_application_conflict'
    )
    expect(
      f.ledger
        .snapshot(f.f.task.identity, f.f.task.conversationId)
        .messages.every((m) => m.handledBy === null)
    ).toBe(true)
  } finally {
    f.ledger.close()
  }
})
it('rolls back messages, human ownership and the journal together on database failure', async () => {
  const f = await setup(),
    db = new DatabaseSync(f.restored.databasePath)
  try {
    db.exec(
      "CREATE TRIGGER reject_restore_control BEFORE UPDATE ON conversation_controls WHEN NEW.human_owned=1 BEGIN SELECT RAISE(ABORT,'synthetic_application_failure'); END"
    )
    expect(() => f.ledger.applyRestoreDecision(f.scope, f.input, 2000)).toThrow(
      'synthetic_application_failure'
    )
    expect(f.ledger.snapshot(f.f.task.identity, f.f.task.conversationId).humanOwned).toBe(false)
    expect(
      f.ledger
        .snapshot(f.f.task.identity, f.f.task.conversationId)
        .messages.every((m) => m.handledBy === null)
    ).toBe(true)
    db.exec('DROP TRIGGER reject_restore_control')
    const receipt = f.ledger.applyRestoreDecision(f.scope, f.input, 3000)
    expect(receipt.appliedAt).toBe(3000)
  } finally {
    db.close()
    f.ledger.close()
  }
})
it('rejects changed retry content, damaged saved receipts and clearing the old marker', async () => {
  const f = await setup(),
    db = new DatabaseSync(f.restored.databasePath)
  try {
    f.ledger.applyRestoreDecision(f.scope, f.input, 2000)
    const altered = structuredClone(f.input)
    altered.decision.basisHash = 'f'.repeat(64)
    altered.decisionHash = hashContext(altered.decision)
    expect(() => f.ledger.applyRestoreDecision(f.scope, altered, 3000)).toThrow(
      'restore_application_conflict'
    )
    expect(() =>
      db.exec("UPDATE ledger_restore_applications SET receipt_hash=replace(receipt_hash,'a','b')")
    ).toThrow('restore_application_immutable')
    db.exec(
      "DROP TRIGGER ledger_restore_applications_no_update; UPDATE ledger_restore_applications SET receipt_hash=printf('%064d',0)"
    )
    expect(() => f.ledger.applyRestoreDecision(f.scope, f.input, 3000)).toThrow(
      'restore_application_conflict'
    )
    db.exec("UPDATE runtime_metadata SET value=0 WHERE key='restore_review_required'")
    expect(f.ledger.requiresRestoreReview()).toBe(true)
    expect(() => f.ledger.applyRestoreDecision(f.scope, f.input, 4000)).toThrow()
  } finally {
    db.close()
    f.ledger.close()
  }
})
