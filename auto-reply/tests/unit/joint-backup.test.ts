import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  readdirSync,
  existsSync,
  linkSync
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Ledger } from '../../src/core/persistence/ledger'
import { CURRENT_LEDGER_SCHEMA } from '../../src/core/persistence/ledger-schema'
import { KnowledgeStore } from '../../src/core/knowledge/knowledge-store'
import { LearningStore } from '../../src/core/memory/learning-store'
import {
  createJointBackup,
  verifyJointBackup,
  stageJointRestore,
  type CentralArchive
} from '../../src/core/persistence/joint-backup'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'autoreply-joint-'))
  roots.push(root)
  const profile = join(root, 'profile')
  mkdirSync(profile)
  mkdirSync(join(profile, 'agent'))
  mkdirSync(join(profile, 'knowledge'))
  mkdirSync(join(profile, 'worktrace', 'memory'), { recursive: true })
  const settings = Buffer.from(
    '{"globalAutoReply":true,"vision":{"apiKey":"PRIVATE_FIXTURE"},"modes":[]}\n'
  )
  writeFileSync(join(profile, 'settings.json'), settings)
  const ledger = new Ledger(join(profile, 'agent', 'ledger.sqlite'))
  ledger.close()
  const knowledge = new KnowledgeStore(join(profile, 'knowledge', 'knowledge.sqlite'))
  knowledge.close()
  const learning = new LearningStore(join(profile, 'worktrace', 'memory', 'learning.sqlite'))
  learning.close()
  const central: CentralArchive = {
    exportTo: async (file) => {
      writeFileSync(file, 'PGDMPsynthetic-full-archive')
      return { toolVersion: 'pg_dump (PostgreSQL) 16.15' }
    },
    inspect: async (file) => {
      if (!readFileSync(file).subarray(0, 5).equals(Buffer.from('PGDMP')))
        throw new Error('archive_invalid')
    }
  }
  return { root, profile, settings, central, output: join(root, 'backups') }
}
describe('joint backup and non-activating staged recovery', () => {
  it('captures committed WAL content, exact private configuration and every required source', async () => {
    const f = fixture()
    const db = new DatabaseSync(join(f.profile, 'knowledge', 'knowledge.sqlite'))
    try {
      db.exec(
        "PRAGMA wal_autocheckpoint=0; INSERT INTO knowledge_meta VALUES('joint-fixture','wal-only')"
      )
      const saved = await createJointBackup(f.profile, f.output, f.central)
      expect(await verifyJointBackup(saved.directory, f.central)).toEqual(saved.manifest)
      expect(saved.manifest).toMatchObject({
        consistency: 'independent-component-snapshots',
        automaticStart: false,
        requiresReview: true
      })
      expect(saved.manifest.components.find((c) => c.name === 'ledger')?.schemaVersion).toBe(
        CURRENT_LEDGER_SCHEMA
      )
      expect(readFileSync(join(saved.directory, 'settings.json'))).toEqual(f.settings)
      expect(saved.manifest.components.map((c) => c.name)).toEqual([
        'settings',
        'ledger',
        'knowledge',
        'learning',
        'device',
        'legacyCards',
        'foreground',
        'central'
      ])
      expect(
        saved.manifest.components.filter((c) => c.status === 'absent').map((c) => c.name)
      ).toEqual(['device', 'legacyCards', 'foreground'])
      const snapshot = new DatabaseSync(join(saved.directory, 'knowledge.sqlite'), {
        readOnly: true
      })
      try {
        expect(
          snapshot.prepare("SELECT value FROM knowledge_meta WHERE key='joint-fixture'").get()
            ?.value
        ).toBe('wal-only')
      } finally {
        snapshot.close()
      }
      expect(JSON.stringify(saved.manifest)).not.toContain('PRIVATE_FIXTURE')
      expect(JSON.stringify(saved.manifest)).not.toContain(f.profile)
    } finally {
      db.close()
    }
  })
  it('fails closed without a required source or when central export fails, never publishing a manifest', async () => {
    const f = fixture()
    rmSync(join(f.profile, 'worktrace', 'memory', 'learning.sqlite'))
    await expect(createJointBackup(f.profile, f.output, f.central)).rejects.toThrow(
      'joint_backup_failed'
    )
    const g = fixture()
    await expect(
      createJointBackup(g.profile, g.output, {
        ...g.central,
        exportTo: async () => {
          throw new Error('postgresql://PRIVATE')
        }
      })
    ).rejects.toThrow('joint_backup_failed')
    for (const dir of readdirSync(g.output))
      expect(existsSync(join(g.output, dir, 'manifest.json'))).toBe(false)
  })
  it('stages all data without installing active settings or old device authority and fences the ledger', async () => {
    const f = fixture()
    writeFileSync(
      join(f.profile, 'agent-device.json'),
      '{"device":{"credential":"encrypted-old-machine"}}'
    )
    writeFileSync(join(f.profile, 'worktrace', 'memory', 'cards.json'), '[]')
    const source = await createJointBackup(f.profile, f.output, f.central)
    const target = join(f.root, 'staged')
    const result = await stageJointRestore(source.directory, target, f.central)
    expect(result).toMatchObject({
      automaticStart: false,
      requiresReview: true,
      readyForProfile: false
    })
    expect(existsSync(join(target, 'settings.json'))).toBe(false)
    expect(readFileSync(join(target, 'review-only', 'settings.json'))).toEqual(f.settings)
    expect(readFileSync(join(target, 'review-only', 'agent-device.json'), 'utf8')).toContain(
      'encrypted-old-machine'
    )
    expect(readFileSync(join(target, 'review-only', 'central.dump'))).toEqual(
      readFileSync(join(source.directory, 'central.dump'))
    )
    const restored = new Ledger(join(target, 'ledger', 'ledger.sqlite'))
    try {
      expect(restored.requiresRestoreReview()).toBe(true)
    } finally {
      restored.close()
    }
    expect(existsSync(join(target, 'staging-receipt.json'))).toBe(true)
    await expect(stageJointRestore(source.directory, target, f.central)).rejects.toThrow(
      'joint_restore_target_exists'
    )
  })
  it.each([
    ['mutated settings', (d: string) => writeFileSync(join(d, 'settings.json'), '{}')],
    ['unknown inventory', (d: string) => writeFileSync(join(d, 'extra.txt'), 'extra')],
    ['truncated central archive', (d: string) => writeFileSync(join(d, 'central.dump'), 'PGDMP')],
    [
      'false authority claim',
      (d: string) => {
        const m = JSON.parse(readFileSync(join(d, 'manifest.json'), 'utf8'))
        m.automaticStart = true
        writeFileSync(join(d, 'manifest.json'), JSON.stringify(m))
      }
    ]
  ])('rejects %s before creating a restore target', async (_name, mutate) => {
    const f = fixture()
    const saved = await createJointBackup(f.profile, f.output, f.central)
    mutate(saved.directory)
    await expect(verifyJointBackup(saved.directory, f.central)).rejects.toThrow(
      'joint_backup_invalid'
    )
    await expect(
      stageJointRestore(saved.directory, join(f.root, 'invalid-target'), f.central)
    ).rejects.toThrow('joint_backup_invalid')
    expect(existsSync(join(f.root, 'invalid-target'))).toBe(false)
  })
  it('rejects aliased source files and semantically incompatible SQLite data', async () => {
    const f = fixture()
    linkSync(join(f.profile, 'settings.json'), join(f.root, 'settings-alias.json'))
    await expect(createJointBackup(f.profile, f.output, f.central)).rejects.toThrow(
      'joint_backup_failed'
    )
    const g = fixture()
    const db = new DatabaseSync(join(g.profile, 'worktrace', 'memory', 'learning.sqlite'))
    try {
      db.exec('PRAGMA user_version=999')
    } finally {
      db.close()
    }
    await expect(createJointBackup(g.profile, g.output, g.central)).rejects.toThrow(
      'joint_backup_failed'
    )
  })
  it('detects a source changed after verification and retains a fenced failed staging attempt', async () => {
    const f = fixture(),
      saved = await createJointBackup(f.profile, f.output, f.central)
    const target = join(f.root, 'failed-staging')
    const central = {
      ...f.central,
      inspect: async (file: string): Promise<void> => {
        await f.central.inspect(file)
        writeFileSync(join(saved.directory, 'settings.json'), '{"globalAutoReply":true}')
      }
    }
    await expect(stageJointRestore(saved.directory, target, central)).rejects.toThrow(
      'joint_restore_failed'
    )
    expect(existsSync(join(target, 'staging-receipt.json'))).toBe(false)
    expect(existsSync(join(target, 'settings.json'))).toBe(false)
    const restored = new Ledger(join(target, 'ledger', 'ledger.sqlite'))
    try {
      expect(restored.requiresRestoreReview()).toBe(true)
    } finally {
      restored.close()
    }
  })
})
