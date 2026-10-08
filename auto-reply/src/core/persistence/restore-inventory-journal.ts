import type { DatabaseSync } from 'node:sqlite'
import { Hash } from '../../shared/contracts/identity'
import {
  RestoreInventoryStartSchema,
  type RestoreInventoryStartInput
} from '../../shared/contracts/restore-inventory'
import { readLedgerRestoreContext } from './ledger-restoration'
import { hashContext } from '../reply/hashes'

function bound(db: DatabaseSync, request: RestoreInventoryStartInput): void {
  if (hashContext(readLedgerRestoreContext(db)) !== hashContext(request.manifest.context))
    throw Error('ledger_restore_inventory_attempt_invalid')
}
export function readRestoreInventoryAttempt(
  db: DatabaseSync,
  sourceKey: string,
  now: number
): RestoreInventoryStartInput | null {
  Hash.parse(sourceKey)
  if (
    !db
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='ledger_restore_inventory_attempts'"
      )
      .get()
  )
    return null
  const row = db
    .prepare(
      'SELECT request_hash,CASE WHEN length(CAST(request_json AS BLOB))<=16384 THEN request_json END AS request_json FROM ledger_restore_inventory_attempts WHERE source_key=? AND created_at>=? ORDER BY created_at DESC,rowid DESC LIMIT 1'
    )
    .get(sourceKey, now - 890000)
  if (!row) return null
  try {
    if (typeof row.request_json !== 'string') throw Error('invalid')
    const request = RestoreInventoryStartSchema.parse(JSON.parse(row.request_json))
    if (hashContext(request) !== row.request_hash) throw Error('invalid')
    bound(db, request)
    return request
  } catch {
    throw Error('ledger_restore_inventory_attempt_invalid')
  }
}
export function saveRestoreInventoryAttempt(
  db: DatabaseSync,
  sourceKey: string,
  input: unknown,
  now: number
): RestoreInventoryStartInput {
  if (!db.isTransaction) throw Error('ledger_restore_inventory_attempt_transaction_required')
  Hash.parse(sourceKey)
  const request = RestoreInventoryStartSchema.parse(input)
  bound(db, request)
  const old = readRestoreInventoryAttempt(db, sourceKey, now)
  if (old) {
    if (hashContext(old) !== hashContext(request))
      throw Error('ledger_restore_inventory_attempt_conflict')
    return old
  }
  db.exec(`CREATE TABLE IF NOT EXISTS ledger_restore_inventory_attempts(request_id TEXT PRIMARY KEY,source_key TEXT NOT NULL,request_hash TEXT NOT NULL,request_json TEXT NOT NULL,created_at INTEGER NOT NULL) STRICT;
    CREATE INDEX IF NOT EXISTS ledger_restore_inventory_attempt_source ON ledger_restore_inventory_attempts(source_key,created_at);
    CREATE TRIGGER IF NOT EXISTS ledger_restore_inventory_attempt_no_update BEFORE UPDATE ON ledger_restore_inventory_attempts BEGIN SELECT RAISE(ABORT,'ledger_restore_inventory_attempt_immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ledger_restore_inventory_attempt_no_delete BEFORE DELETE ON ledger_restore_inventory_attempts BEGIN SELECT RAISE(ABORT,'ledger_restore_inventory_attempt_immutable'); END;`)
  db.prepare('INSERT INTO ledger_restore_inventory_attempts VALUES(?,?,?,?,?)').run(
    request.requestId,
    sourceKey,
    hashContext(request),
    JSON.stringify(request),
    now
  )
  return request
}
