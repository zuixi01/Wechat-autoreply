import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LearningStore } from '../../src/core/memory/learning-store'
import { memoryScopeKey } from '../../src/core/memory/learning-scope'
import { Ledger } from '../../src/core/persistence/ledger'
import { KnowledgeStore } from '../../src/core/knowledge/knowledge-store'
import {
  createJointBackup,
  verifyJointBackup,
  stageJointRestore,
  type CentralArchive
} from '../../src/core/persistence/joint-backup'

const scope = { workspaceId: 'profile', platform: 'wechat' as const, conversationId: 'customer' }
const stores: LearningStore[] = []
const databases: DatabaseSync[] = []
const directories: string[] = []
afterEach(() => {
  databases.splice(0).forEach((db) => db.close())
  stores.splice(0).forEach((store) => store.close())
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }))
})
function setup(): { path: string; store: LearningStore; inspect: DatabaseSync } {
  const directory = mkdtempSync(join(tmpdir(), 'learning-settings-audit-'))
  directories.push(directory)
  const path = join(directory, 'learning.sqlite')
  const store = new LearningStore(path, () => 1000)
  const inspect = new DatabaseSync(path)
  stores.push(store)
  databases.push(inspect)
  return { path, store, inspect }
}
function rows(db: DatabaseSync, key = memoryScopeKey(scope)): Record<string, unknown>[] {
  return db
    .prepare('SELECT * FROM learning_settings_audit WHERE scope_key=? ORDER BY rowid')
    .all(key)
}
describe('durable safe learning settings audit', () => {
  it('records actual safe configuration changes once and never audits reads or same values', () => {
    const { store, inspect } = setup()
    store.settings(scope)
    store.settings(scope, {})
    store.settings(scope, { maxReviewInputTokens: 8000 })
    expect(rows(inspect)).toEqual([])
    store.settings(scope, {
      reviewModelId: 'private-model-identifier',
      maxReviewInputTokens: 4000,
      dailyReviewTokenBudget: 30000
    })
    const audit = rows(inspect)
    expect(audit).toHaveLength(1)
    expect(audit[0].at).toBe(1000)
    expect(audit[0].before_hash).not.toBe(audit[0].after_hash)
    expect(JSON.stringify(audit)).not.toContain('private-model-identifier')
    expect(JSON.stringify(audit)).not.toContain('apiKey')
    expect(JSON.stringify(audit)).not.toContain('baseURL')
    store.settings(scope, {
      dailyReviewTokenBudget: 30000,
      maxReviewInputTokens: 4000,
      reviewModelId: 'private-model-identifier'
    })
    store.settings(scope)
    expect(rows(inspect)).toEqual(audit)
  })
  it('isolates scope history and clears only the forgotten scope', () => {
    const { store, inspect } = setup()
    const other = { ...scope, conversationId: 'other' }
    store.settings(scope, { reviewModelId: 'a' })
    store.settings(other, { reviewModelId: 'b' })
    expect(rows(inspect)).toHaveLength(1)
    expect(rows(inspect, memoryScopeKey(other))).toHaveLength(1)
    store.forgetScope(scope)
    expect(rows(inspect)).toEqual([])
    expect(rows(inspect, memoryScopeKey(other))).toHaveLength(1)
    expect(store.settings(other).reviewModelId).toBe('b')
  })
  it('preserves explicit inheritance overrides without inventing an effective change', () => {
    const { store, inspect } = setup()
    const account = { workspaceId: scope.workspaceId, platform: scope.platform }
    store.settings(account, { mode: 'off' })
    store.settings(scope, { mode: 'auto' })
    expect(store.settings(scope).mode).toBe('off')
    expect(rows(inspect)).toEqual([])
    expect(
      JSON.parse(
        String(
          inspect
            .prepare('SELECT payload FROM learning_settings WHERE scope_key=?')
            .get(memoryScopeKey(scope))?.payload
        )
      )
    ).toEqual({ mode: 'auto' })
    store.settings(account, { mode: 'suggest' })
    expect(store.settings(scope).mode).toBe('auto')
    expect(rows(inspect)).toEqual([])
    expect(rows(inspect, memoryScopeKey(account))).toHaveLength(2)
  })
  it('preserves settings and their audit through an actual disk restart', () => {
    const { path, store, inspect } = setup()
    store.settings(scope, { reviewModelId: 'chosen', dailyReviewTokenBudget: 25000 })
    const expected = rows(inspect)
    store.close()
    const reopened = new LearningStore(path)
    stores.push(reopened)
    expect(reopened.settings(scope).reviewModelId).toBe('chosen')
    expect(rows(inspect)).toEqual(expected)
    reopened.settings(scope, { reviewModelId: 'chosen' })
    expect(rows(inspect)).toEqual(expected)
  })
  it('rolls back the entire settings mutation if the audit write fails', () => {
    const { store, inspect } = setup()
    store.settings(scope, { reviewModelId: 'old' })
    const before = store.settings(scope)
    const audit = rows(inspect)
    inspect.exec(
      "CREATE TRIGGER reject_settings_audit BEFORE INSERT ON learning_settings_audit BEGIN SELECT RAISE(ABORT,'settings_audit_failure'); END"
    )
    expect(() =>
      store.settings(scope, { reviewModelId: 'new', maxReviewInputTokens: 4000 })
    ).toThrow('settings_audit_failure')
    expect(store.settings(scope)).toEqual(before)
    expect(rows(inspect)).toEqual(audit)
    inspect.exec('DROP TRIGGER reject_settings_audit')
    store.settings(scope, { reviewModelId: 'new', maxReviewInputTokens: 4000 })
    expect(rows(inspect)).toHaveLength(2)
  })
  it('upgrades a version 15 database without inventing historical audit records', () => {
    const { path, store, inspect } = setup()
    store.settings(scope, { reviewModelId: 'existing', maxReviewInputTokens: 4000 })
    store.close()
    inspect.exec('DROP TABLE learning_settings_audit; PRAGMA user_version=15')
    const reopened = new LearningStore(path)
    stores.push(reopened)
    expect(inspect.prepare('PRAGMA user_version').get()?.user_version).toBe(16)
    expect(reopened.settings(scope).reviewModelId).toBe('existing')
    expect(rows(inspect)).toEqual([])
    reopened.settings(scope, { reviewModelId: 'next' })
    expect(rows(inspect)).toHaveLength(1)
  })
  it('keeps a genuine version 15 joint backup readable and stages it without activating or losing settings', async () => {
    const root = mkdtempSync(join(tmpdir(), 'learning-audit-backup-'))
    directories.push(root)
    const profile = join(root, 'profile')
    mkdirSync(join(profile, 'agent'), { recursive: true })
    mkdirSync(join(profile, 'knowledge'), { recursive: true })
    mkdirSync(join(profile, 'worktrace', 'memory'), { recursive: true })
    writeFileSync(join(profile, 'settings.json'), '{}')
    new Ledger(join(profile, 'agent', 'ledger.sqlite')).close()
    new KnowledgeStore(join(profile, 'knowledge', 'knowledge.sqlite')).close()
    const path = join(profile, 'worktrace', 'memory', 'learning.sqlite')
    const legacy = new LearningStore(path)
    legacy.settings(scope, { reviewModelId: 'retained-model' })
    legacy.close()
    const downgrade = new DatabaseSync(path)
    downgrade.exec('DROP TABLE learning_settings_audit; PRAGMA user_version=15')
    downgrade.close()
    const central: CentralArchive = {
      exportTo: async (file) => {
        writeFileSync(file, 'PGDMPsynthetic-audit-compatibility')
        return { toolVersion: 'pg_dump (PostgreSQL) 16.15' }
      },
      inspect: async (file) => {
        if (!readFileSync(file).subarray(0, 5).equals(Buffer.from('PGDMP')))
          throw new Error('archive_invalid')
      }
    }
    const backup = await createJointBackup(profile, join(root, 'backups'), central)
    expect(
      backup.manifest.components.find((component) => component.name === 'learning')?.schemaVersion
    ).toBe(15)
    expect(await verifyJointBackup(backup.directory, central)).toEqual(backup.manifest)
    const staged = await stageJointRestore(backup.directory, join(root, 'restore'), central)
    expect(staged).toMatchObject({
      automaticStart: false,
      requiresReview: true,
      readyForProfile: false
    })
    const restored = new LearningStore(join(staged.directory, 'review-only', 'learning.sqlite'))
    stores.push(restored)
    expect(restored.settings(scope).reviewModelId).toBe('retained-model')
  })
})
