import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { Ledger } from '../../src/core/persistence/ledger'
import {
  createLedgerBackup,
  verifyLedgerBackup,
  restoreLedgerBackup
} from '../../src/core/persistence/ledger-backup'

const now = 1770000000000
const scope = { workspaceId: 'work', platform: 'generic' as const, conversationId: 'customer-a' }
const authorityId = 'a'.repeat(64)
const sourceId = '11111111-1111-4111-8111-111111111111'
const content = {
  kind: 'skill' as const,
  scenario: '退款核对',
  guidance: '先核对订单',
  rationale: '避免遗漏',
  steps: ['确认订单号', '查询当前政策'],
  pitfalls: ['不能沿用旧天数'],
  verification: ['订单已确认']
}
const intent = {
  kind: 'manual' as const,
  authorityId,
  firstSubmittedAt: now,
  evidenceAt: now,
  input: { scope, sourceId, content, reason: '员工实际教导' }
}
const ledgers: Ledger[] = []
const roots: string[] = []
function ledger(path = ':memory:'): Ledger {
  const result = new Ledger(path, now)
  ledgers.push(result)
  return result
}
function directory(): string {
  const root = mkdtempSync(join(tmpdir(), 'learning-submissions-'))
  roots.push(root)
  return root
}
function close(value: Ledger): void {
  value.close()
  ledgers.splice(ledgers.indexOf(value), 1)
}
afterEach(() => {
  for (const value of ledgers.splice(0)) value.close()
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep + 'learning-submissions-'))
      throw new Error('unexpected_fixture')
    rmSync(root, { recursive: true, force: true })
  }
})

describe('durable window learning submissions', () => {
  it('finds an older receipt independently of the newest hundred entries', () => {
    const store = ledger().learningSubmissions
    store.enqueue(intent)
    for (let index = 1; index <= 101; index++)
      store.enqueue({
        ...intent,
        firstSubmittedAt: now + index,
        input: { ...intent.input, sourceId: randomUUID() }
      })
    expect(store.receipts(scope, authorityId).some((value) => value.sourceId === sourceId)).toBe(
      false
    )
    expect(store.receipt(scope, authorityId, sourceId)).toMatchObject({
      sourceId,
      state: 'pending',
      firstSubmittedAt: now
    })
    expect(store.receipt(scope, 'b'.repeat(64), sourceId)).toBeUndefined()
  })

  it('persists only trusted episode timestamps and removes them on scoped forget and expiry', () => {
    const path = join(directory(), 'ledger.sqlite'),
      first = ledger(path)
    const id = randomUUID()
    first.learningSubmissions.observeEpisode({
      id,
      scope,
      createdAt: now,
      startedAt: now - 1000,
      sourceId: 'actual-draft',
      topic: '来源',
      messages: [
        {
          sourceId: 'actual-message',
          role: 'customer',
          text: 'private-only-in-authoritative-store'
        }
      ],
      outcome: 'unknown'
    })
    close(first)
    const reopened = ledger(path),
      store = reopened.learningSubmissions
    expect(store.episodeTime(scope, id)).toBe(now - 1000)
    expect(store.episodeTime({ ...scope, conversationId: 'other' }, id)).toBeUndefined()
    const reader = new DatabaseSync(path)
    try {
      expect(
        JSON.stringify(
          reader
            .prepare(
              "SELECT * FROM runtime_metadata WHERE key LIKE 'learning_submission_episode:%'"
            )
            .all()
        )
      ).not.toContain('private-only')
    } finally {
      reader.close()
    }
    store.setRetention(scope, 7)
    store.prune(scope, now + 8 * 86400000)
    expect(store.episodeTime(scope, id)).toBeUndefined()
    store.observeEpisode({
      id,
      scope,
      createdAt: now,
      startedAt: now,
      sourceId: 'actual-draft',
      topic: '来源',
      messages: [],
      outcome: 'unknown'
    })
    store.forget({ workspaceId: 'work', platform: 'generic' }, now + 1)
    expect(store.episodeTime(scope, id)).toBeUndefined()
    store.observeEpisode({
      id,
      scope,
      createdAt: now,
      startedAt: now,
      sourceId: 'actual-draft',
      topic: '来源',
      messages: [],
      outcome: 'unknown'
    })
    expect(store.episodeTime(scope, id)).toBeUndefined()
  })

  it('recovers the same source and complete method after a main-process restart', () => {
    const path = join(directory(), 'ledger.sqlite')
    const first = ledger(path)
    expect(first.learningSubmissions.enqueue(intent)).toMatchObject({ sourceId, state: 'pending' })
    close(first)
    const reopened = ledger(path)
    expect(reopened.learningSubmissions.pending(scope, authorityId, now + 1000)).toEqual([intent])
    expect(reopened.learningSubmissions.receipts(scope, authorityId)).toHaveLength(1)
  })

  it('deduplicates a lost-response retry without changing original submission or evidence time', () => {
    const store = ledger().learningSubmissions
    store.enqueue(intent)
    store.enqueue({ ...intent, firstSubmittedAt: now + 10000, evidenceAt: now + 10000 })
    expect(store.pending(scope, authorityId, now + 20000)).toEqual([intent])
    expect(store.receipts(scope, authorityId)).toHaveLength(1)
  })

  it('rejects a changed request body under the same source instead of replacing the old method', () => {
    const store = ledger().learningSubmissions
    store.enqueue(intent)
    expect(() =>
      store.enqueue({
        ...intent,
        input: { ...intent.input, content: { ...content, steps: ['直接承诺退款'] } }
      })
    ).toThrow('learning_submission_conflict')
    expect(store.pending(scope, authorityId, now)).toEqual([intent])
  })

  it('clears private request text after acknowledgement while keeping an idempotent receipt', () => {
    const path = join(directory(), 'ledger.sqlite')
    const store = ledger(path).learningSubmissions
    store.enqueue(intent)
    store.acknowledge(scope, authorityId, sourceId)
    expect(store.pending(scope, authorityId, now)).toEqual([])
    expect(store.enqueue(intent)).toMatchObject({ sourceId, state: 'saved' })
    const inspection = new DatabaseSync(path, { readOnly: true })
    try {
      expect(
        inspection.prepare('SELECT payload FROM learning_submissions').get()?.payload
      ).toBeNull()
    } finally {
      inspection.close()
    }
  })

  it('isolates customer, account and current device authority when reading and acknowledging', () => {
    const store = ledger().learningSubmissions
    store.enqueue(intent)
    const foreign = { ...scope, conversationId: 'customer-b' }
    expect(store.pending(foreign, authorityId, now)).toEqual([])
    expect(store.pending(scope, 'b'.repeat(64), now)).toEqual([])
    expect(
      store.pending({ ...scope, accountId: 'other', tenantId: 'other' }, authorityId, now)
    ).toEqual([])
    store.acknowledge(scope, 'b'.repeat(64), sourceId)
    expect(store.pending(scope, authorityId, now)).toEqual([intent])
  })

  it('forgets matching customer submissions on every old device without touching other customers', () => {
    const store = ledger().learningSubmissions
    store.enqueue(intent)
    store.enqueue({ ...intent, authorityId: 'b'.repeat(64) })
    const other = {
      ...intent,
      input: { ...intent.input, scope: { ...scope, conversationId: 'customer-b' } }
    }
    store.enqueue(other)
    store.forget(scope, now + 1000)
    expect(store.pending(scope, authorityId, now + 2000)).toEqual([])
    expect(store.pending(scope, 'b'.repeat(64), now + 2000)).toEqual([])
    expect(store.pending(other.input.scope, authorityId, now + 2000)).toEqual([other])
    expect(() => store.enqueue({ ...intent, firstSubmittedAt: now + 3000 })).toThrow(
      'learning_submission_forgotten'
    )
  })

  it('blocks a previously unqueued late intent across reopen after scope forgetting', () => {
    const path = join(directory(), 'ledger.sqlite')
    const first = ledger(path)
    first.learningSubmissions.forget({ workspaceId: 'work', platform: 'generic' }, now + 1000)
    close(first)
    const store = ledger(path).learningSubmissions
    expect(() => store.enqueue(intent)).toThrow('learning_submission_forgotten')
    expect(
      store.enqueue({ ...intent, firstSubmittedAt: now + 2000, evidenceAt: now + 2000 })
    ).toMatchObject({ state: 'pending' })
  })

  it('applies persistent authoritative retention using original evidence age, including after retries', () => {
    const path = join(directory(), 'ledger.sqlite')
    const first = ledger(path)
    first.learningSubmissions.enqueue(intent)
    first.learningSubmissions.setRetention(scope, 7)
    close(first)
    const store = ledger(path).learningSubmissions
    store.enqueue({
      ...intent,
      firstSubmittedAt: now + 8 * 86400000,
      evidenceAt: now + 8 * 86400000
    })
    expect(store.pending(scope, authorityId, now + 8 * 86400000)).toEqual([])
    expect(store.receipts(scope, authorityId)[0].state).toBe('forgotten')
  })

  it('keeps retention per customer while inheriting an account policy for an unset customer', () => {
    const store = ledger().learningSubmissions
    const other = {
      ...intent,
      input: { ...intent.input, scope: { ...scope, conversationId: 'customer-b' } }
    }
    store.enqueue(intent)
    store.enqueue(other)
    store.setRetention({ workspaceId: 'work', platform: 'generic' }, 7)
    store.setRetention(other.input.scope, 365)
    expect(store.pending(scope, authorityId, now + 8 * 86400000)).toEqual([])
    expect(store.pending(other.input.scope, authorityId, now + 8 * 86400000)).toEqual([other])
  })

  it('rejects credentials, nonopaque source IDs and invalid source timestamps before persistence', () => {
    const store = ledger().learningSubmissions
    expect(() => store.enqueue({ ...intent, apiKey: 'never-store-a-key' })).toThrow()
    expect(() =>
      store.enqueue({ ...intent, input: { ...intent.input, sourceId: 'private-customer-name' } })
    ).toThrow()
    expect(() => store.enqueue({ ...intent, evidenceAt: now + 1 })).toThrow()
    expect(store.receipts(scope, authorityId)).toEqual([])
  })

  it('fails closed on corrupt pending content instead of replaying a changed method', () => {
    const path = join(directory(), 'ledger.sqlite')
    const store = ledger(path).learningSubmissions
    store.enqueue(intent)
    const writer = new DatabaseSync(path)
    try {
      writer
        .prepare('UPDATE learning_submissions SET payload=?')
        .run(JSON.stringify({ ...intent, input: { ...intent.input, reason: 'tampered' } }))
    } finally {
      writer.close()
    }
    expect(() => store.pending(scope, authorityId, now)).toThrow('learning_submission_corrupt')
  })

  it('backs up current pending intents and restores schema 12 through a migration without losing them', async () => {
    const root = directory(),
      path = join(root, 'ledger.sqlite')
    const first = ledger(path)
    first.learningSubmissions.enqueue(intent)
    const source = new DatabaseSync(path)
    let saved: Awaited<ReturnType<typeof createLedgerBackup>>
    try {
      saved = await createLedgerBackup(source, join(root, 'backups'))
      expect(saved.manifest.schemaVersion).toBe(13)
      expect((await verifyLedgerBackup(saved.directory)).schemaVersion).toBe(13)
    } finally {
      source.close()
    }
    close(first)
    const restored = await restoreLedgerBackup(saved!.directory, join(root, 'restored'))
    const recovered = ledger(restored.databasePath)
    expect(recovered.learningSubmissions.pending(scope, authorityId, now)).toEqual([intent])
    expect(recovered.requiresRestoreReview()).toBe(true)
    close(recovered)
    const legacyPath = join(root, 'legacy.sqlite')
    const previous = ledger(legacyPath)
    close(previous)
    const downgrade = new DatabaseSync(legacyPath)
    let legacy: Awaited<ReturnType<typeof createLedgerBackup>>
    try {
      downgrade.exec('DROP TABLE learning_submissions; PRAGMA user_version=12')
      legacy = await createLedgerBackup(downgrade, join(root, 'legacy-backups'))
      expect((await verifyLedgerBackup(legacy.directory)).schemaVersion).toBe(12)
    } finally {
      downgrade.close()
    }
    const legacyRestored = await restoreLedgerBackup(
      legacy!.directory,
      join(root, 'legacy-restored')
    )
    const upgraded = ledger(legacyRestored.databasePath)
    expect(upgraded.requiresRestoreReview()).toBe(true)
    expect(upgraded.learningSubmissions.enqueue(intent)).toMatchObject({ state: 'pending' })
  })
})
