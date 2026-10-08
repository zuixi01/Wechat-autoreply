import { afterEach, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { rmSync } from 'node:fs'
import { resolve, sep, join } from 'node:path'
import { tmpdir } from 'node:os'
import { Ledger } from '../../src/core/persistence/ledger'
import { createLedgerBackup, restoreLedgerBackup } from '../../src/core/persistence/ledger-backup'
import { AgentRegistration } from '../../src/main/services/agent-registration'
import { restoreResolutionFixture } from '../fixtures/restore-resolution'
import { restoreObservationFixture } from '../fixtures/restore-observation'
import {
  parseRestoreResolutionPackage,
  type RestoreResolutionPackage
} from '../../src/shared/contracts/restore-resolution'
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep + 'restore-resolution-'))
      throw Error('unexpected_fixture_root')
    rmSync(root, { recursive: true, force: true })
  }
})
const fixture = (count = 61) => restoreResolutionFixture((root) => roots.push(root), count)
it('covers every execution beyond the display page and stores original reconciliations and seals without rewriting sends or replay rights', async () => {
  const f = await fixture()
  try {
    const unknown = f.ledger.getSend(f.reconciliation.s.executionId),
      attempt = f.ledger.central.get(f.reconciliation.s.executionId),
      sealed = f.ledger.getSend(f.sealAttempt.s.executionId),
      sealAttempt = f.ledger.central.get(f.sealAttempt.s.executionId)
    expect(f.ledger.restoreInventory(f.scope).nextAfter).not.toBeNull()
    f.ledger.applyRestoreRecoveryBoundary(f.scope, f.approved, 7300)
    const before = f.ledger.snapshot(f.f.task.identity, f.f.task.conversationId),
      receipt = f.ledger.applyRestoreExecutionResolutions(f.scope, f.resolutions, 7400)
    expect(receipt).toMatchObject({
      localExecutions: 63,
      centralPermits: 1,
      requestSeals: 1,
      originalExecutionRecordsPreserved: true,
      centralConfirmationRequired: true,
      automaticStart: false,
      canRelease: false
    })
    expect(f.ledger.getSend(f.reconciliation.s.executionId)).toEqual(unknown)
    expect(f.ledger.central.get(f.reconciliation.s.executionId)).toEqual(attempt)
    expect(f.ledger.getSend(f.sealAttempt.s.executionId)).toEqual(sealed)
    expect(f.ledger.central.get(f.sealAttempt.s.executionId)).toEqual(sealAttempt)
    expect(f.ledger.snapshot(f.f.task.identity, f.f.task.conversationId)).toEqual(before)
    expect(f.ledger.requiresRestoreReview()).toBe(true)
    expect(f.ledger.central.requiresReconciliation()).toBe(true)
    expect(() =>
      f.ledger.prepare({ ...f.f.task, taskId: 'repeat' }, f.f.draft.draftHash, 7500)
    ).toThrow('ledger_restore_reconciliation_required')
  } finally {
    f.ledger.close()
  }
})
it('refuses missing boundary, wrong scope, expired first application, partial coverage and altered original proof bodies', async () => {
  const f = await fixture(2)
  try {
    expect(() => f.ledger.applyRestoreExecutionResolutions(f.scope, f.resolutions, 7400)).toThrow(
      'conflict'
    )
    f.ledger.applyRestoreRecoveryBoundary(f.scope, f.approved, 7300)
    expect(() =>
      f.ledger.applyRestoreExecutionResolutions(
        { ...f.scope, agent_id: 'foreign' },
        f.resolutions,
        7400
      )
    ).toThrow('conflict')
    for (const now of [7199, 37000])
      expect(() => f.ledger.applyRestoreExecutionResolutions(f.scope, f.resolutions, now)).toThrow(
        'conflict'
      )
    const mutations: Array<(p: RestoreResolutionPackage) => void> = [
      (p) => {
        p.localExecutions.pop()
      },
      (p) => {
        p.subjects.pop()
      },
      (p) => {
        p.records.pop()
      },
      (p) => {
        p.review.outcomes.pop()
      },
      (p) => {
        p.authorizationHash = 'a'.repeat(64)
      },
      (p) => {
        p.localExecutions[0].identity.loginEpoch = 99
      },
      (p) => {
        const r = p.records[0]
        if (r.kind === 'reconciled') r.decision.outcome = 'not_sent'
      },
      (p) => {
        const r = p.records[1]
        if (r.kind === 'request_seal') r.seal.input.verificationProofHash = '0'.repeat(64)
      }
    ]
    for (const mutation of mutations) {
      const p = structuredClone(f.resolutions)
      mutation(p)
      expect(() => f.ledger.applyRestoreExecutionResolutions(f.scope, p, 7400)).toThrow()
    }
    expect(
      f.ledger.restoreResolutionApplication(f.approved.authorization.authorizationId)
    ).toBeNull()
  } finally {
    f.ledger.close()
  }
})
it('detects changed original execution fields while retaining the already durable boundary and all old unknown outcomes', async () => {
  const f = await fixture(2),
    db = new DatabaseSync(f.restored.databasePath)
  try {
    const r = f.ledger.applyRestoreRecoveryBoundary(f.scope, f.approved, 7300)
    db.prepare('UPDATE central_attempts SET baseline_sequence=99 WHERE execution_id=?').run(
      f.reconciliation.s.executionId
    )
    expect(() => f.ledger.applyRestoreExecutionResolutions(f.scope, f.resolutions, 7400)).toThrow(
      'ledger_restore_inventory_invalid'
    )
    expect(f.ledger.restoreRecoveryApplication(r.authorizationId)).toEqual(r)
    expect(f.ledger.getSend(f.reconciliation.s.executionId)?.status).toBe('unknown')
    expect(f.ledger.restoreResolutionApplication(r.authorizationId)).toBeNull()
  } finally {
    db.close()
    f.ledger.close()
  }
})
it('keeps the exact committed journal through restart and retries without consuming subsequent observations; damaged hash fails', async () => {
  const f = await fixture(2)
  let ledger = f.ledger
  try {
    ledger.applyRestoreRecoveryBoundary(f.scope, f.approved, 7300)
    const r = ledger.applyRestoreExecutionResolutions(f.scope, f.resolutions, 7400)
    const observations = restoreObservationFixture(f.approved)
    ledger.installRestoreObservationGrant(f.scope, observations.grant, 7450)
    ledger.observe(
      observations.signed({
        identity: f.f.task.identity,
        conversationId: f.f.task.conversationId,
        sourceMessageId: 'subsequent',
        direction: 'inbound',
        kind: 'text',
        text: 'later',
        observedAt: 7500,
        identityVerified: true,
        messageIdVerified: true
      }),
      7500
    )
    ledger.close()
    ledger = new Ledger(f.restored.databasePath)
    expect(ledger.restoreResolutionApplication(r.authorizationId)).toEqual(r)
    expect(ledger.applyRestoreExecutionResolutions(f.scope, f.resolutions, 40000)).toEqual(r)
    expect(
      ledger.snapshot(f.f.task.identity, f.f.task.conversationId).messages.at(-1)?.handledBy
    ).toBeNull()
    const db = new DatabaseSync(f.restored.databasePath)
    try {
      expect(() =>
        db.exec('UPDATE ledger_restore_resolution_applications SET receipt_hash=receipt_hash')
      ).toThrow('immutable')
      expect(() => db.exec('DELETE FROM ledger_restore_resolution_applications')).toThrow(
        'immutable'
      )
      db.exec(
        "DROP TRIGGER ledger_restore_resolution_applications_no_update; UPDATE ledger_restore_resolution_applications SET receipt_hash='broken'"
      )
      expect(() => ledger.restoreResolutionApplication(r.authorizationId)).toThrow('conflict')
    } finally {
      db.close()
    }
  } finally {
    ledger.close()
  }
})
it('rolls back a failed durable resolution insert and can retry without changing already committed quarantine', async () => {
  const f = await fixture(2),
    db = new DatabaseSync(f.restored.databasePath)
  try {
    f.ledger.applyRestoreRecoveryBoundary(f.scope, f.approved, 7300)
    // Initialize the optional table without a successful insert, then inject disk failure.
    expect(() => f.ledger.applyRestoreExecutionResolutions(f.scope, f.resolutions, 37000)).toThrow()
    db.exec(`CREATE TABLE ledger_restore_resolution_applications(sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id TEXT NOT NULL UNIQUE,authorization_id TEXT NOT NULL UNIQUE,boundary_application_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,request_json TEXT NOT NULL,receipt_hash TEXT NOT NULL,receipt_json TEXT NOT NULL,applied_at INTEGER NOT NULL) STRICT;
      CREATE TRIGGER fail_resolution BEFORE INSERT ON ledger_restore_resolution_applications BEGIN SELECT RAISE(ABORT,'synthetic_disk_failure'); END`)
    expect(() => f.ledger.applyRestoreExecutionResolutions(f.scope, f.resolutions, 7400)).toThrow(
      'synthetic_disk_failure'
    )
    expect(
      f.ledger.restoreResolutionApplication(f.approved.authorization.authorizationId)
    ).toBeNull()
    db.exec('DROP TRIGGER fail_resolution')
    expect(f.ledger.applyRestoreExecutionResolutions(f.scope, f.resolutions, 7401).canRelease).toBe(
      false
    )
  } finally {
    db.close()
    f.ledger.close()
  }
})
it('retains historical evidence through backup and refuses using it to resolve a new restoration', async () => {
  const f = await fixture(2)
  try {
    f.ledger.applyRestoreRecoveryBoundary(f.scope, f.approved, 7300)
    const r = f.ledger.applyRestoreExecutionResolutions(f.scope, f.resolutions, 7400),
      db = new DatabaseSync(f.restored.databasePath, { readOnly: true })
    let backup
    try {
      backup = await createLedgerBackup(db, join(f.root, 'resolved-backup'))
    } finally {
      db.close()
    }
    const restored = await restoreLedgerBackup(backup.directory, join(f.root, 'restored-again')),
      next = new Ledger(restored.databasePath)
    try {
      expect(next.restoreResolutionApplication(r.authorizationId)).toEqual(r)
      expect(() => next.applyRestoreExecutionResolutions(f.scope, f.resolutions, 7401)).toThrow(
        'conflict'
      )
      expect(next.requiresRestoreReview()).toBe(true)
    } finally {
      next.close()
    }
  } finally {
    f.ledger.close()
  }
})
it('binds the main-process client to the exact authorization, supports complete large responses and rejects response corruption', async () => {
  const f = await fixture()
  let calls = 0,
    body = JSON.stringify(f.resolutions)
  const client = new AgentRegistration(
    {
      load: () => ({
        serverUrl: 'http://127.0.0.1:4782',
        encryptedCredential: 'synthetic',
        scope: f.scope
      }),
      save: () => {
        throw Error('unexpected_write')
      }
    },
    { available: () => true, encrypt: () => '', decrypt: () => 'C'.repeat(43) },
    async () => {
      calls++
      return new Response(body, { status: 200 })
    },
    true
  )
  const a = f.approved.authorization,
    input = {
      authorizationId: a.authorizationId,
      caseId: a.caseId,
      restoreId: a.restoreId,
      contextHash: a.contextHash
    }
  try {
    expect(Buffer.byteLength(body)).toBeGreaterThan(65536)
    expect(await client.restoreExecutionResolutions(input, f.approved)).toEqual(f.resolutions)
    await expect(
      client.restoreExecutionResolutions(
        { ...input, authorizationId: '00000000-0000-4000-8000-000000000000' },
        f.approved
      )
    ).rejects.toThrow('INVALID_RESPONSE')
    expect(calls).toBe(1)
    body = JSON.stringify({ ...f.resolutions, authorizationHash: 'f'.repeat(64) })
    await expect(client.restoreExecutionResolutions(input, f.approved)).rejects.toThrow(
      'INVALID_RESPONSE'
    )
    expect(() =>
      parseRestoreResolutionPackage(f.resolutions, {
        ...f.approved,
        authorization: { ...a, scope: { ...a.scope, account_id: 'other' } }
      })
    ).toThrow()
  } finally {
    f.ledger.close()
  }
})
