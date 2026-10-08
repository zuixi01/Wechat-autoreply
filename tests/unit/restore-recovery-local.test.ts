import { afterEach, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { Ledger } from '../../src/core/persistence/ledger'
import { restoreObservationFixture } from '../fixtures/restore-observation'
import { createLedgerBackup, restoreLedgerBackup } from '../../src/core/persistence/ledger-backup'
import { hashContext } from '../../src/core/reply/hashes'
import { taskFixture } from '../fixtures/task'
import {
  RestoreRecoveryPackageSchema,
  type RestoreRecoveryPackage
} from '../../src/shared/contracts/restore-recovery'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep + 'restore-recovery-'))
      throw Error('unexpected_fixture_root')
    rmSync(root, { recursive: true, force: true })
  }
})
async function setup(extra = 0) {
  const root = mkdtempSync(join(tmpdir(), 'restore-recovery-'))
  roots.push(root)
  const sourcePath = join(root, 'source.sqlite'),
    original = new Ledger(sourcePath),
    f = taskFixture()
  const message = (
    id: string,
    conversationId = f.task.conversationId,
    identity = f.task.identity
  ) => ({
    identity,
    conversationId,
    sourceMessageId: id,
    direction: 'inbound' as const,
    kind: 'text' as const,
    text: 'synthetic customer text',
    observedAt: 1000,
    identityVerified: true,
    messageIdVerified: true
  })
  original.observe(message('one'))
  for (let i = 0; i < extra; i++) original.observe(message('extra-' + i))
  original.observe(
    message('foreign', f.task.conversationId, { ...f.task.identity, accountId: 'foreign' })
  )
  const unknown = original.prepare(f.task, f.draft.draftHash, 1000).record
  original.transition(unknown.executionId, 'prepared', 'dispatching', 1001)
  original.transition(unknown.executionId, 'dispatching', 'unknown', 1002)
  const empty = original.prepare(
    { ...f.task, taskId: 'empty-task', conversationId: 'empty-execution' },
    f.draft.draftHash,
    1000
  ).record
  const db = new DatabaseSync(sourcePath),
    backup = await createLedgerBackup(db, join(root, 'backup'))
  db.close()
  original.close()
  const restored = await restoreLedgerBackup(backup.directory, join(root, 'restored')),
    ledger = new Ledger(restored.databasePath),
    scope = {
      tenant_id: f.task.identity.tenantId,
      employee_id: f.task.identity.employeeId,
      account_id: f.task.identity.accountId,
      agent_id: f.task.identity.agentId,
      platform: f.task.identity.platform
    }
  const conversations = new Map<
    string,
    RestoreRecoveryPackage['boundary']['history']['conversations'][number]
  >()
  const report = ledger.visitRestoreInventory(scope, (item) => {
    let c = conversations.get(item.conversationId)
    if (!c) {
      c = {
        conversationId: item.conversationId,
        complete: true,
        hasGap: false,
        nextPageToken: null,
        messages: []
      }
      conversations.set(item.conversationId, c)
    }
    if (item.kind === 'message')
      c.messages.push({
        sourceMessageId: item.sourceMessageId,
        position: c.messages.length + 1,
        direction: item.direction,
        contentHash: item.contentHash,
        sentAt: 1000
      })
  })
  const { items: _items, nextAfter: _after, ...manifest } = report
  expect(_items.length).toBeGreaterThan(0)
  expect(_after === null).toBe(report.summary.messages + report.summary.executions <= 50)
  conversations.set('source-only', {
    conversationId: 'source-only',
    complete: true,
    hasGap: false,
    nextPageToken: null,
    messages: [
      {
        sourceMessageId: 'unseen',
        position: 1,
        direction: 'inbound',
        contentHash: 'a'.repeat(64),
        sentAt: 1500
      }
    ]
  })
  conversations.set('source-empty', {
    conversationId: 'source-empty',
    complete: true,
    hasGap: false,
    nextPageToken: null,
    messages: []
  })
  const caseId = randomUUID(),
    uploadId = randomUUID(),
    authorizationId = randomUUID(),
    history = {
      formatVersion: 1,
      kind: 'restore-account-history',
      proofId: randomUUID(),
      caseId,
      uploadId,
      restoreId: report.context.restoreId,
      contextHash: report.context.contextHash,
      inventoryBasisHash: report.basisHash,
      scope,
      platformAccountIdHash: 'a'.repeat(64),
      source: { sourceId: 'synthetic', keyId: 'key', version: '1', releaseSha256: 'b'.repeat(64) },
      historyFrom: 0,
      observedThrough: 2000,
      capturedAt: 2000,
      complete: true,
      allConversationsEnumerated: true,
      nextPageToken: null,
      conversations: [...conversations.values()]
    }
  const boundary = {
    formatVersion: 1,
    kind: 'restore-account-boundary',
    authorizationId,
    manifest,
    history,
    historyReceiptHash: 'c'.repeat(64),
    executionReceiptHash: 'd'.repeat(64),
    resolutionBasisHash: 'e'.repeat(64),
    humanOwnershipPolicy: 'all_restored_conversations'
  }
  const input = RestoreRecoveryPackageSchema.parse({
    boundary,
    authorization: {
      formatVersion: 1,
      authorizationId,
      scope,
      caseId,
      uploadId,
      reviewId: randomUUID(),
      restoreId: history.restoreId,
      contextHash: history.contextHash,
      inventoryBasisHash: history.inventoryBasisHash,
      assessmentBasisHash: 'f'.repeat(64),
      historyProofId: history.proofId,
      historyReceiptHash: boundary.historyReceiptHash,
      executionReceiptHash: boundary.executionReceiptHash,
      resolutionBasisHash: boundary.resolutionBasisHash,
      boundaryHash: hashContext(boundary),
      requestHash: 'f'.repeat(64),
      historyPolicy: 'quarantine_all_history',
      recordedBy: 'maintenance',
      recordedAt: 2000,
      expiresAt: 5000,
      status: 'approved_for_boundary',
      localDurableApplicationRequired: true,
      centralCompletionRequired: true,
      physicalFactsVerifiedByThisCommand: false,
      automaticStart: false,
      canRelease: false
    }
  })
  return { root, restored, ledger, f, scope, input, unknown, empty, message }
}
function edit(
  p: RestoreRecoveryPackage,
  change: (p: RestoreRecoveryPackage) => void
): RestoreRecoveryPackage {
  const copy = structuredClone(p)
  change(copy)
  copy.authorization.boundaryHash = hashContext(copy.boundary)
  return copy
}
it('atomically covers every local page and source-only/empty conversation, retaining outcomes and all fences', async () => {
  const f = await setup(110)
  try {
    const before = f.ledger.getSend(f.unknown.executionId),
      empty = f.ledger.getSend(f.empty.executionId)
    const r = f.ledger.applyRestoreRecoveryBoundary(f.scope, f.input, 2500)
    expect(r).toMatchObject({
      quarantinedInboundCount: 111,
      ownedConversationCount: 4,
      sourceMessageCount: 112,
      localExecutionResolutionRequired: true,
      centralConfirmationRequired: true,
      automaticStart: false,
      canRelease: false
    })
    for (const id of [f.f.task.conversationId, 'empty-execution', 'source-only', 'source-empty'])
      expect(
        f.ledger.conversationState(
          { ...f.f.task.identity, loginEpoch: 99, clientInstanceId: 'new-login' },
          id
        ).humanOwned
      ).toBe(true)
    expect(
      f.ledger
        .snapshot(f.f.task.identity, f.f.task.conversationId)
        .messages.every((m) => m.handledBy === `restore-recovery:${r.applicationId}`)
    ).toBe(true)
    expect(
      f.ledger.snapshot({ ...f.f.task.identity, accountId: 'foreign' }, f.f.task.conversationId)
    ).toMatchObject({ humanOwned: false, messages: [{ handledBy: null }] })
    expect(f.ledger.getSend(f.unknown.executionId)).toEqual(before)
    expect(f.ledger.getSend(f.empty.executionId)).toEqual(empty)
    expect(f.ledger.requiresRestoreReview()).toBe(true)
    expect(() =>
      f.ledger.prepare({ ...f.f.task, taskId: 'replay' }, f.f.draft.draftHash, 2501)
    ).toThrow('ledger_restore_reconciliation_required')
  } finally {
    f.ledger.close()
  }
})
it('keeps an exact immutable original receipt across restart, retries, and later observations', async () => {
  const f = await setup()
  let ledger = f.ledger
  try {
    const r = ledger.applyRestoreRecoveryBoundary(f.scope, f.input, 2500)
    const source = restoreObservationFixture(f.input, 2600)
    ledger.installRestoreObservationGrant(f.scope, source.grant, 2600)
    ledger.observe(source.signed({ ...f.message('later'), observedAt: 3000 }), 3000)
    expect(ledger.applyRestoreRecoveryBoundary(f.scope, f.input, 7000)).toEqual(r)
    expect(
      ledger.snapshot(f.f.task.identity, f.f.task.conversationId).messages.at(-1)?.handledBy
    ).toBeNull()
    ledger.close()
    ledger = new Ledger(f.restored.databasePath)
    expect(ledger.restoreRecoveryApplication(r.authorizationId)).toEqual(r)
    expect(ledger.applyRestoreRecoveryBoundary(f.scope, f.input, 8000)).toEqual(r)
    expect(() =>
      ledger.applyRestoreRecoveryBoundary(
        f.scope,
        edit(f.input, (p) => {
          p.boundary.history.conversations[0].messages[0].contentHash = 'f'.repeat(64)
        }),
        2000
      )
    ).toThrow('conflict')
    const db = new DatabaseSync(f.restored.databasePath)
    try {
      expect(() =>
        db.exec('UPDATE ledger_restore_recovery_applications SET receipt_hash=receipt_hash')
      ).toThrow('immutable')
      expect(() => db.exec('DELETE FROM ledger_restore_recovery_applications')).toThrow('immutable')
      db.exec(
        "DROP TRIGGER ledger_restore_recovery_applications_no_update; UPDATE ledger_restore_recovery_applications SET receipt_hash='broken'"
      )
      expect(() => ledger.restoreRecoveryApplication(r.authorizationId)).toThrow('conflict')
    } finally {
      db.close()
    }
  } finally {
    ledger.close()
  }
})
it('rejects missing provenance, wrong target, expired first application and changed local inventory', async () => {
  const f = await setup(),
    fresh = new Ledger(':memory:')
  try {
    expect(() => fresh.applyRestoreRecoveryBoundary(f.scope, f.input, 2500)).toThrow('conflict')
    expect(() =>
      f.ledger.applyRestoreRecoveryBoundary({ ...f.scope, agent_id: 'other' }, f.input, 2500)
    ).toThrow('conflict')
    for (const at of [1999, 5000])
      expect(() => f.ledger.applyRestoreRecoveryBoundary(f.scope, f.input, at)).toThrow('conflict')
    f.ledger.observe(f.message('changed'))
    expect(() => f.ledger.applyRestoreRecoveryBoundary(f.scope, f.input, 2500)).toThrow(
      'ledger_restore_inventory_invalid'
    )
    expect(f.ledger.restoreRecoveryApplication(f.input.authorization.authorizationId)).toBeNull()
  } finally {
    fresh.close()
    f.ledger.close()
  }
})
it('independently rejects uncovered anchors, duplicate identities, incomplete history and broken positions', async () => {
  const f = await setup()
  try {
    const changes: Array<(p: RestoreRecoveryPackage) => void> = [
      (p) => {
        p.boundary.history.conversations[0].messages = []
      },
      (p) => {
        p.boundary.history.conversations[0].messages[0].contentHash = 'f'.repeat(64)
      },
      (p) => {
        p.boundary.history.conversations[0].messages[0].direction = 'automation_outbound'
      },
      (p) => {
        p.boundary.history.conversations[0].messages[0].position = 2
      },
      (p) => {
        p.boundary.history.conversations[0].hasGap = true
      },
      (p) => {
        p.boundary.history.conversations.push(p.boundary.history.conversations[0])
      },
      (p) => {
        p.boundary.history.conversations[0].messages.push({
          ...p.boundary.history.conversations[0].messages[0],
          position: 2
        })
      },
      (p) => {
        p.boundary.history.conversations = p.boundary.history.conversations.filter(
          (c) => c.conversationId !== 'empty-execution'
        )
      },
      (p) => {
        p.authorization.canRelease = true as false
      }
    ]
    for (const change of changes)
      expect(() =>
        f.ledger.applyRestoreRecoveryBoundary(f.scope, edit(f.input, change), 2500)
      ).toThrow()
    expect(f.ledger.snapshot(f.f.task.identity, f.f.task.conversationId)).toMatchObject({
      humanOwned: false,
      messages: [{ handledBy: null }]
    })
  } finally {
    f.ledger.close()
  }
})
it('rolls back message quarantine and all conversation ownership on durable receipt failure', async () => {
  const f = await setup(),
    db = new DatabaseSync(f.restored.databasePath)
  try {
    db.exec(
      `CREATE TRIGGER fail_recovery_control BEFORE UPDATE ON conversation_controls WHEN NEW.human_owned=1 BEGIN SELECT RAISE(ABORT,'synthetic_storage_failure'); END`
    )
    expect(() => f.ledger.applyRestoreRecoveryBoundary(f.scope, f.input, 2500)).toThrow(
      'synthetic_storage_failure'
    )
    expect(f.ledger.restoreRecoveryApplication(f.input.authorization.authorizationId)).toBeNull()
    expect(f.ledger.snapshot(f.f.task.identity, f.f.task.conversationId)).toMatchObject({
      humanOwned: false,
      messages: [{ handledBy: null }]
    })
    expect(f.ledger.conversationState(f.f.task.identity, 'source-only').humanOwned).toBe(false)
    db.exec('DROP TRIGGER fail_recovery_control')
    expect(f.ledger.applyRestoreRecoveryBoundary(f.scope, f.input, 2500).canRelease).toBe(false)
  } finally {
    db.close()
    f.ledger.close()
  }
})
it('preserves the journal in backups while rejecting its old package after another restoration', async () => {
  const f = await setup()
  try {
    const r = f.ledger.applyRestoreRecoveryBoundary(f.scope, f.input, 2500),
      db = new DatabaseSync(f.restored.databasePath, { readOnly: true })
    let backup
    try {
      backup = await createLedgerBackup(db, join(f.root, 'applied-backup'))
    } finally {
      db.close()
    }
    const restored = await restoreLedgerBackup(backup.directory, join(f.root, 'restored-again')),
      next = new Ledger(restored.databasePath)
    try {
      expect(next.restoreRecoveryApplication(r.authorizationId)).toEqual(r)
      expect(() => next.applyRestoreRecoveryBoundary(f.scope, f.input, 2501)).toThrow('conflict')
      expect(next.requiresRestoreReview()).toBe(true)
    } finally {
      next.close()
    }
  } finally {
    f.ledger.close()
  }
})
