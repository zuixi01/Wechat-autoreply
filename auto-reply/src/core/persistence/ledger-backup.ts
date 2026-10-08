import { backup, DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, constants } from 'node:fs'
import { copyFile, lstat, mkdir, open, readFile, readdir, realpath, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { supportedLedgerSchema, type LedgerSchemaVersion } from './ledger-schema'
import {
  appendLedgerRestoreContext,
  hasLedgerRestoreEvidence,
  readLedgerRestoreContext,
  type LedgerRestoreContext
} from './ledger-restoration'

export interface LedgerBackupManifest {
  formatVersion: 1
  kind: 'ledger'
  schemaVersion: LedgerSchemaVersion
  id: string
  createdAt: string
  bytes: number
  sha256: string
}
const Manifest = z.strictObject({
  formatVersion: z.literal(1),
  kind: z.literal('ledger'),
  schemaVersion: z.union([z.literal(11), z.literal(12), z.literal(13)]),
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  bytes: z.number().int().positive().safe(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/)
})
async function realDirectory(path: string): Promise<string> {
  const absolute = resolve(path),
    info = await lstat(absolute),
    canonical = await realpath(absolute)
  const compare = (value: string): string =>
    process.platform === 'win32' ? value.toLowerCase() : value
  if (!info.isDirectory() || info.isSymbolicLink() || compare(canonical) !== compare(absolute))
    throw new Error('path_alias')
  return absolute
}
async function digest(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(path)) hash.update(bytes)
  return hash.digest('hex')
}
function inspect(db: DatabaseSync): void {
  if (!supportedLedgerSchema(db.prepare('PRAGMA user_version').get()?.user_version))
    throw new Error('ledger_backup_schema_unsupported')
  const tables = new Set(
    db
      .prepare("SELECT name FROM sqlite_schema WHERE type='table'")
      .all()
      .map((row) => row.name)
  )
  if (
    ![
      'conversations',
      'conversation_controls',
      'messages',
      'sends',
      'central_attempts',
      'runtime_metadata'
    ].every((table) => tables.has(table))
  )
    throw new Error('ledger_backup_invalid')
  if (
    Number(db.prepare('PRAGMA user_version').get()?.user_version) >= 12 &&
    !tables.has('learning_outbox')
  )
    throw new Error('ledger_backup_invalid')
  if (
    Number(db.prepare('PRAGMA user_version').get()?.user_version) >= 13 &&
    !tables.has('learning_submissions')
  )
    throw new Error('ledger_backup_invalid')
  const checks = db.prepare('PRAGMA integrity_check').all()
  if (
    checks.length !== 1 ||
    checks[0].integrity_check !== 'ok' ||
    db.prepare('PRAGMA foreign_key_check').get()
  )
    throw new Error('ledger_backup_invalid')
  if (hasLedgerRestoreEvidence(db)) {
    try {
      readLedgerRestoreContext(db)
    } catch {
      throw new Error('ledger_backup_invalid')
    }
  }
}
async function durableFile(path: string, contents?: string): Promise<void> {
  const handle = await open(path, contents === undefined ? 'r+' : 'wx', 0o600)
  try {
    if (contents !== undefined) await handle.writeFile(contents)
    await handle.sync()
  } finally {
    await handle.close()
  }
}
export async function createLedgerBackup(
  source: DatabaseSync,
  root: string
): Promise<{ directory: string; manifest: LedgerBackupManifest }> {
  inspect(source)
  await mkdir(root, { recursive: true, mode: 0o700 })
  const parent = await realDirectory(root),
    id = randomUUID(),
    directory = join(parent, id)
  await mkdir(directory, { mode: 0o700 })
  const file = join(directory, 'ledger.sqlite')
  await backup(source, file)
  // Consolidate the isolated result; no source checkpoint or source-file copy.
  const snapshot = new DatabaseSync(file)
  try {
    snapshot.exec('PRAGMA journal_mode=DELETE')
    inspect(snapshot)
  } finally {
    snapshot.close()
  }
  await durableFile(file)
  const manifest: LedgerBackupManifest = {
    formatVersion: 1,
    kind: 'ledger',
    schemaVersion: Number(
      source.prepare('PRAGMA user_version').get()?.user_version
    ) as LedgerSchemaVersion,
    id,
    createdAt: new Date().toISOString(),
    bytes: (await lstat(file)).size,
    sha256: await digest(file)
  }
  // Publication is last. Failed/incomplete directories are retained, never accepted.
  await durableFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  await verifyLedgerBackup(directory)
  return { directory, manifest }
}
export async function verifyLedgerBackup(directory: string): Promise<LedgerBackupManifest> {
  try {
    const root = await realDirectory(directory)
    if (
      JSON.stringify((await readdir(root)).sort()) !==
      JSON.stringify(['ledger.sqlite', 'manifest.json'])
    )
      throw new Error('inventory')
    for (const name of ['ledger.sqlite', 'manifest.json']) {
      const info = await lstat(join(root, name))
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1 ||
        (name === 'manifest.json' && info.size > 65536)
      )
        throw new Error('file_type')
    }
    const manifest = Manifest.parse(JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')))
    const file = join(root, 'ledger.sqlite')
    if ((await lstat(file)).size !== manifest.bytes || (await digest(file)) !== manifest.sha256)
      throw new Error('digest')
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON')
      inspect(db)
      if (db.prepare('PRAGMA user_version').get()?.user_version !== manifest.schemaVersion)
        throw new Error('ledger_backup_invalid')
    } finally {
      db.close()
    }
    return manifest
  } catch {
    throw new Error('ledger_backup_invalid')
  }
}
export async function restoreLedgerBackup(
  directory: string,
  target: string
): Promise<{
  databasePath: string
  manifest: LedgerBackupManifest
  restoreContext: LedgerRestoreContext
  requiresReconciliation: true
}> {
  const manifest = await verifyLedgerBackup(directory),
    destination = resolve(target)
  await realDirectory(dirname(destination))
  try {
    await mkdir(destination, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error('ledger_restore_target_exists')
    throw new Error('ledger_restore_failed')
  }
  await realDirectory(destination)
  const staging = join(destination, 'ledger.pending.sqlite'),
    databasePath = join(destination, 'ledger.sqlite')
  try {
    await copyFile(join(resolve(directory), 'ledger.sqlite'), staging, constants.COPYFILE_EXCL)
    if ((await digest(staging)) !== manifest.sha256) throw new Error('ledger_backup_invalid')
    const db = new DatabaseSync(staging)
    let restoreContext: LedgerRestoreContext
    try {
      db.exec('PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL')
      inspect(db)
      db.exec('BEGIN IMMEDIATE')
      try {
        restoreContext = appendLedgerRestoreContext(db, manifest)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      inspect(db)
    } finally {
      db.close()
    }
    // The final name only appears once the database itself carries the fence.
    await copyFile(staging, databasePath, constants.COPYFILE_EXCL)
    await durableFile(databasePath)
    await durableFile(join(destination, 'restore.json'), JSON.stringify(restoreContext) + '\n')
    await unlink(staging)
    return { databasePath, manifest, restoreContext, requiresReconciliation: true }
  } catch (error) {
    // Retain incomplete attempts. A published ledger.sqlite already carries the fence.
    throw new Error(
      error instanceof Error && error.message === 'ledger_backup_invalid'
        ? 'ledger_backup_invalid'
        : 'ledger_restore_failed'
    )
  }
}
