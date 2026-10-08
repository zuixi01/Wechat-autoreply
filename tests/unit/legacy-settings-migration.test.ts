import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  readdirSync,
  existsSync
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { LegacySettingsArchive } from '../../src/core/persistence/legacy-settings-archive'

const roots: string[] = [],
  archives: LegacySettingsArchive[] = []
afterEach(() => {
  archives.splice(0).forEach((store) => store.close())
  roots.splice(0).forEach((root) => {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep + 'legacy-settings-'))
      throw new Error('unexpected_fixture_path')
    rmSync(root, { recursive: true, force: true })
  })
})
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'legacy-settings-'))
  roots.push(root)
  const file = join(root, 'settings.json'),
    database = join(root, 'drafts.sqlite')
  const data = {
    theme: 'light',
    locale: 'zh',
    appType: 'wechat',
    globalAutoReply: true,
    globalDefaultModeId: 'mode-a',
    apiKey: 'SYNTHETIC_PRIVATE_KEY',
    vision: { apiKey: 'SYNTHETIC_VISION_KEY' },
    chatProvider: {
      installed: { entryFile: 'untrusted.js' },
      manifestUrl: 'https://example.invalid/provider',
      config: { token: 'SYNTHETIC_PROVIDER_TOKEN' }
    },
    capture: { wechat: { regions: { inputBox: { x: 1 } } } },
    modes: [
      {
        id: 'mode-a',
        name: '咨询',
        prompt: '先确认客户型号',
        unifiedPrefix: '您好',
        autoReply: true,
        running: true,
        enabled: true,
        specificObjects: [
          {
            id: 'object-a',
            name: '同名客户',
            title: '经理',
            relationship: '待核对客户',
            modeId: 'mode-a',
            autoReply: true
          },
          { id: 'object-b', name: '同名客户', modeId: 'mode-a', autoReply: false }
        ]
      }
    ]
  }
  writeFileSync(file, JSON.stringify(data))
  const archive = new LegacySettingsArchive(database, 'workspace-a')
  archives.push(archive)
  return { root, file, database, archive, data }
}
describe('legacy settings migrate as isolated unassigned drafts', () => {
  it('backs up exact bytes and never promotes old booleans, secrets, executable code or names into authority', async () => {
    const f = setup(),
      original = readFileSync(f.file)
    const result = await f.archive.importFile(f.file)
    expect(readFileSync(join(result.backupDirectory, 'source.json'))).toEqual(original)
    const drafts = f.archive.list()
    expect(drafts).toHaveLength(4)
    expect(
      drafts.every(
        (d) => d.state === 'pending' && d.automaticEnabled === false && d.identityVerified === false
      )
    ).toBe(true)
    const json = JSON.stringify(drafts)
    for (const forbidden of [
      'SYNTHETIC_PRIVATE_KEY',
      'SYNTHETIC_VISION_KEY',
      'SYNTHETIC_PROVIDER_TOKEN',
      'untrusted.js',
      'manifestUrl',
      'inputBox',
      'conversationId'
    ])
      expect(json).not.toContain(forbidden)
    expect(drafts.filter((d) => d.content.kind === 'relationship')).toHaveLength(2)
    expect(readFileSync(f.file)).toEqual(original)
    expect(result).toMatchObject({
      createdDrafts: 4,
      reusedDrafts: 0,
      automaticEnabled: false,
      reviewRequired: true
    })
  })
  it('repeats across restart without duplicates and ignores excluded credential changes when deduplicating drafts', async () => {
    const f = setup(),
      first = await f.archive.importFile(f.file)
    expect((await f.archive.importFile(f.file)).createdDrafts).toBe(0)
    writeFileSync(f.file, JSON.stringify({ ...f.data, apiKey: 'ROTATED_SYNTHETIC_KEY' }))
    const changed = await f.archive.importFile(f.file)
    expect(changed.sourceSha256).not.toBe(first.sourceSha256)
    expect(changed).toMatchObject({ createdDrafts: 0, reusedDrafts: 4 })
    f.archive.close()
    const reopened = new LegacySettingsArchive(f.database, 'workspace-a')
    archives.push(reopened)
    expect(reopened.list()).toHaveLength(4)
    expect((await reopened.importFile(f.file)).createdDrafts).toBe(0)
  })
  it('appends changed rules without replacing prior private drafts', async () => {
    const f = setup()
    await f.archive.importFile(f.file)
    f.data.modes[0].prompt = '先确认型号和数量'
    writeFileSync(f.file, JSON.stringify(f.data))
    expect(await f.archive.importFile(f.file)).toMatchObject({ createdDrafts: 1, reusedDrafts: 3 })
    expect(f.archive.list().filter((d) => d.content.kind === 'mode')).toHaveLength(2)
  })
  it('refuses a different archive owner', () => {
    const f = setup()
    expect(() => new LegacySettingsArchive(f.database, 'workspace-b')).toThrow(
      'legacy_settings_owner_mismatch'
    )
  })
  it('keeps the original backup and rolls back all import records after a database failure', async () => {
    const f = setup(),
      db = new DatabaseSync(f.database)
    db.exec(
      "CREATE TRIGGER fail_import BEFORE INSERT ON legacy_settings_imports BEGIN SELECT RAISE(FAIL,'synthetic failure'); END"
    )
    await expect(f.archive.importFile(f.file)).rejects.toThrow('legacy_settings_import_failed')
    expect(f.archive.list()).toEqual([])
    expect(readdirSync(f.database + '.backups')).toHaveLength(1)
    db.exec('DROP TRIGGER fail_import')
    db.close()
    expect((await f.archive.importFile(f.file)).createdDrafts).toBe(4)
  })
  it('refuses a corrupted existing backup before importing', async () => {
    const f = setup(),
      result = await f.archive.importFile(f.file)
    writeFileSync(join(result.backupDirectory, 'source.json'), 'changed')
    await expect(f.archive.importFile(f.file)).rejects.toThrow('legacy_settings_backup_conflict')
    expect(f.archive.list()).toHaveLength(4)
  })
  it('backs up malformed input but creates no drafts, then safely retries corrected input', async () => {
    const f = setup()
    writeFileSync(f.file, '{invalid-json')
    await expect(f.archive.importFile(f.file)).rejects.toThrow('legacy_settings_invalid')
    expect(f.archive.list()).toEqual([])
    expect(readdirSync(f.database + '.backups')).toHaveLength(1)
    writeFileSync(f.file, JSON.stringify(f.data))
    expect((await f.archive.importFile(f.file)).createdDrafts).toBe(4)
  })
  it('refuses directory aliases and duplicate legacy IDs without touching source data', async () => {
    const f = setup(),
      alias = join(f.root, 'alias')
    symlinkSync(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(f.archive.importFile(join(alias, 'settings.json'))).rejects.toThrow(
      'legacy_settings_source_invalid'
    )
    writeFileSync(f.file, JSON.stringify({ ...f.data, modes: [...f.data.modes, f.data.modes[0]] }))
    await expect(f.archive.importFile(f.file)).rejects.toThrow('legacy_settings_invalid')
    expect(f.archive.list()).toEqual([])
  })
  it('retains an older global systemPrompt as a draft without importing its credentials', async () => {
    const f = setup()
    writeFileSync(
      f.file,
      JSON.stringify({ systemPrompt: '旧全局规则', apiKey: 'SYNTHETIC_OLD_KEY', autoReply: true })
    )
    await f.archive.importFile(f.file)
    expect(f.archive.list().filter((d) => d.content.kind === 'mode')).toHaveLength(1)
    expect(JSON.stringify(f.archive.list())).not.toContain('SYNTHETIC_OLD_KEY')
  })
  it('inspects read-only without creating missing files or permitting imports', async () => {
    const f = setup()
    await f.archive.importFile(f.file)
    const reader = new LegacySettingsArchive(f.database, 'workspace-a', { readOnly: true })
    archives.push(reader)
    expect(reader.list()).toHaveLength(4)
    await expect(reader.importFile(f.file)).rejects.toThrow('legacy_settings_archive_read_only')
    const missing = join(f.root, 'missing', 'drafts.sqlite')
    expect(() => new LegacySettingsArchive(missing, 'workspace-a', { readOnly: true })).toThrow(
      'legacy_settings_archive_path_invalid'
    )
    expect(existsSync(join(f.root, 'missing'))).toBe(false)
  })
  it('detects changed stored content instead of reusing an inconsistent draft', async () => {
    const f = setup()
    await f.archive.importFile(f.file)
    const db = new DatabaseSync(f.database)
    const row = db.prepare('SELECT id,payload FROM legacy_settings_drafts LIMIT 1').get()!
    const draft = JSON.parse(String(row.payload))
    draft.content.autoReplyRequested = !draft.content.autoReplyRequested
    db.prepare('UPDATE legacy_settings_drafts SET payload=? WHERE id=?').run(
      JSON.stringify(draft),
      String(row.id)
    )
    db.close()
    expect(() => f.archive.list()).toThrow('legacy_settings_archive_corrupt')
    await expect(f.archive.importFile(f.file)).rejects.toThrow('legacy_settings_import_failed')
  })
  it('runs actual CLI migration and read-only summary without exposing private values', () => {
    const f = setup(),
      cli = join(process.cwd(), 'scripts/legacy-settings-migrate.ts')
    const invoke = (...args: string[]) =>
      spawnSync(process.execPath, ['--import', 'tsx', cli, ...args], {
        encoding: 'utf8',
        timeout: 15000
      })
    const run = invoke(
      'migrate',
      '--source',
      f.file,
      '--archive',
      f.database,
      '--workspace',
      'workspace-a'
    )
    expect(run.status, run.stderr).toBe(0)
    expect(JSON.parse(run.stdout)).toMatchObject({
      passed: true,
      createdDrafts: 4,
      automaticEnabled: false
    })
    const inspect = invoke('inspect', '--archive', f.database, '--workspace', 'workspace-a')
    expect(inspect.status, inspect.stderr).toBe(0)
    expect(JSON.parse(inspect.stdout)).toMatchObject({
      drafts: 4,
      kinds: { preferences: 1, mode: 1, relationship: 2 },
      reviewRequired: true
    })
    for (const value of ['SYNTHETIC_PRIVATE_KEY', '同名客户', '先确认客户型号'])
      expect(run.stdout + inspect.stdout + run.stderr + inspect.stderr).not.toContain(value)
    const denied = invoke('inspect', '--archive', f.database, '--workspace', 'workspace-b')
    expect(denied.status).toBe(1)
    expect(denied.stderr).toContain('legacy_settings_owner_mismatch')
    expect(denied.stdout).toBe('')
    const missing = join(f.root, 'missing', 'archive.sqlite')
    expect(invoke('inspect', '--archive', missing, '--workspace', 'workspace-a').status).toBe(1)
    expect(existsSync(join(f.root, 'missing'))).toBe(false)
    expect(invoke('--help').status).toBe(0)
  })
})
