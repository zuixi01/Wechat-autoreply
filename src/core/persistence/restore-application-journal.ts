import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { DeviceScopeSchema, type DeviceScope } from '../../shared/contracts/registration'
import {
  RestoreApplicationDecisionSchema,
  RestoreLocalApplicationReceiptSchema,
  RestoreApplicationAckSchema,
  type RestoreApplicationAck,
  type RestoreLocalApplicationReceipt,
  type RestoreApplicationDecision
} from '../../shared/contracts/restore-application'
import { readLedgerRestoreContext } from './ledger-restoration'
import { readLedgerRestoreInventory, type LedgerRestoreInventory } from './restore-inventory'
import { hashContext } from '../reply/hashes'

function conflict(): never {
  throw new Error('restore_application_conflict')
}
function initialize(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS ledger_restore_applications (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, application_id TEXT NOT NULL UNIQUE,
    restore_id TEXT NOT NULL, scope_hash TEXT NOT NULL, decision_id TEXT NOT NULL,
    request_hash TEXT NOT NULL, request_json TEXT NOT NULL,
    receipt_hash TEXT NOT NULL, receipt_json TEXT NOT NULL, applied_at INTEGER NOT NULL,
    UNIQUE(restore_id,scope_hash,decision_id)
  ) STRICT;
  CREATE TRIGGER IF NOT EXISTS ledger_restore_applications_no_update BEFORE UPDATE ON ledger_restore_applications BEGIN SELECT RAISE(ABORT,'restore_application_immutable'); END;
  CREATE TRIGGER IF NOT EXISTS ledger_restore_applications_no_delete BEFORE DELETE ON ledger_restore_applications BEGIN SELECT RAISE(ABORT,'restore_application_immutable'); END;`)
  if (
    db
      .prepare('PRAGMA table_info(ledger_restore_applications)')
      .all()
      .map((row) => row.name)
      .join(',') !==
    'sequence,application_id,restore_id,scope_hash,decision_id,request_hash,request_json,receipt_hash,receipt_json,applied_at'
  )
    conflict()
}
function bound(
  request: RestoreApplicationDecision,
  receipt: RestoreLocalApplicationReceipt
): boolean {
  const d = request.decision
  return (
    receipt.caseId === d.caseId &&
    receipt.uploadId === d.uploadId &&
    receipt.decisionId === d.decisionId &&
    receipt.decisionHash === request.decisionHash &&
    receipt.restoreId === d.restoreId &&
    receipt.contextHash === d.contextHash &&
    receipt.inventoryBasisHash === request.manifest.basisHash &&
    hashContext(receipt.scope) === hashContext(request.scope)
  )
}
function saved(
  db: DatabaseSync,
  input: RestoreApplicationDecision
): RestoreLocalApplicationReceipt | null {
  let found: RestoreLocalApplicationReceipt | null = null,
    sequence = 0
  const rows =
    db.prepare(`SELECT sequence,application_id,restore_id,scope_hash,decision_id,request_hash,receipt_hash,applied_at,CASE WHEN length(CAST(request_json AS BLOB))<=65536 THEN request_json END AS bounded_request,
    CASE WHEN length(CAST(receipt_json AS BLOB))<=65536 THEN receipt_json END AS bounded_receipt FROM ledger_restore_applications ORDER BY sequence`)
  for (const row of rows.iterate()) {
    if (
      ++sequence > 10000 ||
      Number(row.sequence) !== sequence ||
      typeof row.bounded_request !== 'string' ||
      typeof row.bounded_receipt !== 'string'
    )
      conflict()
    const request = RestoreApplicationDecisionSchema.parse(JSON.parse(row.bounded_request)),
      receipt = RestoreLocalApplicationReceiptSchema.parse(JSON.parse(row.bounded_receipt))
    if (
      row.request_hash !== hashContext(request) ||
      row.receipt_hash !== hashContext(receipt) ||
      !bound(request, receipt) ||
      row.application_id !== receipt.applicationId ||
      row.restore_id !== receipt.restoreId ||
      row.scope_hash !== hashContext(receipt.scope) ||
      row.decision_id !== receipt.decisionId ||
      Number(row.applied_at) !== receipt.appliedAt
    )
      conflict()
    if (
      receipt.restoreId === input.decision.restoreId &&
      row.scope_hash === hashContext(input.scope) &&
      receipt.decisionId === input.decision.decisionId
    ) {
      if (found || row.request_hash !== hashContext(input)) conflict()
      found = receipt
    }
  }
  return found
}
function durableApplication(db: DatabaseSync, raw: unknown): RestoreLocalApplicationReceipt {
  const receipt = RestoreLocalApplicationReceiptSchema.parse(raw)
  const context = readLedgerRestoreContext(db)
  if (
    !context ||
    context.restoreId !== receipt.restoreId ||
    context.contextHash !== receipt.contextHash
  )
    conflict()
  const row = db
    .prepare(
      'SELECT CASE WHEN length(CAST(request_json AS BLOB))<=65536 THEN request_json END AS request FROM ledger_restore_applications WHERE application_id=?'
    )
    .get(receipt.applicationId)
  if (typeof row?.request !== 'string') conflict()
  const value = saved(db, RestoreApplicationDecisionSchema.parse(JSON.parse(row.request)))
  if (!value || hashContext(value) !== hashContext(receipt)) conflict()
  return value
}
function ackBound(receipt: RestoreLocalApplicationReceipt, ack: RestoreApplicationAck): boolean {
  return (
    ack.applicationId === receipt.applicationId &&
    ack.applicationHash === hashContext(receipt) &&
    ack.caseId === receipt.caseId &&
    ack.decisionId === receipt.decisionId &&
    ack.restoreId === receipt.restoreId &&
    ack.contextHash === receipt.contextHash &&
    hashContext(ack.scope) === hashContext(receipt.scope)
  )
}
function acknowledgements(db: DatabaseSync): RestoreApplicationAck[] {
  if (
    !db
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='ledger_restore_application_acks'"
      )
      .get()
  )
    return []
  const acks: RestoreApplicationAck[] = []
  let sequence = 0
  for (const row of db
    .prepare(
      'SELECT sequence,application_id,ack_hash,CASE WHEN length(CAST(ack_json AS BLOB))<=65536 THEN ack_json END AS ack_json FROM ledger_restore_application_acks ORDER BY sequence'
    )
    .iterate()) {
    if (++sequence > 10000 || Number(row.sequence) !== sequence || typeof row.ack_json !== 'string')
      conflict()
    const ack = RestoreApplicationAckSchema.parse(JSON.parse(row.ack_json))
    if (row.ack_hash !== hashContext(ack) || row.application_id !== ack.applicationId) conflict()
    const application = db
      .prepare(
        'SELECT CASE WHEN length(CAST(receipt_json AS BLOB))<=65536 THEN receipt_json END AS receipt FROM ledger_restore_applications WHERE application_id=?'
      )
      .get(ack.applicationId)
    if (typeof application?.receipt !== 'string') conflict()
    const receipt = RestoreLocalApplicationReceiptSchema.parse(JSON.parse(application.receipt))
    const request = db
      .prepare(
        'SELECT CASE WHEN length(CAST(request_json AS BLOB))<=65536 THEN request_json END AS request FROM ledger_restore_applications WHERE application_id=?'
      )
      .get(ack.applicationId)
    if (
      typeof request?.request !== 'string' ||
      hashContext(
        saved(db, RestoreApplicationDecisionSchema.parse(JSON.parse(request.request)))
      ) !== hashContext(receipt) ||
      !ackBound(receipt, ack)
    )
      conflict()
    acks.push(ack)
  }
  return acks
}
export function hasRestoreApplicationAck(db: DatabaseSync, rawScope: unknown): boolean {
  const scope = DeviceScopeSchema.parse(rawScope),
    context = readLedgerRestoreContext(db)
  const acks = acknowledgements(db)
  return (
    !!context &&
    acks.some(
      (ack) =>
        ack.restoreId === context.restoreId &&
        ack.contextHash === context.contextHash &&
        hashContext(ack.scope) === hashContext(scope)
    )
  )
}
export function saveRestoreApplicationAck(
  db: DatabaseSync,
  rawReceipt: unknown,
  rawAck: unknown
): RestoreApplicationAck {
  const receipt = durableApplication(db, rawReceipt),
    ack = RestoreApplicationAckSchema.parse(rawAck)
  if (!ackBound(receipt, ack)) conflict()
  const old = acknowledgements(db).find((value) => value.applicationId === receipt.applicationId)
  if (old) {
    if (hashContext(old) !== hashContext(ack)) conflict()
    return old
  }
  db.exec(`CREATE TABLE IF NOT EXISTS ledger_restore_application_acks(sequence INTEGER PRIMARY KEY AUTOINCREMENT,application_id TEXT NOT NULL UNIQUE,ack_hash TEXT NOT NULL,ack_json TEXT NOT NULL) STRICT;
    CREATE TRIGGER IF NOT EXISTS ledger_restore_application_acks_no_update BEFORE UPDATE ON ledger_restore_application_acks BEGIN SELECT RAISE(ABORT,'restore_application_ack_immutable'); END;
    CREATE TRIGGER IF NOT EXISTS ledger_restore_application_acks_no_delete BEFORE DELETE ON ledger_restore_application_acks BEGIN SELECT RAISE(ABORT,'restore_application_ack_immutable'); END;`)
  if (
    db
      .prepare('PRAGMA table_info(ledger_restore_application_acks)')
      .all()
      .map((row) => row.name)
      .join(',') !== 'sequence,application_id,ack_hash,ack_json'
  )
    conflict()
  db.prepare(
    'INSERT INTO ledger_restore_application_acks(application_id,ack_hash,ack_json) VALUES(?,?,?)'
  ).run(ack.applicationId, hashContext(ack), JSON.stringify(ack))
  acknowledgements(db)
  return ack
}
function manifest(report: LedgerRestoreInventory): RestoreApplicationDecision['manifest'] {
  return {
    formatVersion: report.formatVersion,
    evidenceKind: report.evidenceKind,
    context: report.context,
    scope: report.scope,
    summary: report.summary,
    basisHash: report.basisHash,
    canRelease: report.canRelease,
    externalEvidenceRequired: report.externalEvidenceRequired
  }
}
/** Caller holds BEGIN IMMEDIATE. This operation cannot clear provenance or authorize sending. */
export function applyRestoreApplication(
  db: DatabaseSync,
  rawScope: unknown,
  raw: unknown,
  now: number
): RestoreLocalApplicationReceipt {
  if (!db.isTransaction || !Number.isSafeInteger(now) || now < 0) conflict()
  const scope: DeviceScope = DeviceScopeSchema.parse(rawScope),
    input = RestoreApplicationDecisionSchema.parse(raw)
  const context = readLedgerRestoreContext(db)
  if (
    !context ||
    context.restoreId.toLowerCase() !== input.decision.restoreId ||
    context.contextHash !== input.decision.contextHash ||
    hashContext(scope) !== hashContext(input.scope) ||
    hashContext(context) !== hashContext(input.manifest.context)
  )
    conflict()
  initialize(db)
  const old = saved(db, input)
  if (old) return old
  const conversations = new Map<string, string>(),
    controls = new Set<string>()
  const source = readLedgerRestoreInventory(db, scope, {}, (item) => {
    const key = hashContext({ identity: item.identity, conversationId: item.conversationId })
    const control = hashContext({
      tenantId: item.identity.tenantId,
      accountId: item.identity.accountId,
      platform: item.identity.platform,
      conversationId: item.conversationId
    })
    conversations.set(key, control)
    controls.add(control)
  })
  if (hashContext(manifest(source)) !== hashContext(input.manifest)) conflict()
  const applicationId = randomUUID()
  let quarantined = 0
  for (const key of conversations.keys()) {
    const result = db
      .prepare(
        `UPDATE messages SET handled_execution=? WHERE scope=? AND handled_execution IS NULL AND json_extract(payload,'$.direction')='inbound'`
      )
      .run(`restore:${applicationId}`, key)
    quarantined += Number(result.changes)
    db.prepare('UPDATE conversations SET human_owned=1,revision=revision+1 WHERE scope=?').run(key)
  }
  for (const control of controls) {
    db.prepare(
      'INSERT OR IGNORE INTO conversation_controls(delivery_scope,human_owned,revision) VALUES(?,0,0)'
    ).run(control)
    db.prepare(
      'UPDATE conversation_controls SET human_owned=1,revision=revision+1 WHERE delivery_scope=? AND human_owned<>1'
    ).run(control)
  }
  const post = readLedgerRestoreInventory(db, scope, {}, () => {})
  const value = RestoreLocalApplicationReceiptSchema.parse({
    applicationId,
    scope,
    caseId: input.decision.caseId,
    uploadId: input.decision.uploadId,
    decisionId: input.decision.decisionId,
    decisionHash: input.decisionHash,
    restoreId: input.decision.restoreId,
    contextHash: input.decision.contextHash,
    inventoryBasisHash: input.manifest.basisHash,
    postInventoryBasisHash: post.basisHash,
    quarantinedInboundCount: quarantined,
    ownedConversationCount: controls.size,
    appliedAt: now,
    centralConfirmationRequired: true,
    canRelease: false
  })
  db.prepare(
    `INSERT INTO ledger_restore_applications(application_id,restore_id,scope_hash,decision_id,request_hash,request_json,receipt_hash,receipt_json,applied_at)
    VALUES(?,?,?,?,?,?,?,?,?)`
  ).run(
    applicationId,
    value.restoreId,
    hashContext(scope),
    value.decisionId,
    hashContext(input),
    JSON.stringify(input),
    hashContext(value),
    JSON.stringify(value),
    now
  )
  if (saved(db, input)?.applicationId !== applicationId) conflict()
  return value
}
