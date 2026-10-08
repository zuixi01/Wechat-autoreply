import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LearningStore } from '../../src/core/memory/learning-store'

const scope = { workspaceId: 'profile', platform: 'wechat' as const }
const stores: LearningStore[] = [],
  directories: string[] = []
afterEach(() => {
  stores.splice(0).forEach((store) => store.close())
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }))
})
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'learning-assign-'))
  directories.push(directory)
  const source = join(directory, 'cards.json')
  writeFileSync(
    source,
    JSON.stringify({
      version: 1,
      cards: [
        {
          cardId: 'legacy',
          scenario: '报价',
          guidance: '先确认型号',
          stats: { used: 100, success: 95 }
        }
      ]
    })
  )
  const store = new LearningStore(join(directory, 'learning.sqlite'))
  stores.push(store)
  store.migrateLegacy(source)
  return { store, source, legacyId: store.unassigned()[0].id }
}
describe('explicit legacy assignment', () => {
  it('legacy_assignment_is_idempotent and never carries old success counts into published memory', () => {
    const { store, source, legacyId } = setup()
    const first = store.assignLegacy(scope, legacyId, 'request-a')
    const second = store.assignLegacy(scope, legacyId, 'request-b')
    expect(second.id).toBe(first.id)
    expect(store.list(scope)).toHaveLength(1)
    expect(store.episodes(scope)).toHaveLength(1)
    expect(first).toMatchObject({ state: 'pending', activeRevision: null })
    expect(store.metrics(scope, first.id).adopted).toBe(0)
    expect(store.unassigned()).toEqual([])
    expect(store.migrateLegacy(source).imported).toBe(0)
  })
  it('refuses silent reassignment to another customer', () => {
    const { store, legacyId } = setup()
    store.assignLegacy(scope, legacyId, 'request-a')
    expect(() =>
      store.assignLegacy({ ...scope, conversationId: 'other' }, legacyId, 'request-b')
    ).toThrow('legacy_assignment_conflict')
  })
  it('forgetting the assigned method cannot resurrect it by importing again', () => {
    const { store, source, legacyId } = setup()
    const first = store.assignLegacy(scope, legacyId, 'request-a')
    store.forget(scope, first.id, 1)
    store.migrateLegacy(source)
    expect(store.unassigned()).toEqual([])
    expect(() => store.assignLegacy(scope, legacyId, 'request-b')).toThrow(
      'legacy_assignment_forgotten'
    )
  })
})
