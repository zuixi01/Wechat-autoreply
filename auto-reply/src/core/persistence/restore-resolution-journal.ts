import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { hashContext } from '../reply/hashes'
import { DeviceScopeSchema } from '../../shared/contracts/registration'
import {
  RestoreRecoveryPackageSchema,
  type RestoreRecoveryPackage
} from '../../shared/contracts/restore-recovery'
import {
  parseRestoreResolutionPackage,
  RestoreResolutionLocalReceiptSchema,
  type RestoreResolutionLocalReceipt
} from '../../shared/contracts/restore-resolution'
import { readRestoreRecoveryApplication } from './restore-recovery-journal'
import { readLedgerRestoreContext } from './ledger-restoration'
import { readLedgerRestoreInventory } from './restore-inventory'
import { PermitRequestSchema } from '../../shared/contracts/execution'

function conflict(): never {
  throw Error('restore_resolution_application_conflict')
}
function initialize(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS ledger_restore_resolution_applications (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, application_id TEXT NOT NULL UNIQUE,
    authorization_id TEXT NOT NULL UNIQUE, boundary_application_id TEXT NOT NULL,
    request_hash TEXT NOT NULL, request_json TEXT NOT NULL,
    receipt_hash TEXT NOT NULL, receipt_json TEXT NOT NULL, applied_at INTEGER NOT NULL
  ) STRICT;
  CREATE TRIGGER IF NOT EXISTS ledger_restore_resolution_applications_no_update BEFORE UPDATE ON ledger_restore_resolution_applications BEGIN SELECT RAISE(ABORT,'restore_resolution_application_immutable'); END;
  CREATE TRIGGER IF NOT EXISTS ledger_restore_resolution_applications_no_delete BEFORE DELETE ON ledger_restore_resolution_applications BEGIN SELECT RAISE(ABORT,'restore_resolution_application_immutable'); END;`)
  if (
    db
      .prepare('PRAGMA table_info(ledger_restore_resolution_applications)')
      .all()
      .map((r) => r.name)
      .join(',') !==
    'sequence,application_id,authorization_id,boundary_application_id,request_hash,request_json,receipt_hash,receipt_json,applied_at'
  )
    conflict()
}
function boundary(db: DatabaseSync, id: string): RestoreRecoveryPackage {
  if (!readRestoreRecoveryApplication(db, id)) conflict()
  const r = db
    .prepare(
      `SELECT CASE WHEN length(CAST(request_json AS BLOB))<=2097152 THEN request_json END AS request_json
    FROM ledger_restore_recovery_applications WHERE authorization_id=?`
    )
    .get(id)
  if (typeof r?.request_json !== 'string') conflict()
  return RestoreRecoveryPackageSchema.parse(JSON.parse(r.request_json))
}
/** Original independent resolution evidence; does not alter physical sends, dispatch
 * baselines, central attempts, message handling or reconciliation acknowledgments. */
export function readRestoreResolutionApplication(
  db: DatabaseSync,
  id: string
): RestoreResolutionLocalReceipt | null {
  if (
    !db
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='ledger_restore_resolution_applications'"
      )
      .get()
  )
    return null
  let sequence = 0,
    result: RestoreResolutionLocalReceipt | null = null
  for (const row of db
    .prepare(
      `SELECT sequence,application_id,authorization_id,boundary_application_id,request_hash,receipt_hash,applied_at,
    CASE WHEN length(CAST(request_json AS BLOB))<=2097152 THEN request_json END AS request_json,
    CASE WHEN length(CAST(receipt_json AS BLOB))<=16384 THEN receipt_json END AS receipt_json
    FROM ledger_restore_resolution_applications ORDER BY sequence`
    )
    .iterate()) {
    if (
      ++sequence > 10000 ||
      Number(row.sequence) !== sequence ||
      typeof row.authorization_id !== 'string' ||
      typeof row.request_json !== 'string' ||
      typeof row.receipt_json !== 'string'
    )
      conflict()
    const b = boundary(db, row.authorization_id),
      a = b.authorization,
      p = parseRestoreResolutionPackage(JSON.parse(row.request_json), b),
      r = RestoreResolutionLocalReceiptSchema.parse(JSON.parse(row.receipt_json)),
      applied = readRestoreRecoveryApplication(db, a.authorizationId)!
    if (
      row.application_id !== r.applicationId ||
      row.authorization_id !== r.authorizationId ||
      row.boundary_application_id !== r.boundaryApplicationId ||
      r.boundaryApplicationId !== applied.applicationId ||
      row.request_hash !== hashContext(p) ||
      r.packageHash !== row.request_hash ||
      row.receipt_hash !== hashContext(r) ||
      Number(row.applied_at) !== r.appliedAt ||
      r.authorizationHash !== hashContext(a) ||
      r.boundaryHash !== a.boundaryHash ||
      r.resolutionBasisHash !== a.resolutionBasisHash ||
      r.restoreId !== a.restoreId ||
      r.contextHash !== a.contextHash ||
      r.localExecutions !== p.localExecutions.length ||
      r.centralPermits !== p.subjects.filter((s) => s.kind === 'central_permit').length ||
      r.requestSeals !== p.records.filter((v) => v.kind === 'request_seal').length ||
      r.appliedAt < applied.appliedAt ||
      r.appliedAt < a.recordedAt ||
      r.appliedAt >= a.expiresAt
    )
      conflict()
    if (r.authorizationId === id) {
      if (result) conflict()
      result = r
    }
  }
  return result
}
export function applyRestoreExecutionResolutions(
  db: DatabaseSync,
  rawScope: unknown,
  raw: unknown,
  now: number
): RestoreResolutionLocalReceipt {
  if (
    !db.isTransaction ||
    !Number.isSafeInteger(now) ||
    now < 0 ||
    Buffer.byteLength(JSON.stringify(raw) ?? '') > 2097152
  )
    conflict()
  const authorizationId = (raw as { authorizationId?: unknown })?.authorizationId
  if (typeof authorizationId !== 'string') conflict()
  const scope = DeviceScopeSchema.parse(rawScope),
    b = boundary(db, authorizationId),
    a = b.authorization,
    context = readLedgerRestoreContext(db),
    p = parseRestoreResolutionPackage(raw, b),
    applied = readRestoreRecoveryApplication(db, authorizationId)!
  if (
    !context ||
    hashContext(context) !== hashContext(b.boundary.manifest.context) ||
    hashContext(scope) !== hashContext(a.scope)
  )
    conflict()
  initialize(db)
  const old = readRestoreResolutionApplication(db, authorizationId)
  if (old) {
    if (old.packageHash !== hashContext(p)) conflict()
    return old
  }
  if (now < a.recordedAt || now < applied.appliedAt || now >= a.expiresAt) conflict()
  const expected = new Map(
    p.localExecutions.map((v) => {
      if (v.kind !== 'execution') conflict()
      return [v.executionId, v] as const
    })
  )
  const immutable = (
    item: (typeof p.localExecutions)[number]
  ): Omit<
    Extract<(typeof p.localExecutions)[number], { kind: 'execution' }>,
    'conversation' | 'controlHash'
  > => {
    if (item.kind !== 'execution') conflict()
    // Boundary application changes conversation ownership/revision only. All
    // original execution fields, range presence, status and causal baselines match.
    const { conversation: _conversation, controlHash: _control, ...rest } = item
    void _conversation
    void _control
    return rest
  }
  const subjects = new Map(p.subjects.map((s) => [s.subjectKey, s])),
    permits = new Map(
      p.records.filter((r) => r.kind !== 'request_seal').map((r) => [r.fact.permitId, r])
    )
  let covered = 0
  readLedgerRestoreInventory(db, scope, {}, (item) => {
    if (item.kind !== 'execution') return
    const original = expected.get(item.executionId)
    if (!original || hashContext(immutable(item)) !== hashContext(immutable(original))) conflict()
    const subject = subjects.get(`l:${item.key}`)
    if (!subject) conflict()
    if (subject.executionGroup.startsWith('permit:') && item.requestHash !== null) {
      const record = permits.get(subject.executionGroup.slice(7)),
        row = db
          .prepare('SELECT request_json FROM central_attempts WHERE execution_id=?')
          .get(item.executionId)
      if (
        !record ||
        typeof row?.request_json !== 'string' ||
        Buffer.byteLength(row.request_json) > 16384
      )
        conflict()
      const request = PermitRequestSchema.parse(JSON.parse(row.request_json)),
        permit = record.kind === 'reconciled' ? record.challenge.permit : record.permit
      if (
        hashContext(request) !== item.requestHash ||
        permit.taskId !== request.taskId ||
        permit.taskHash !== request.taskHash ||
        permit.draftHash !== request.draftHash ||
        permit.draftRevision !== request.draftRevision ||
        permit.leaseVersion !== request.leaseVersion ||
        permit.identity.loginEpoch !== request.loginEpoch ||
        permit.identity.clientInstanceId !== request.clientInstanceId ||
        (permit.purpose ?? 'automatic') !== (request.purpose ?? 'automatic') ||
        permit.confirmationId !== request.confirmationId
      )
        conflict()
    }
    covered++
  })
  if (covered !== expected.size) conflict()
  const r = RestoreResolutionLocalReceiptSchema.parse({
    formatVersion: 1,
    applicationId: randomUUID(),
    boundaryApplicationId: applied.applicationId,
    authorizationId: a.authorizationId,
    authorizationHash: hashContext(a),
    boundaryHash: a.boundaryHash,
    resolutionBasisHash: a.resolutionBasisHash,
    packageHash: hashContext(p),
    restoreId: a.restoreId,
    contextHash: a.contextHash,
    localExecutions: covered,
    centralPermits: p.subjects.filter((s) => s.kind === 'central_permit').length,
    requestSeals: p.records.filter((v) => v.kind === 'request_seal').length,
    appliedAt: now,
    originalExecutionRecordsPreserved: true,
    centralConfirmationRequired: true,
    automaticStart: false,
    canRelease: false
  })
  db.prepare(
    `INSERT INTO ledger_restore_resolution_applications(application_id,authorization_id,boundary_application_id,request_hash,request_json,receipt_hash,receipt_json,applied_at)
    VALUES(?,?,?,?,?,?,?,?)`
  ).run(
    r.applicationId,
    r.authorizationId,
    r.boundaryApplicationId,
    r.packageHash,
    JSON.stringify(p),
    hashContext(r),
    JSON.stringify(r),
    now
  )
  if (hashContext(readRestoreResolutionApplication(db, authorizationId)) !== hashContext(r))
    conflict()
  return r
}
