import { afterEach, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { rmSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { Ledger } from '../../src/core/persistence/ledger'
import { restoreResolutionFixture } from '../fixtures/restore-resolution'
import { restoreObservationFixture } from '../fixtures/restore-observation'
import { restoreCompletionAckFixture } from '../fixtures/restore-completion'
import { parseRestoreRecoveryCompletionInput } from '../../src/shared/contracts/restore-completion'
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep + 'restore-resolution-'))
      throw Error('fixture_root_invalid')
    rmSync(root, { recursive: true, force: true })
  }
})
async function fixture(again = false) {
  const f = await restoreResolutionFixture((r) => roots.push(r), 0, again),
    source = restoreObservationFixture(f.approved)
  f.ledger.applyRestoreRecoveryBoundary(f.scope, f.approved, 7300)
  f.ledger.applyRestoreExecutionResolutions(f.scope, f.resolutions, 7400)
  f.ledger.installRestoreObservationGrant(f.scope, source.grant, 7500)
  return { ...f, source }
}
it('durably prepares full ancestor provenance before HTTP, reuses every original byte after restart and retains all fences', async () => {
  const f = await fixture(true)
  let ledger = f.ledger
  try {
    const request = ledger.prepareRestoreCompletion(
      f.scope,
      f.approved.authorization.authorizationId,
      f.source.grant,
      7600
    )
    expect(request.provenance).toHaveLength(2)
    expect(request.provenance[1].previousContextHash).toBe(request.provenance[0].contextHash)
    expect(parseRestoreRecoveryCompletionInput(request, f.approved, f.resolutions)).toEqual(request)
    ledger.close()
    ledger = new Ledger(f.restored.databasePath)
    expect(ledger.restoreCompletionIntent(f.scope)).toEqual(request)
    expect(
      ledger.prepareRestoreCompletion(
        f.scope,
        f.approved.authorization.authorizationId,
        f.source.grant,
        40000
      )
    ).toEqual(request)
    const ack = restoreCompletionAckFixture(request, 7700)
    expect(ledger.saveRestoreCompletionAck(f.scope, ack)).toEqual(ack)
    expect(ledger.saveRestoreCompletionAck(f.scope, ack)).toEqual(ack)
    expect(ledger.restoreCompletionAck(f.scope)).toEqual(ack)
    expect(ledger.requiresRestoreReview()).toBe(true)
    expect(ledger.central.requiresReconciliation()).toBe(true)
    expect(ledger.getSend(f.reconciliation.s.executionId)?.status).toBe('unknown')
  } finally {
    ledger.close()
  }
})
it('rejects missing ancestry, changed bindings, wrong scope and altered central response', async () => {
  const f = await fixture(true)
  try {
    const request = f.ledger.prepareRestoreCompletion(
      f.scope,
      f.approved.authorization.authorizationId,
      f.source.grant,
      7600
    )
    const changes = [
      (r: typeof request) => {
        r.provenance.shift()
      },
      (r: typeof request) => {
        r.provenance[0].backupId = r.completionId
      },
      (r: typeof request) => {
        r.resolutionApplication.localExecutions++
      },
      (r: typeof request) => {
        r.boundaryApplication.sourceMessageCount++
      },
      (r: typeof request) => {
        r.observationGrant.sourceTrustHash = 'f'.repeat(64)
      }
    ]
    for (const change of changes) {
      const r = structuredClone(request)
      change(r)
      expect(() => parseRestoreRecoveryCompletionInput(r, f.approved, f.resolutions)).toThrow()
    }
    expect(() =>
      f.ledger.prepareRestoreCompletion(
        { ...f.scope, agent_id: 'other' },
        f.approved.authorization.authorizationId,
        f.source.grant,
        7600
      )
    ).toThrow()
    const ack = restoreCompletionAckFixture(request, 7700)
    expect(() =>
      f.ledger.saveRestoreCompletionAck(f.scope, { ...ack, provenanceHash: 'f'.repeat(64) })
    ).toThrow()
    expect(f.ledger.restoreCompletionAck(f.scope)).toBeNull()
  } finally {
    f.ledger.close()
  }
})
it('refuses changed local post-boundary state rather than declaring a newer observation durably quarantined', async () => {
  const f = await fixture()
  try {
    f.ledger.setHumanOwned(f.f.task.identity, f.f.task.conversationId, false)
    expect(() =>
      f.ledger.prepareRestoreCompletion(
        f.scope,
        f.approved.authorization.authorizationId,
        f.source.grant,
        7600
      )
    ).toThrow('conflict')
    expect(f.ledger.restoreCompletionIntent(f.scope)).toBeNull()
  } finally {
    f.ledger.close()
  }
})
it('rolls back failed receipt insertion, retries the durable request and detects hash damage after restart', async () => {
  const f = await fixture(),
    db = new DatabaseSync(f.restored.databasePath)
  let ledger = f.ledger
  try {
    const request = ledger.prepareRestoreCompletion(
        f.scope,
        f.approved.authorization.authorizationId,
        f.source.grant,
        7600
      ),
      ack = restoreCompletionAckFixture(request, 7700)
    db.exec(
      "CREATE TRIGGER fail_completion BEFORE INSERT ON ledger_restore_completion_acks BEGIN SELECT RAISE(ABORT,'synthetic_disk_failure');END"
    )
    expect(() => ledger.saveRestoreCompletionAck(f.scope, ack)).toThrow('synthetic_disk_failure')
    expect(ledger.restoreCompletionAck(f.scope)).toBeNull()
    expect(ledger.restoreCompletionIntent(f.scope)).toEqual(request)
    db.exec('DROP TRIGGER fail_completion')
    ledger.saveRestoreCompletionAck(f.scope, ack)
    expect(() => db.exec('DELETE FROM ledger_restore_completion_acks')).toThrow('immutable')
    db.exec(
      "DROP TRIGGER ledger_restore_completion_acks_no_update;UPDATE ledger_restore_completion_acks SET receipt_hash='broken'"
    )
    ledger.close()
    ledger = new Ledger(f.restored.databasePath)
    expect(() => ledger.restoreCompletionAck(f.scope)).toThrow('conflict')
  } finally {
    db.close()
    ledger.close()
  }
})
