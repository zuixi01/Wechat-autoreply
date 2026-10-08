import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { hashContext } from '../reply/hashes'
import { supportedLedgerSchema } from './ledger-schema'
import {
  LedgerRestoreDescriptorSchema as Descriptor,
  LedgerRestoreContextSchema as Context
} from '../../shared/contracts/restoration'
export type { LedgerRestoreContext } from '../../shared/contracts/restoration'
import type { LedgerRestoreContext } from '../../shared/contracts/restoration'

/** A restoration journal is a fence, never a release certificate. */
export function hasLedgerRestoreEvidence(db: DatabaseSync): boolean {
  return Boolean(
    db
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE name='ledger_restore_journal' UNION ALL SELECT 1 FROM runtime_metadata WHERE key='restore_journal_sequence' LIMIT 1"
      )
      .get()
  )
}

/** Read only durable SQLite provenance; a writable sidecar cannot authorize execution. */
export function readLedgerRestoreContext(db: DatabaseSync): LedgerRestoreContext | null {
  try {
    if (!supportedLedgerSchema(db.prepare('PRAGMA user_version').get()?.user_version))
      throw new Error('ledger_restore_context_invalid')
    const marker = db
      .prepare("SELECT value FROM runtime_metadata WHERE key='restore_review_required'")
      .get()
    const pointer = db
      .prepare("SELECT value FROM runtime_metadata WHERE key='restore_journal_sequence'")
      .get()
    if (!hasLedgerRestoreEvidence(db)) {
      if (pointer) throw new Error('ledger_restore_context_invalid')
      if (Number(marker?.value ?? 0) !== 0) throw new Error('ledger_restore_context_missing')
      return null
    }
    if (Number(marker?.value) !== 1 || !pointer || !Number.isSafeInteger(Number(pointer.value)))
      throw new Error('ledger_restore_context_invalid')
    const columns = db.prepare('PRAGMA table_info(ledger_restore_journal)').all()
    if (columns.map((column) => column.name).join(',') !== 'sequence,restore_id,context_json')
      throw new Error('ledger_restore_context_invalid')
    const count = Number(
      db.prepare('SELECT count(*) AS count FROM ledger_restore_journal').get()?.count
    )
    if (!Number.isSafeInteger(count) || count < 1 || count > 1000)
      throw new Error('ledger_restore_context_invalid')
    let previous: LedgerRestoreContext | null = null
    let sequence = 0
    const ids = new Set<string>()
    for (const row of db
      .prepare(
        'SELECT sequence,restore_id,CASE WHEN length(CAST(context_json AS BLOB))<=65536 THEN context_json END AS context_json FROM ledger_restore_journal ORDER BY sequence'
      )
      .iterate()) {
      if (typeof row.context_json !== 'string' || row.context_json.length > 65536)
        throw new Error('ledger_restore_context_invalid')
      const context = Context.parse(JSON.parse(row.context_json))
      const { contextHash: digest, ...descriptor } = context
      sequence++
      if (
        Number(row.sequence) !== sequence ||
        row.restore_id !== context.restoreId ||
        ids.has(context.restoreId) ||
        hashContext(descriptor) !== digest ||
        context.previousRestoreId !== (previous?.restoreId ?? null) ||
        context.previousContextHash !== (previous?.contextHash ?? null)
      )
        throw new Error('ledger_restore_context_invalid')
      ids.add(context.restoreId)
      previous = context
    }
    if (Number(pointer.value) !== sequence || sequence !== count || !previous)
      throw new Error('ledger_restore_context_invalid')
    return previous
  } catch (error) {
    if (error instanceof Error && error.message === 'ledger_restore_context_missing') throw error
    throw new Error('ledger_restore_context_invalid')
  }
}

/** Called inside the restore transaction, before its final database name is published. */
export function appendLedgerRestoreContext(
  db: DatabaseSync,
  source: { id: string; sha256: string }
): LedgerRestoreContext {
  if (!db.isTransaction) throw new Error('ledger_restore_context_transaction_required')
  const previous = hasLedgerRestoreEvidence(db) ? readLedgerRestoreContext(db) : null
  const descriptor = Descriptor.parse({
    formatVersion: 1,
    restoreId: randomUUID(),
    backupId: source.id,
    sourceSha256: source.sha256,
    restoredAt: new Date().toISOString(),
    previousRestoreId: previous?.restoreId ?? null,
    previousContextHash: previous?.contextHash ?? null,
    requiresReconciliation: true
  })
  const context = Context.parse({ ...descriptor, contextHash: hashContext(descriptor) })
  db.exec(`
    CREATE TABLE IF NOT EXISTS ledger_restore_journal (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      restore_id TEXT NOT NULL UNIQUE,
      context_json TEXT NOT NULL
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS ledger_restore_journal_no_update
      BEFORE UPDATE ON ledger_restore_journal BEGIN
      SELECT RAISE(ABORT,'ledger_restore_journal_immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ledger_restore_journal_no_delete
      BEFORE DELETE ON ledger_restore_journal BEGIN
      SELECT RAISE(ABORT,'ledger_restore_journal_immutable'); END;
  `)
  const row = db
    .prepare('INSERT INTO ledger_restore_journal(restore_id,context_json) VALUES(?,?)')
    .run(context.restoreId, JSON.stringify(context))
  db.prepare(
    "INSERT INTO runtime_metadata(key,value) VALUES('restore_journal_sequence',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).run(Number(row.lastInsertRowid))
  db.prepare(
    "INSERT INTO runtime_metadata(key,value) VALUES('restore_review_required',1) ON CONFLICT(key) DO UPDATE SET value=1"
  ).run()
  if (readLedgerRestoreContext(db)?.contextHash !== context.contextHash)
    throw new Error('ledger_restore_context_invalid')
  return context
}
