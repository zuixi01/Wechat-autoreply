import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import {
  HostModelConfigurationAudit,
  hostModelConfigurationHash
} from '../../src/main/services/host-model-configuration-audit'

const roots: string[] = []
const handles: Array<{ close(): void }> = []
const before = hostModelConfigurationHash({
  models: [{ id: 'model', apiKey: 'synthetic-private-key' }]
})
const after = hostModelConfigurationHash({
  models: [{ id: 'model', apiKey: 'synthetic-updated-key' }]
})

function fixture(): { path: string; audit: HostModelConfigurationAudit; db: DatabaseSync } {
  const root = mkdtempSync(join(tmpdir(), 'model-audit-'))
  roots.push(root)
  const path = join(root, 'learning.sqlite')
  const audit = new HostModelConfigurationAudit(path, before)
  const db = new DatabaseSync(path)
  handles.push(audit, db)
  return { path, audit, db }
}
afterEach(() => {
  for (const handle of handles.splice(0).reverse()) handle.close()
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep + 'model-audit-'))
      throw new Error('cleanup_path_invalid')
    rmSync(root, { recursive: true, force: true })
  }
})

describe('host model configuration audit', () => {
  it('ignores regenerated legacy model timestamps but audits both default model selections', () => {
    const models = [{ id: 'default-vision', apiKey: 'synthetic-key', createdAt: 1 }]
    const settings = { models, globalReplyModelId: '', globalVisionModelId: '' }
    const hash = hostModelConfigurationHash(settings)
    expect(
      hostModelConfigurationHash({ ...settings, models: [{ ...models[0], createdAt: 999 }] })
    ).toBe(hash)
    expect(
      hostModelConfigurationHash({ ...settings, globalReplyModelId: 'default-vision' })
    ).not.toBe(hash)
    expect(
      hostModelConfigurationHash({ ...settings, globalVisionModelId: 'default-vision' })
    ).not.toBe(hash)
  })

  it('records a credential-only change without storing credentials and ignores unrelated/no-op settings', () => {
    const { audit, db } = fixture()
    let actual = before
    audit.change(
      after,
      () => {
        actual = after
      },
      () => actual
    )
    audit.change(
      after,
      () => undefined,
      () => actual
    )
    const rows = db.prepare('SELECT * FROM learning_host_model_audit').all()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ before_hash: before, after_hash: after, state: 'applied' })
    expect(JSON.stringify(rows)).not.toContain('synthetic-private-key')
    expect(JSON.stringify(rows)).not.toContain('synthetic-updated-key')
    const settings = { models: [{ id: 'model', apiKey: 'synthetic-private-key' }], theme: 'dark' }
    expect(hostModelConfigurationHash(settings)).toBe(before)
  })

  it('refuses a settings write if its durable audit intent cannot be stored', () => {
    const { audit, db } = fixture()
    db.exec(
      `CREATE TRIGGER audit_fail BEFORE INSERT ON learning_host_model_audit BEGIN SELECT RAISE(ABORT,'audit_unavailable'); END`
    )
    let writes = 0
    expect(() =>
      audit.change(
        after,
        () => {
          writes++
        },
        () => before
      )
    ).toThrow('audit_unavailable')
    expect(writes).toBe(0)
  })

  it('records a failed external settings write without claiming the new model was applied', () => {
    const { audit, db } = fixture()
    expect(() =>
      audit.change(
        after,
        () => {
          throw new Error('synthetic_write_failure')
        },
        () => before
      )
    ).toThrow('synthetic_write_failure')
    expect(
      db.prepare('SELECT state,observed_hash FROM learning_host_model_audit').get()
    ).toMatchObject({ state: 'not_applied', observed_hash: before })
  })

  it.each([
    { actual: before, state: 'not_applied' },
    {
      actual: hostModelConfigurationHash({ models: [{ id: 'another-model' }] }),
      state: 'uncertain'
    }
  ])(
    'refuses a success response when the persisted configuration is $state',
    ({ actual, state }) => {
      const { audit, db } = fixture()
      let current = before
      expect(() =>
        audit.change(
          after,
          () => {
            current = actual
          },
          () => current
        )
      ).toThrow('model_configuration_write_not_confirmed')
      expect(
        db.prepare('SELECT state,observed_hash FROM learning_host_model_audit').get()
      ).toMatchObject({ state, observed_hash: actual })
    }
  )

  it('recovers a committed settings change after audit finalization fails, without duplicating the intent', () => {
    const { path, audit, db } = fixture()
    db.exec(
      `CREATE TRIGGER audit_finalize_fail BEFORE UPDATE ON learning_host_model_audit BEGIN SELECT RAISE(ABORT,'audit_finalize_unavailable'); END`
    )
    let actual = before
    expect(() =>
      audit.change(
        after,
        () => {
          actual = after
        },
        () => actual
      )
    ).toThrow('audit_finalize_unavailable')
    expect(actual).toBe(after)
    expect(db.prepare('SELECT state FROM learning_host_model_audit').get()?.state).toBe('prepared')
    audit.close()
    db.exec('DROP TRIGGER audit_finalize_fail')
    const reopened = new HostModelConfigurationAudit(path, actual)
    handles.push(reopened)
    const rows = db.prepare('SELECT state,observed_hash FROM learning_host_model_audit').all()
    expect(rows).toEqual([{ state: 'applied', observed_hash: after }])
  })

  it('records a change observed on restart without inventing its actor or original edit time', () => {
    const { path, audit, db } = fixture()
    audit.close()
    const reopened = new HostModelConfigurationAudit(path, after)
    handles.push(reopened)
    expect(db.prepare('SELECT reason,state FROM learning_host_model_audit').all()).toEqual([
      { reason: 'observed_after_restart', state: 'applied' }
    ])
  })
})
