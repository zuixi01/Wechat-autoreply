import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { DeviceScopeSchema, type DeviceScope } from '../../shared/contracts/registration'
import { RestoreRecoveryPackageSchema } from '../../shared/contracts/restore-recovery'
import { parseRestoreResolutionPackage } from '../../shared/contracts/restore-resolution'
import {
  RestoreRecoveryCompletionInputSchema,
  parseRestoreRecoveryCompletionInput,
  parseRestoreRecoveryCompletionReceipt,
  type RestoreRecoveryCompletionInput,
  type RestoreRecoveryCompletionReceipt
} from '../../shared/contracts/restore-completion'
import type { RestoreObservationGrant } from '../../shared/contracts/restore-observation'
import { LedgerRestoreContextSchema } from '../../shared/contracts/restoration'
import { readRestoreRecoveryApplication } from './restore-recovery-journal'
import { readRestoreResolutionApplication } from './restore-resolution-journal'
import { readLedgerRestoreContext } from './ledger-restoration'
import { readLedgerRestoreInventory } from './restore-inventory'
import { hashContext } from '../reply/hashes'
function conflict(): never {
  throw Error('restore_completion_journal_conflict')
}
function exists(db: DatabaseSync): boolean {
  return Boolean(
    db
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='ledger_restore_completion_intents'"
      )
      .get()
  )
}
function originals(
  db: DatabaseSync,
  id: string
): {
  p: ReturnType<typeof RestoreRecoveryPackageSchema.parse>
  resolutions: ReturnType<typeof parseRestoreResolutionPackage>
} {
  if (!readRestoreRecoveryApplication(db, id) || !readRestoreResolutionApplication(db, id))
    conflict()
  const b = db
      .prepare(
        'SELECT request_json FROM ledger_restore_recovery_applications WHERE authorization_id=?'
      )
      .get(id),
    r = db
      .prepare(
        'SELECT request_json FROM ledger_restore_resolution_applications WHERE authorization_id=?'
      )
      .get(id)
  if (
    typeof b?.request_json !== 'string' ||
    typeof r?.request_json !== 'string' ||
    Buffer.byteLength(b.request_json) > 2097152 ||
    Buffer.byteLength(r.request_json) > 2097152
  )
    conflict()
  const p = RestoreRecoveryPackageSchema.parse(JSON.parse(b.request_json))
  return { p, resolutions: parseRestoreResolutionPackage(JSON.parse(r.request_json), p) }
}
function validate(
  db: DatabaseSync,
  row: Record<string, unknown>,
  scope: DeviceScope
): RestoreRecoveryCompletionInput {
  if (typeof row.request_json !== 'string' || Buffer.byteLength(row.request_json) > 1048576)
    conflict()
  const input = RestoreRecoveryCompletionInputSchema.parse(JSON.parse(row.request_json)),
    b = input.boundaryApplication,
    context = readLedgerRestoreContext(db),
    { p, resolutions } = originals(db, b.authorizationId)
  parseRestoreRecoveryCompletionInput(input, p, resolutions)
  if (
    !context ||
    b.restoreId !== context.restoreId.toLowerCase() ||
    b.contextHash !== context.contextHash ||
    row.completion_id !== input.completionId ||
    row.authorization_id !== b.authorizationId ||
    row.restore_id !== b.restoreId ||
    row.scope_hash !== hashContext(scope) ||
    hashContext(b.scope) !== hashContext(scope) ||
    row.request_hash !== hashContext(input) ||
    hashContext(readRestoreRecoveryApplication(db, b.authorizationId)) !== hashContext(b) ||
    hashContext(readRestoreResolutionApplication(db, b.authorizationId)) !==
      hashContext(input.resolutionApplication)
  )
    conflict()
  return input
}
function initialize(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS ledger_restore_completion_intents (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,completion_id TEXT NOT NULL UNIQUE,authorization_id TEXT NOT NULL UNIQUE,
    restore_id TEXT NOT NULL,scope_hash TEXT NOT NULL,request_hash TEXT NOT NULL,request_json TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS ledger_restore_completion_acks (
    completion_id TEXT PRIMARY KEY REFERENCES ledger_restore_completion_intents(completion_id),receipt_hash TEXT NOT NULL,receipt_json TEXT NOT NULL
  ) STRICT;
  CREATE TRIGGER IF NOT EXISTS ledger_restore_completion_intents_no_update BEFORE UPDATE ON ledger_restore_completion_intents BEGIN SELECT RAISE(ABORT,'restore_completion_immutable'); END;
  CREATE TRIGGER IF NOT EXISTS ledger_restore_completion_intents_no_delete BEFORE DELETE ON ledger_restore_completion_intents BEGIN SELECT RAISE(ABORT,'restore_completion_immutable'); END;
  CREATE TRIGGER IF NOT EXISTS ledger_restore_completion_acks_no_update BEFORE UPDATE ON ledger_restore_completion_acks BEGIN SELECT RAISE(ABORT,'restore_completion_immutable'); END;
  CREATE TRIGGER IF NOT EXISTS ledger_restore_completion_acks_no_delete BEFORE DELETE ON ledger_restore_completion_acks BEGIN SELECT RAISE(ABORT,'restore_completion_immutable'); END;`)
}
export function readRestoreCompletionIntent(
  db: DatabaseSync,
  rawScope: unknown
): RestoreRecoveryCompletionInput | null {
  const scope = DeviceScopeSchema.parse(rawScope),
    context = readLedgerRestoreContext(db)
  if (!context || !exists(db)) return null
  const row = db
    .prepare(
      'SELECT * FROM ledger_restore_completion_intents WHERE restore_id=? AND scope_hash=? ORDER BY sequence DESC LIMIT 1'
    )
    .get(context.restoreId.toLowerCase(), hashContext(scope))
  return row ? validate(db, row, scope) : null
}
/** Durable intent precedes HTTP; a lost response reuses every original byte and ID. */
export function prepareRestoreCompletionIntent(
  db: DatabaseSync,
  rawScope: unknown,
  id: string,
  grant: RestoreObservationGrant,
  now: number
): RestoreRecoveryCompletionInput {
  if (!db.isTransaction || !Number.isSafeInteger(now)) conflict()
  const scope = DeviceScopeSchema.parse(rawScope),
    { p, resolutions } = originals(db, id),
    context = readLedgerRestoreContext(db),
    b = readRestoreRecoveryApplication(db, id)!,
    r = readRestoreResolutionApplication(db, id)!
  if (
    !context ||
    b.restoreId !== context.restoreId.toLowerCase() ||
    b.contextHash !== context.contextHash ||
    hashContext(b.scope) !== hashContext(scope)
  )
    conflict()
  initialize(db)
  const old = db
    .prepare('SELECT * FROM ledger_restore_completion_intents WHERE authorization_id=?')
    .get(id)
  if (old) return validate(db, old, scope)
  const provenance = db
    .prepare('SELECT context_json FROM ledger_restore_journal ORDER BY sequence')
    .all()
    .map((row) => LedgerRestoreContextSchema.parse(JSON.parse(String(row.context_json))))
  const input = parseRestoreRecoveryCompletionInput(
    {
      formatVersion: 1,
      completionId: randomUUID(),
      preparedAt: now,
      boundaryApplication: b,
      resolutionApplication: r,
      observationGrant: grant,
      provenance,
      automaticStart: false,
      canRelease: false
    },
    p,
    resolutions
  )
  if (readLedgerRestoreInventory(db, scope, {}, () => {}).basisHash !== b.postInventoryBasisHash)
    conflict()
  const savedGrant = db
    .prepare('SELECT grant_hash FROM ledger_restore_observation_grants WHERE grant_id=?')
    .get(grant.grantId)
  if (savedGrant?.grant_hash !== hashContext(grant)) conflict()
  db.prepare(
    'INSERT INTO ledger_restore_completion_intents(completion_id,authorization_id,restore_id,scope_hash,request_hash,request_json) VALUES(?,?,?,?,?,?)'
  ).run(
    input.completionId,
    id,
    b.restoreId,
    hashContext(scope),
    hashContext(input),
    JSON.stringify(input)
  )
  return input
}
export function readRestoreCompletionAck(
  db: DatabaseSync,
  rawScope: unknown
): RestoreRecoveryCompletionReceipt | null {
  const input = readRestoreCompletionIntent(db, rawScope)
  if (!input) return null
  const row = db
    .prepare('SELECT * FROM ledger_restore_completion_acks WHERE completion_id=?')
    .get(input.completionId)
  if (!row) return null
  if (typeof row.receipt_json !== 'string' || Buffer.byteLength(row.receipt_json) > 16384)
    conflict()
  const ack = parseRestoreRecoveryCompletionReceipt(JSON.parse(row.receipt_json), input)
  if (row.receipt_hash !== hashContext(ack)) conflict()
  return ack
}
export function saveRestoreCompletionAck(
  db: DatabaseSync,
  rawScope: unknown,
  raw: unknown
): RestoreRecoveryCompletionReceipt {
  if (!db.isTransaction) conflict()
  const scope = DeviceScopeSchema.parse(rawScope),
    input = readRestoreCompletionIntent(db, scope)
  if (!input) conflict()
  const ack = parseRestoreRecoveryCompletionReceipt(raw, input),
    old = readRestoreCompletionAck(db, scope)
  if (old) {
    if (hashContext(old) !== hashContext(ack)) conflict()
    return old
  }
  if (
    readLedgerRestoreInventory(db, scope, {}, () => {}).basisHash !==
    input.boundaryApplication.postInventoryBasisHash
  )
    conflict()
  db.prepare('INSERT INTO ledger_restore_completion_acks VALUES(?,?,?)').run(
    input.completionId,
    hashContext(ack),
    JSON.stringify(ack)
  )
  return ack
}
