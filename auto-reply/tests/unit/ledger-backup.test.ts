import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  statSync,
  symlinkSync
} from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Ledger } from '../../src/core/persistence/ledger'
import {
  createLedgerBackup,
  restoreLedgerBackup,
  verifyLedgerBackup
} from '../../src/core/persistence/ledger-backup'
import { taskFixture } from '../fixtures/task'

const roots: string[] = []
const execute = promisify(execFile)
const cli = (...args: string[]) =>
  execute(
    process.execPath,
    [resolve('node_modules/tsx/dist/cli.mjs'), resolve('scripts/ledger-recovery.ts'), ...args],
    { windowsHide: true, timeout: 10000, maxBuffer: 65536 }
  )
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep + 'ledger-recovery-'))
      throw new Error('unexpected_fixture_root')
    rmSync(root, { recursive: true, force: true })
  }
})
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'ledger-recovery-'))
  roots.push(root)
  const source = join(root, 'source.sqlite'),
    ledger = new Ledger(source),
    f = taskFixture()
  const message = (id: string) => ({
    identity: f.task.identity,
    conversationId: f.task.conversationId,
    sourceMessageId: id,
    direction: 'inbound' as const,
    kind: 'text' as const,
    text: '合成恢复测试',
    observedAt: 1000,
    identityVerified: true,
    messageIdVerified: true
  })
  ledger.observe(message('before'))
  ledger.setHumanOwned(f.task.identity, f.task.conversationId, true)
  const send = ledger.prepare(f.task, f.draft.draftHash, 1000).record
  ledger.transition(send.executionId, 'prepared', 'dispatching', 1001)
  return { root, source, ledger, f, send, message }
}
async function snapshot() {
  const f = setup(),
    read = new DatabaseSync(f.source, { readOnly: true })
  try {
    return { ...f, backup: await createLedgerBackup(read, join(f.root, 'backups')) }
  } finally {
    read.close()
    f.ledger.close()
  }
}
describe('consistent ledger backups and quarantined restore', () => {
  it('persists unique restoration provenance for each replay of the same backup', async () => {
    const f = await snapshot()
    const first = await restoreLedgerBackup(f.backup.directory, join(f.root, 'first'))
    const second = await restoreLedgerBackup(f.backup.directory, join(f.root, 'second'))
    expect(first.restoreContext).toMatchObject({
      formatVersion: 1,
      restoreId: expect.stringMatching(/^[a-f0-9-]{36}$/),
      backupId: f.backup.manifest.id,
      sourceSha256: f.backup.manifest.sha256,
      previousRestoreId: null,
      requiresReconciliation: true
    })
    expect(first.restoreContext.restoreId).not.toBe(second.restoreContext.restoreId)
    expect(JSON.parse(readFileSync(join(f.root, 'first', 'restore.json'), 'utf8'))).toEqual(
      first.restoreContext
    )
    const ledger = new Ledger(first.databasePath)
    try {
      expect(ledger.restoreContext()).toEqual(first.restoreContext)
      expect(ledger.requiresRestoreReview()).toBe(true)
    } finally {
      ledger.close()
    }
  })
  it('keeps the restoration fence after the old marker is cleared', async () => {
    const f = await snapshot()
    const restored = await restoreLedgerBackup(f.backup.directory, join(f.root, 'restored'))
    const db = new DatabaseSync(restored.databasePath)
    db.exec("UPDATE runtime_metadata SET value=0 WHERE key='restore_review_required'")
    db.close()
    const ledger = new Ledger(restored.databasePath)
    try {
      expect(ledger.requiresRestoreReview()).toBe(true)
      expect(() => ledger.prepare(f.f.task, f.f.draft.draftHash, 5000)).toThrow(
        'ledger_restore_reconciliation_required'
      )
    } finally {
      ledger.close()
    }
  })
  it('keeps a durable restoration pointer fenced even if its journal table is missing', async () => {
    const f = await snapshot()
    const restored = await restoreLedgerBackup(f.backup.directory, join(f.root, 'restored'))
    const db = new DatabaseSync(restored.databasePath)
    db.exec(
      "DROP TABLE ledger_restore_journal; UPDATE runtime_metadata SET value=0 WHERE key='restore_review_required'"
    )
    db.close()
    const ledger = new Ledger(restored.databasePath)
    try {
      expect(ledger.requiresRestoreReview()).toBe(true)
      expect(() => ledger.restoreContext()).toThrow('ledger_restore_context_invalid')
    } finally {
      ledger.close()
    }
  })
  it('returns no restoration context for an ordinary ledger without creating a restore table', () => {
    const f = setup()
    try {
      expect(f.ledger.restoreContext()).toBeNull()
      const db = new DatabaseSync(f.source, { readOnly: true })
      try {
        expect(
          db.prepare("SELECT name FROM sqlite_schema WHERE name='ledger_restore_journal'").get()
        ).toBeUndefined()
      } finally {
        db.close()
      }
    } finally {
      f.ledger.close()
    }
  })
  it('links a restored backup to its preceding restoration without reusing authority', async () => {
    const f = await snapshot()
    const first = await restoreLedgerBackup(f.backup.directory, join(f.root, 'first'))
    const read = new DatabaseSync(first.databasePath, { readOnly: true })
    let saved
    try {
      saved = await createLedgerBackup(read, join(f.root, 'nested-backups'))
    } finally {
      read.close()
    }
    const second = await restoreLedgerBackup(saved.directory, join(f.root, 'second'))
    expect(second.restoreContext).toMatchObject({
      previousRestoreId: first.restoreContext.restoreId,
      previousContextHash: first.restoreContext.contextHash,
      backupId: saved.manifest.id,
      sourceSha256: saved.manifest.sha256
    })
    expect(second.restoreContext.restoreId).not.toBe(first.restoreContext.restoreId)
    const ledger = new Ledger(second.databasePath)
    try {
      expect(ledger.restoreContext()).toEqual(second.restoreContext)
      expect(ledger.requiresRestoreReview()).toBe(true)
    } finally {
      ledger.close()
    }
  })
  it('rejects normal journal changes and detects corruption after its guard is removed', async () => {
    const f = await snapshot()
    const restored = await restoreLedgerBackup(f.backup.directory, join(f.root, 'restored'))
    const db = new DatabaseSync(restored.databasePath)
    try {
      expect(() => db.exec("UPDATE ledger_restore_journal SET context_json='{}'")).toThrow(
        'ledger_restore_journal_immutable'
      )
      db.exec(
        "DROP TRIGGER ledger_restore_journal_no_update; UPDATE ledger_restore_journal SET context_json='{}'"
      )
    } finally {
      db.close()
    }
    const ledger = new Ledger(restored.databasePath)
    try {
      expect(() => ledger.restoreContext()).toThrow('ledger_restore_context_invalid')
      expect(ledger.requiresRestoreReview()).toBe(true)
    } finally {
      ledger.close()
    }
  })
  it('inspects restoration provenance through the real readonly CLI instead of the sidecar', async () => {
    const f = await snapshot()
    const restored = await restoreLedgerBackup(f.backup.directory, join(f.root, 'restored'))
    writeFileSync(join(f.root, 'restored', 'restore.json'), '{"requiresReconciliation":false}')
    const before = readFileSync(restored.databasePath)
    const inspected = JSON.parse(
      (await cli('inspect-restoration', '--source', restored.databasePath)).stdout
    )
    expect(inspected).toEqual({
      passed: true,
      command: 'inspect-restoration',
      context: restored.restoreContext,
      requiresReconciliation: true
    })
    expect(inspected).not.toHaveProperty('messages')
    expect(readFileSync(restored.databasePath)).toEqual(before)
  })
  it('keeps a legacy restored ledger blocked when provenance is unavailable', () => {
    const f = setup()
    f.ledger.close()
    const db = new DatabaseSync(f.source)
    db.prepare("INSERT INTO runtime_metadata(key,value) VALUES('restore_review_required',1)").run()
    db.close()
    const ledger = new Ledger(f.source)
    try {
      expect(() => ledger.restoreContext()).toThrow('ledger_restore_context_missing')
      expect(ledger.requiresRestoreReview()).toBe(true)
    } finally {
      ledger.close()
    }
  })
  it('rolls back provenance and its fence together when restoration metadata fails', async () => {
    const f = setup()
    f.ledger.close()
    const db = new DatabaseSync(f.source)
    db.exec(`CREATE TRIGGER synthetic_restore_failure BEFORE INSERT ON runtime_metadata
      WHEN new.key='restore_journal_sequence'
      BEGIN SELECT RAISE(ABORT,'synthetic_private_failure'); END`)
    const saved = await createLedgerBackup(db, join(f.root, 'backups'))
    db.close()
    const target = join(f.root, 'restored')
    await expect(restoreLedgerBackup(saved.directory, target)).rejects.toThrow(
      'ledger_restore_failed'
    )
    expect(() => statSync(join(target, 'ledger.sqlite'))).toThrow()
    expect(() => statSync(join(target, 'restore.json'))).toThrow()
    const pending = new DatabaseSync(join(target, 'ledger.pending.sqlite'), { readOnly: true })
    try {
      expect(
        pending.prepare("SELECT name FROM sqlite_schema WHERE name='ledger_restore_journal'").get()
      ).toBeUndefined()
      expect(
        pending
          .prepare(
            "SELECT value FROM runtime_metadata WHERE key IN ('restore_review_required','restore_journal_sequence')"
          )
          .all()
      ).toEqual([])
    } finally {
      pending.close()
    }
  })
  it('includes committed WAL data, preserves source writes and restores history without authorizing replay', async () => {
    const f = setup(),
      source = new DatabaseSync(f.source, { readOnly: true })
    expect(statSync(f.source + '-wal').size).toBeGreaterThan(0)
    let saved
    try {
      saved = await createLedgerBackup(source, join(f.root, 'backups'))
      f.ledger.observe(f.message('after'))
      expect(f.ledger.snapshot(f.f.task.identity, f.f.task.conversationId).messages).toHaveLength(2)
    } finally {
      source.close()
      f.ledger.close()
    }
    expect(await verifyLedgerBackup(saved.directory)).toMatchObject({
      schemaVersion: 13,
      kind: 'ledger',
      sha256: /^[a-f0-9]{64}$/
    })
    const restored = await restoreLedgerBackup(saved.directory, join(f.root, 'restored'))
    const ledger = new Ledger(restored.databasePath)
    try {
      expect(ledger.snapshot(f.f.task.identity, f.f.task.conversationId)).toMatchObject({
        humanOwned: true,
        messages: [expect.objectContaining({ sourceMessageId: 'before' })]
      })
      expect(ledger.getSend(f.send.executionId)?.status).toBe('unknown')
      expect(ledger.requiresRestoreReview()).toBe(true)
      expect(() =>
        ledger.prepare({ ...f.f.task, taskId: 'new-task' }, f.f.draft.draftHash, 5000)
      ).toThrow('ledger_restore_reconciliation_required')
    } finally {
      ledger.close()
    }
    const reopened = new Ledger(restored.databasePath)
    try {
      expect(reopened.requiresRestoreReview()).toBe(true)
    } finally {
      reopened.close()
    }
  })
  it.each(['ledger.sqlite', 'manifest.json'])(
    'rejects changed %s without creating a restore target',
    async (file) => {
      const f = await snapshot(),
        target = join(f.root, 'restored')
      writeFileSync(join(f.backup.directory, file), 'changed')
      await expect(restoreLedgerBackup(f.backup.directory, target)).rejects.toThrow(
        'ledger_backup_invalid'
      )
      expect(() => statSync(target)).toThrow()
    }
  )
  it('refuses an existing destination and leaves its bytes intact', async () => {
    const f = await snapshot(),
      target = join(f.root, 'restored')
    mkdirSync(target)
    writeFileSync(join(target, 'ledger.sqlite'), 'existing')
    await expect(restoreLedgerBackup(f.backup.directory, target)).rejects.toThrow(
      'ledger_restore_target_exists'
    )
    expect(readFileSync(join(target, 'ledger.sqlite'), 'utf8')).toBe('existing')
  })
  it('rejects extra files and directory aliases', async () => {
    const f = await snapshot(),
      alias = join(f.root, 'alias')
    symlinkSync(f.backup.directory, alias, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(verifyLedgerBackup(alias)).rejects.toThrow('ledger_backup_invalid')
    writeFileSync(join(f.backup.directory, 'extra.json'), '{}')
    await expect(verifyLedgerBackup(f.backup.directory)).rejects.toThrow('ledger_backup_invalid')
  })
  it('rejects unsupported source schema without publishing a manifest', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ledger-recovery-'))
    roots.push(root)
    const source = new DatabaseSync(':memory:')
    source.exec('PRAGMA user_version=14')
    try {
      await expect(createLedgerBackup(source, join(root, 'backups'))).rejects.toThrow(
        'ledger_backup_schema_unsupported'
      )
    } finally {
      source.close()
    }
  })
  it('offers offline CLI help and verifies a snapshot without touching its source', async () => {
    expect((await cli('--help')).stdout).toContain('backup --source')
    const f = await snapshot()
    const result = JSON.parse((await cli('verify', '--backup', f.backup.directory)).stdout)
    expect(result).toMatchObject({ passed: true, command: 'verify', schemaVersion: 13 })
    expect(readFileSync(join(f.backup.directory, 'manifest.json'), 'utf8')).not.toContain(
      '合成恢复测试'
    )
  })
  it('executes CLI backup and restore with a persistent fence', async () => {
    const f = setup()
    f.ledger.close()
    const saved = JSON.parse(
      (await cli('backup', '--source', f.source, '--output', join(f.root, 'cli-backups'))).stdout
    )
    const restored = JSON.parse(
      (await cli('restore', '--backup', saved.directory, '--output', join(f.root, 'cli-restored')))
        .stdout
    )
    expect(restored).toMatchObject({
      passed: true,
      command: 'restore',
      requiresReconciliation: true
    })
    const ledger = new Ledger(restored.databasePath)
    try {
      expect(ledger.requiresRestoreReview()).toBe(true)
    } finally {
      ledger.close()
    }
  })
  it('preserves an existing restore target and sanitizes CLI failures', async () => {
    const f = await snapshot()
    const target = join(f.root, 'cli-restored')
    const restored = await restoreLedgerBackup(f.backup.directory, target)
    const original = readFileSync(restored.databasePath)
    const failed = await cli('restore', '--backup', f.backup.directory, '--output', target).catch(
      (error) => error
    )
    expect(failed.stderr.trim()).toBe('ledger_restore_target_exists')
    expect(readFileSync(restored.databasePath)).toEqual(original)
    const invalid = await cli(
      'verify',
      '--backup',
      f.backup.directory,
      '--source',
      'synthetic-private-path'
    ).catch((error) => error)
    expect(invalid.stderr.trim()).toBe('ledger_recovery_arguments_invalid')
    expect(invalid.stderr).not.toContain('synthetic-private-path')
  })
  it('rejects a supported-version database with invalid foreign keys', async () => {
    const f = setup()
    f.ledger.close()
    const source = new DatabaseSync(f.source)
    source.exec("PRAGMA foreign_keys=OFF; UPDATE messages SET scope='missing-parent'")
    try {
      await expect(createLedgerBackup(source, join(f.root, 'backups'))).rejects.toThrow(
        'ledger_backup_invalid'
      )
    } finally {
      source.close()
    }
  })
  it.each([
    { formatVersion: 2 },
    { schemaVersion: 10 },
    { schemaVersion: 11 },
    { schemaVersion: 12 },
    { extra: true }
  ])('rejects an incompatible or expanded manifest %j', async (patch) => {
    const f = await snapshot()
    writeFileSync(
      join(f.backup.directory, 'manifest.json'),
      JSON.stringify({ ...f.backup.manifest, ...patch })
    )
    await expect(verifyLedgerBackup(f.backup.directory)).rejects.toThrow('ledger_backup_invalid')
  })
})
