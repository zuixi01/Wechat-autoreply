import { afterEach, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { resolve, sep, join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { Ledger } from '../../src/core/persistence/ledger'
import { createLedgerBackup, restoreLedgerBackup } from '../../src/core/persistence/ledger-backup'
import { hashContext } from '../../src/core/reply/hashes'
import { RestoreHistorySourceTrustSchema } from '../../src/shared/contracts/history-source-trust'
import type { ObservedMessage } from '../../src/shared/contracts/message'
import { restoreResolutionFixture } from '../fixtures/restore-resolution'
import { restoreObservationFixture } from '../fixtures/restore-observation'
const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep + 'restore-resolution-'))
      throw Error('fixture_path_invalid')
    rmSync(root, { recursive: true, force: true })
  }
})
const fixture = () => restoreResolutionFixture((r) => roots.push(r), 0)
function message(
  f: Awaited<ReturnType<typeof fixture>>,
  id = 'new-1',
  conversationId = f.f.task.conversationId
): ObservedMessage {
  return {
    identity: f.f.task.identity,
    conversationId,
    sourceMessageId: id,
    direction: 'inbound',
    kind: 'text',
    text: 'new synthetic question',
    observedAt: 8000,
    identityVerified: true,
    messageIdVerified: true
  }
}
it('does not infer ordered source trust from the old complete-history claim and rejects private keys or half-declarations', async () => {
  const f = await fixture()
  try {
    const s = restoreObservationFixture(f.approved).grant.sourceTrust,
      { stableSourceOrderVerified: _o, sourceOrderVerificationSha256: _h, ...old } = s
    void _o
    void _h
    expect(RestoreHistorySourceTrustSchema.parse(old).stableSourceOrderVerified).toBeUndefined()
    expect(() =>
      RestoreHistorySourceTrustSchema.parse({ ...old, stableSourceOrderVerified: true })
    ).toThrow()
    expect(() =>
      RestoreHistorySourceTrustSchema.parse({
        ...old,
        sourceOrderVerificationSha256: 'a'.repeat(64)
      })
    ).toThrow()
    expect(() =>
      RestoreHistorySourceTrustSchema.parse({
        ...s,
        publicKeyPem: s.publicKeyPem.replaceAll('PUBLIC KEY', 'PRIVATE KEY')
      })
    ).toThrow()
  } finally {
    f.ledger.close()
  }
})
it('quarantines source-only historical rereads across login epochs without reacquiring a released conversation', async () => {
  const f = await fixture()
  try {
    const old = {
        ...message(f, 'source-only'),
        direction: 'human_outbound' as const,
        text: 'old staff answer'
      },
      h = f.approved.boundary.history
    h.conversations[0].messages.push({
      sourceMessageId: old.sourceMessageId,
      position: 3,
      direction: old.direction,
      sentAt: 6500,
      contentHash: hashContext({ direction: old.direction, kind: old.kind, text: old.text })
    })
    f.approved.authorization.boundaryHash = hashContext(f.approved.boundary)
    f.ledger.applyRestoreRecoveryBoundary(f.scope, f.approved, 7300)
    f.ledger.setHumanOwned(old.identity, old.conversationId, false)
    const epoch = {
      ...old.identity,
      loginEpoch: old.identity.loginEpoch + 1,
      clientInstanceId: 'restarted-client'
    }
    expect(f.ledger.observe({ ...old, identity: epoch }, 8000).historical).toBe(true)
    expect(f.ledger.snapshot(epoch, old.conversationId).humanOwned).toBe(false)
    const inbound = { ...message(f, 'inbound-1'), text: 'synthetic', identity: epoch }
    expect(f.ledger.observe(inbound, 8000).historical).toBe(true)
    expect(f.ledger.snapshot(epoch, old.conversationId).messages.at(-1)?.handledBy).toBe(
      'restore_history_observation'
    )
    expect(() => f.ledger.observe({ ...old, text: 'changed' }, 8000)).toThrow('conflict')
  } finally {
    f.ledger.close()
  }
})
it('rejects missing, forged, reordered, cross-account and old-time evidence without changing message or source frontier', async () => {
  const f = await fixture()
  try {
    f.ledger.applyRestoreRecoveryBoundary(f.scope, f.approved, 7300)
    const s = restoreObservationFixture(f.approved),
      m = message(f)
    f.ledger.installRestoreObservationGrant(f.scope, s.grant, 7500)
    const before = f.ledger.snapshot(m.identity, m.conversationId)
    expect(() => f.ledger.observe(m, 8000)).toThrow('evidence_required')
    const forged = s.signed(m)
    forged.restoreEvidence!.signature = 'A'.repeat(86)
    for (const bad of [
      forged,
      s.signed(m, 4),
      s.signed(m, 3, null),
      s.signed({ ...m, observedAt: 6000 }),
      s.signed({ ...m, identity: { ...m.identity, agentId: 'other' } }),
      { ...s.signed(m), text: 'different' }
    ])
      expect(() => f.ledger.observe(bad, 8000)).toThrow()
    expect(f.ledger.snapshot(m.identity, m.conversationId)).toEqual(before)
    expect(f.ledger.observe(s.signed(m), 8000).inserted).toBe(true)
    expect(f.ledger.snapshot(m.identity, m.conversationId).messages.at(-1)?.handledBy).toBeNull()
    expect(f.ledger.requiresRestoreReview()).toBe(true)
    expect(f.ledger.central.requiresReconciliation()).toBe(true)
  } finally {
    f.ledger.close()
  }
})
it('keeps accepted source identities durable through restart and suppresses replay from a different login', async () => {
  const f = await fixture()
  let ledger = f.ledger
  try {
    ledger.applyRestoreRecoveryBoundary(f.scope, f.approved, 7300)
    const s = restoreObservationFixture(f.approved),
      first = s.signed(message(f))
    ledger.installRestoreObservationGrant(f.scope, s.grant, 7500)
    ledger.observe(first, 8000)
    ledger.close()
    ledger = new Ledger(f.restored.databasePath)
    expect(ledger.observe({ ...first, restoreEvidence: undefined }, 40000).inserted).toBe(false)
    const another = {
      ...first,
      identity: { ...first.identity, loginEpoch: 2, clientInstanceId: 'another-client' },
      restoreEvidence: undefined
    }
    expect(ledger.observe(another, 40000).historical).toBe(true)
    expect(
      ledger.snapshot(another.identity, another.conversationId).messages.at(-1)?.handledBy
    ).not.toBeNull()
    expect(() =>
      ledger.observe(
        s.signed(message(f, 'second'), 4, {
          sourceMessageId: first.sourceMessageId,
          contentHash: first.restoreEvidence!.proof.contentHash
        }),
        40000
      )
    ).toThrow('conflict')
    expect(ledger.installRestoreObservationGrant(f.scope, s.grant, 40000)).toEqual(s.grant)
    expect(ledger.restoreObservationGrant(first.identity, 40000)).toBeUndefined()
  } finally {
    ledger.close()
  }
})
it('accepts a signed first message in a newly enumerated conversation with the complete-history zero frontier', async () => {
  const f = await fixture()
  try {
    f.ledger.applyRestoreRecoveryBoundary(f.scope, f.approved, 7300)
    const s = restoreObservationFixture(f.approved),
      m = message(f, 'new-contact-first', 'new-contact')
    f.ledger.installRestoreObservationGrant(f.scope, s.grant, 7500)
    expect(f.ledger.observe(s.signed(m), 8000).inserted).toBe(true)
    expect(f.ledger.snapshot(m.identity, m.conversationId).messages[0].handledBy).toBeNull()
    const human = s.signed(
      {
        ...m,
        sourceMessageId: 'staff-new',
        direction: 'human_outbound',
        text: 'staff took over',
        observedAt: 8001
      },
      2,
      {
        sourceMessageId: m.sourceMessageId,
        contentHash: hashContext({ direction: m.direction, kind: m.kind, text: m.text })
      }
    )
    expect(f.ledger.snapshot(m.identity, m.conversationId).humanOwned).toBe(false)
    f.ledger.observe(human, 8001)
    expect(f.ledger.snapshot(m.identity, m.conversationId).humanOwned).toBe(true)
  } finally {
    f.ledger.close()
  }
})
it('rolls back the entire page, messages and ordered journal when the next frame lacks evidence; retries advance together', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(8000)
  const f = await fixture()
  try {
    f.ledger.applyRestoreRecoveryBoundary(f.scope, f.approved, 7300)
    const s = restoreObservationFixture(f.approved),
      m = message(f),
      first = s.signed(m),
      identity = m.identity,
      entry = {
        binding: {
          identity,
          conversationId: m.conversationId,
          bindingVersion: 1,
          identityVerified: true,
          identityEvidence: ['synthetic']
        },
        displayName: 'synthetic',
        activityVersion: 'a'
      }
    f.ledger.installRestoreObservationGrant(f.scope, s.grant, 7500)
    const scan = f.ledger.collection.begin(identity)
    f.ledger.collection.page(identity, scan, [entry], 'snapshot', null, 1, true, 100)
    const request = f.ledger.collection.next(identity)!,
      before = f.ledger.snapshot(identity, m.conversationId),
      page = {
        binding: entry.binding,
        activityVersion: 'a',
        fromCursor: null,
        nextCursor: 'end',
        messages: [first, message(f, 'second')],
        complete: true,
        hasGap: false
      }
    expect(request.restoreGrant).toEqual(s.grant)
    expect(() => f.ledger.collection.commit(identity, request, page, 100)).toThrow(
      'evidence_required'
    )
    expect(f.ledger.snapshot(identity, m.conversationId)).toEqual(before)
    expect(f.ledger.collection.request(identity, m.conversationId)?.cursor).toBeNull()
    page.messages[1] = s.signed(message(f, 'second'), 4, {
      sourceMessageId: m.sourceMessageId,
      contentHash: first.restoreEvidence!.proof.contentHash
    })
    expect(f.ledger.collection.commit(identity, request, page, 100).changed).toHaveLength(2)
    expect(f.ledger.collection.request(identity, m.conversationId)?.cursor).toBe('end')
  } finally {
    f.ledger.close()
  }
})
it('commits an old-history page without reporting new customer activity or reacquiring staff ownership', async () => {
  const f = await fixture()
  try {
    f.ledger.applyRestoreRecoveryBoundary(f.scope, f.approved, 7300)
    const m = { ...message(f, 'inbound-1'), text: 'synthetic' },
      identity = { ...m.identity, loginEpoch: 3, clientInstanceId: 'new-client' },
      entry = {
        binding: {
          identity,
          conversationId: m.conversationId,
          bindingVersion: 1,
          identityVerified: true,
          identityEvidence: ['synthetic']
        },
        displayName: 'synthetic',
        activityVersion: 'a'
      }
    f.ledger.setHumanOwned(identity, m.conversationId, false)
    const scan = f.ledger.collection.begin(identity)
    f.ledger.collection.page(identity, scan, [entry], 'snapshot', null, 1, true, 100)
    const request = f.ledger.collection.next(identity)!,
      result = f.ledger.collection.commit(
        identity,
        request,
        {
          binding: entry.binding,
          activityVersion: 'a',
          fromCursor: null,
          nextCursor: 'old-end',
          messages: [{ ...m, identity }],
          complete: true,
          hasGap: false
        },
        100
      )
    expect(result).toMatchObject({ changed: [], complete: true, hasGap: false })
    expect(f.ledger.snapshot(identity, m.conversationId).humanOwned).toBe(false)
    expect(f.ledger.snapshot(identity, m.conversationId).messages[0].handledBy).not.toBeNull()
    f.ledger.markGap(identity, m.conversationId)
    f.ledger.collection.hint(identity, m.conversationId)
    const retry = f.ledger.collection.request(identity, m.conversationId)!
    expect(
      f.ledger.collection.commit(
        identity,
        retry,
        {
          binding: entry.binding,
          activityVersion: retry.entry.activityVersion,
          fromCursor: retry.cursor,
          nextCursor: 'old-end',
          messages: [{ ...m, identity }],
          complete: true,
          hasGap: false
        },
        100
      )
    ).toMatchObject({ changed: [], complete: false, hasGap: true })
  } finally {
    f.ledger.close()
  }
})
it('backs up ordered journals but rejects their grants as authority for a subsequent restoration', async () => {
  const f = await fixture(),
    db = new DatabaseSync(f.restored.databasePath)
  let next: Ledger | undefined
  try {
    f.ledger.applyRestoreRecoveryBoundary(f.scope, f.approved, 7300)
    const s = restoreObservationFixture(f.approved)
    f.ledger.installRestoreObservationGrant(f.scope, s.grant, 7500)
    f.ledger.observe(s.signed(message(f)), 8000)
    const backup = await createLedgerBackup(db, join(f.root, 'ordered-backup')),
      restored = await restoreLedgerBackup(backup.directory, join(f.root, 'restored-again'))
    next = new Ledger(restored.databasePath)
    expect(next.restoreContext()?.restoreId).not.toBe(f.approved.authorization.restoreId)
    expect(() => next!.installRestoreObservationGrant(f.scope, s.grant, 8100)).toThrow('conflict')
    expect(next.restoreObservationGrant(f.f.task.identity, 8100)).toBeUndefined()
    expect(next.requiresRestoreReview()).toBe(true)
  } finally {
    next?.close()
    db.close()
    f.ledger.close()
  }
})
it('checks immutable journal hashes after an external connection corrupts storage', async () => {
  const f = await fixture(),
    db = new DatabaseSync(f.restored.databasePath)
  try {
    f.ledger.applyRestoreRecoveryBoundary(f.scope, f.approved, 7300)
    const s = restoreObservationFixture(f.approved),
      m = s.signed(message(f))
    f.ledger.installRestoreObservationGrant(f.scope, s.grant, 7500)
    f.ledger.observe(m, 8000)
    expect(() =>
      db.exec('UPDATE ledger_restore_ordered_observations SET frame_hash=frame_hash')
    ).toThrow('immutable')
    db.exec(
      "DROP TRIGGER ledger_restore_ordered_observations_no_update;UPDATE ledger_restore_ordered_observations SET frame_hash='corrupt'"
    )
    expect(() => f.ledger.observe(m, 8000)).toThrow('conflict')
  } finally {
    db.close()
    f.ledger.close()
  }
})
