import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { LegacySettingsArchive } from '../../src/core/persistence/legacy-settings-archive'

const roots: string[] = [],
  stores: LegacySettingsArchive[] = []
afterEach(() => {
  stores.splice(0).forEach((s) => s.close())
  roots.splice(0).forEach((root) => {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep + 'legacy-review-'))
      throw new Error('unexpected_fixture_path')
    rmSync(root, { recursive: true, force: true })
  })
})
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'legacy-review-'))
  roots.push(root)
  const path = join(root, 'archive.sqlite'),
    file = join(root, 'source.json')
  writeFileSync(
    file,
    JSON.stringify({
      modes: [
        {
          id: 'mode',
          name: '咨询',
          prompt: '旧私有规则',
          unifiedPrefix: '您好',
          specificObjects: [{ id: 'customer', name: '同名客户' }]
        }
      ]
    })
  )
  const store = new LegacySettingsArchive(path, 'workspace-A')
  stores.push(store)
  await store.importFile(file)
  const draft = store.list().find((d) => d.content.kind === 'mode')!
  const input = {
    sourceId: 'review-1',
    draftId: draft.id,
    expectedContentHash: draft.contentHash,
    expectedReviewRevision: 0,
    decision: 'accept' as const,
    reason: '人工核对完成',
    replyRules: '先确认型号，不猜价格'
  }
  return { store, draft, input, path }
}
describe('private legacy settings review', () => {
  it('persists a reviewed rule independently from immutable raw drafts across restart', async () => {
    const { store, draft, input, path } = await fixture()
    const result = store.recordReview(input, 'reviewer-A')
    expect(result).toMatchObject({
      currentReviewRevision: 1,
      isCurrent: true,
      record: {
        revision: 1,
        decision: 'accept',
        reviewer: 'reviewer-A',
        replyRules: '先确认型号，不猜价格',
        automaticEnabled: false,
        identityVerified: false
      }
    })
    expect(store.list().find((d) => d.id === draft.id)).toEqual(draft)
    store.close()
    const next = new LegacySettingsArchive(path, 'workspace-A', { readOnly: true })
    stores.push(next)
    expect(next.reviewHistory(draft.id)).toEqual([result.record])
    expect(next.reviewState(draft.id)).toMatchObject({ revision: 1, decision: 'accept' })
    expect(() => next.recordReview(input, 'reviewer-A')).toThrow(
      'legacy_settings_archive_read_only'
    )
  })
  it('rejects stale concurrent approval and does not resurrect it on an old idempotent retry', async () => {
    const { store, input, draft, path } = await fixture()
    const first = store.recordReview(input, 'reviewer-A')
    const other = new LegacySettingsArchive(path, 'workspace-A')
    stores.push(other)
    expect(() => other.recordReview({ ...input, sourceId: 'concurrent' }, 'reviewer-B')).toThrow(
      'legacy_settings_review_conflict'
    )
    other.recordReview(
      {
        sourceId: 'reopen',
        draftId: draft.id,
        expectedContentHash: draft.contentHash,
        expectedReviewRevision: 1,
        decision: 'reopen',
        reason: '需要重新核对'
      },
      'reviewer-B'
    )
    expect(store.recordReview(input, 'reviewer-A')).toEqual({
      record: first.record,
      currentReviewRevision: 2,
      isCurrent: false
    })
    expect(() => store.recordReview({ ...input, reason: '换内容' }, 'reviewer-A')).toThrow(
      'legacy_settings_review_conflict'
    )
    expect(store.reviewState(draft.id)).toMatchObject({ revision: 2, decision: 'reopen' })
  })
  it('requires explicit reviewed rules for modes and never promotes customer names to identity', async () => {
    const { store, input } = await fixture()
    const withoutRules = { ...input, replyRules: undefined }
    expect(() => store.recordReview(withoutRules, 'reviewer')).toThrow(
      'legacy_settings_review_invalid'
    )
    expect(() =>
      store.recordReview({ ...input, replyRules: 'a'.repeat(12001) }, 'reviewer')
    ).toThrow('legacy_settings_review_invalid')
    expect(() => store.recordReview({ ...input, automaticEnabled: true }, 'reviewer')).toThrow(
      'legacy_settings_review_invalid'
    )
    const customer = store.list().find((d) => d.content.kind === 'relationship')!
    const review = {
      ...withoutRules,
      draftId: customer.id,
      expectedContentHash: customer.contentHash
    }
    expect(() => store.recordReview({ ...review, replyRules: '不能绑定' }, 'reviewer')).toThrow(
      'legacy_settings_review_invalid'
    )
    expect(store.recordReview(review, 'reviewer').record).toMatchObject({
      decision: 'accept',
      automaticEnabled: false,
      identityVerified: false
    })
  })
  it('checks the raw content hash and rolls failed writes back before retry', async () => {
    const { store, input, draft, path } = await fixture()
    expect(() =>
      store.recordReview({ ...input, expectedContentHash: 'a'.repeat(64) }, 'reviewer')
    ).toThrow('legacy_settings_review_conflict')
    const db = new DatabaseSync(path)
    try {
      db.exec(
        "CREATE TRIGGER fail_review BEFORE INSERT ON legacy_settings_reviews BEGIN SELECT RAISE(ABORT,'synthetic_fail'); END"
      )
      expect(() => store.recordReview(input, 'reviewer')).toThrow('legacy_settings_review_failed')
      expect(store.reviewHistory(draft.id)).toEqual([])
      db.exec('DROP TRIGGER fail_review')
      expect(store.recordReview(input, 'reviewer').record.revision).toBe(1)
      expect(() => db.exec("UPDATE legacy_settings_reviews SET payload='{}' ")).toThrow()
      expect(() => db.exec('DELETE FROM legacy_settings_reviews')).toThrow()
    } finally {
      db.close()
    }
  })
  it('rejects tampered review history even if append protection was bypassed by a database owner', async () => {
    const { store, input, draft, path } = await fixture()
    store.recordReview(input, 'reviewer')
    const db = new DatabaseSync(path)
    try {
      db.exec(
        "DROP TRIGGER legacy_review_no_update; UPDATE legacy_settings_reviews SET payload='{}'"
      )
      expect(() => store.reviewHistory(draft.id)).toThrow('legacy_settings_archive_corrupt')
      expect(() => store.recordReview(input, 'reviewer')).toThrow('legacy_settings_archive_corrupt')
    } finally {
      db.close()
    }
  })
  it('reads v1 without modifying it and upgrades only on an explicit writable open', async () => {
    const { store, path, draft, input } = await fixture()
    store.close()
    const db = new DatabaseSync(path)
    try {
      db.exec('DROP TABLE IF EXISTS legacy_settings_reviews; PRAGMA user_version=1')
    } finally {
      db.close()
    }
    const read = new LegacySettingsArchive(path, 'workspace-A', { readOnly: true })
    stores.push(read)
    expect(read.reviewState(draft.id)).toBeNull()
    read.close()
    const check = new DatabaseSync(path, { readOnly: true })
    expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(1)
    check.close()
    const upgraded = new LegacySettingsArchive(path, 'workspace-A')
    stores.push(upgraded)
    expect(upgraded.recordReview(input, 'reviewer').record.revision).toBe(1)
    expect(() => new LegacySettingsArchive(path, 'workspace-B')).toThrow(
      'legacy_settings_owner_mismatch'
    )
  })
})
