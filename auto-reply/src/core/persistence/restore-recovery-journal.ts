import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { DeviceScopeSchema } from '../../shared/contracts/registration'
import {
  RestoreRecoveryPackageSchema,
  RestoreRecoveryLocalReceiptSchema,
  type RestoreRecoveryPackage,
  type RestoreRecoveryLocalReceipt
} from '../../shared/contracts/restore-recovery'
import { readLedgerRestoreContext } from './ledger-restoration'
import { readLedgerRestoreInventory } from './restore-inventory'
import { hashContext } from '../reply/hashes'

function conflict(): never {
  throw new Error('restore_recovery_application_conflict')
}
function initialize(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS ledger_restore_recovery_applications (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, application_id TEXT NOT NULL UNIQUE,
    authorization_id TEXT NOT NULL UNIQUE, restore_id TEXT NOT NULL, scope_hash TEXT NOT NULL,
    request_hash TEXT NOT NULL, request_json TEXT NOT NULL,
    receipt_hash TEXT NOT NULL, receipt_json TEXT NOT NULL, applied_at INTEGER NOT NULL
  ) STRICT;
  CREATE TRIGGER IF NOT EXISTS ledger_restore_recovery_applications_no_update BEFORE UPDATE ON ledger_restore_recovery_applications BEGIN SELECT RAISE(ABORT,'restore_recovery_application_immutable'); END;
  CREATE TRIGGER IF NOT EXISTS ledger_restore_recovery_applications_no_delete BEFORE DELETE ON ledger_restore_recovery_applications BEGIN SELECT RAISE(ABORT,'restore_recovery_application_immutable'); END;`)
  if (
    db
      .prepare('PRAGMA table_info(ledger_restore_recovery_applications)')
      .all()
      .map((r) => r.name)
      .join(',') !==
    'sequence,application_id,authorization_id,restore_id,scope_hash,request_hash,request_json,receipt_hash,receipt_json,applied_at'
  )
    conflict()
}
function parse(raw: unknown): RestoreRecoveryPackage {
  if (Buffer.byteLength(JSON.stringify(raw) ?? '') > 2097152) conflict()
  return RestoreRecoveryPackageSchema.parse(raw)
}
function bound(p: RestoreRecoveryPackage, r: RestoreRecoveryLocalReceipt): boolean {
  const a = p.authorization
  return (
    r.authorizationId === a.authorizationId &&
    r.authorizationHash === hashContext(a) &&
    r.boundaryHash === a.boundaryHash &&
    r.caseId === a.caseId &&
    r.uploadId === a.uploadId &&
    r.restoreId === a.restoreId &&
    r.contextHash === a.contextHash &&
    r.inventoryBasisHash === a.inventoryBasisHash &&
    hashContext(r.scope) === hashContext(a.scope) &&
    r.appliedAt >= a.recordedAt &&
    r.appliedAt < a.expiresAt &&
    r.ownedConversationCount === p.boundary.history.conversations.length &&
    r.sourceMessageCount ===
      p.boundary.history.conversations.reduce((n, c) => n + c.messages.length, 0)
  )
}
/** A durable audit record only. It does not assert local reconciliation or release. */
export function readRestoreRecoveryApplication(
  db: DatabaseSync,
  authorizationId: string
): RestoreRecoveryLocalReceipt | null {
  if (
    !db
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='ledger_restore_recovery_applications'"
      )
      .get()
  )
    return null
  let sequence = 0,
    result: RestoreRecoveryLocalReceipt | null = null
  for (const row of db
    .prepare(
      `SELECT sequence,application_id,authorization_id,restore_id,scope_hash,request_hash,receipt_hash,applied_at,
    CASE WHEN length(CAST(request_json AS BLOB))<=2097152 THEN request_json END AS request_json,
    CASE WHEN length(CAST(receipt_json AS BLOB))<=16384 THEN receipt_json END AS receipt_json
    FROM ledger_restore_recovery_applications ORDER BY sequence`
    )
    .iterate()) {
    if (
      ++sequence > 10000 ||
      Number(row.sequence) !== sequence ||
      typeof row.request_json !== 'string' ||
      typeof row.receipt_json !== 'string'
    )
      conflict()
    const p = parse(JSON.parse(row.request_json)),
      r = RestoreRecoveryLocalReceiptSchema.parse(JSON.parse(row.receipt_json))
    if (
      !bound(p, r) ||
      hashContext(p) !== row.request_hash ||
      hashContext(r) !== row.receipt_hash ||
      row.application_id !== r.applicationId ||
      row.authorization_id !== r.authorizationId ||
      row.restore_id !== r.restoreId ||
      row.scope_hash !== hashContext(r.scope) ||
      Number(row.applied_at) !== r.appliedAt
    )
      conflict()
    if (r.authorizationId === authorizationId) {
      if (result) conflict()
      result = r
    }
  }
  return result
}
/** Caller holds BEGIN IMMEDIATE and has fetched this package for its authenticated target. */
export function applyRestoreRecoveryBoundary(
  db: DatabaseSync,
  rawScope: unknown,
  raw: unknown,
  now: number
): RestoreRecoveryLocalReceipt {
  if (!db.isTransaction || !Number.isSafeInteger(now) || now < 0) conflict()
  const scope = DeviceScopeSchema.parse(rawScope),
    p = parse(raw),
    a = p.authorization,
    h = p.boundary.history,
    context = readLedgerRestoreContext(db)
  if (
    !context ||
    hashContext(context) !== hashContext(p.boundary.manifest.context) ||
    context.restoreId.toLowerCase() !== a.restoreId ||
    context.contextHash !== a.contextHash ||
    hashContext(scope) !== hashContext(a.scope)
  )
    conflict()
  initialize(db)
  const old = readRestoreRecoveryApplication(db, a.authorizationId)
  if (old) {
    const row = db
      .prepare(
        'SELECT request_hash FROM ledger_restore_recovery_applications WHERE authorization_id=?'
      )
      .get(a.authorizationId)
    if (row?.request_hash !== hashContext(p)) conflict()
    // Retrying an already committed operation never consumes later observations.
    return old
  }
  if (now < a.recordedAt || now >= a.expiresAt) conflict()
  const histories = new Map<string, Map<string, { direction: string; contentHash: string }>>()
  let sourceMessageCount = 0
  for (const c of h.conversations) {
    if (histories.has(c.conversationId) || !c.complete || c.hasGap || c.nextPageToken !== null)
      conflict()
    const messages = new Map<string, { direction: string; contentHash: string }>()
    let position = 0
    for (const m of c.messages) {
      if (
        ++sourceMessageCount > 200000 ||
        m.position !== ++position ||
        messages.has(m.sourceMessageId) ||
        m.sentAt > h.observedThrough
      )
        conflict()
      messages.set(m.sourceMessageId, m)
    }
    histories.set(c.conversationId, messages)
  }
  const localConversations = new Set<string>()
  const source = readLedgerRestoreInventory(db, scope, {}, (item) => {
    const anchors = histories.get(item.conversationId)
    if (!anchors) conflict()
    localConversations.add(
      hashContext({ identity: item.identity, conversationId: item.conversationId })
    )
    if (item.kind === 'message') {
      const anchor = anchors.get(item.sourceMessageId)
      if (
        !anchor ||
        anchor.direction !== item.direction ||
        anchor.contentHash !== item.contentHash ||
        !item.identityVerified ||
        !item.messageIdVerified
      )
        conflict()
    }
  })
  const manifest = {
    formatVersion: source.formatVersion,
    evidenceKind: source.evidenceKind,
    context: source.context,
    scope: source.scope,
    basisHash: source.basisHash,
    summary: source.summary,
    canRelease: source.canRelease,
    externalEvidenceRequired: source.externalEvidenceRequired
  }
  if (hashContext(manifest) !== hashContext(p.boundary.manifest)) conflict()
  const applicationId = randomUUID()
  let quarantinedInboundCount = 0
  for (const key of localConversations) {
    quarantinedInboundCount += Number(
      db
        .prepare(
          `UPDATE messages SET handled_execution=?
      WHERE scope=? AND handled_execution IS NULL AND json_extract(payload,'$.direction')='inbound'`
        )
        .run(`restore-recovery:${applicationId}`, key).changes
    )
    db.prepare('UPDATE conversations SET human_owned=1,revision=revision+1 WHERE scope=?').run(key)
  }
  // Includes previously unseen and empty source conversations, across login epochs.
  for (const conversationId of histories.keys()) {
    const key = hashContext({
      tenantId: scope.tenant_id,
      accountId: scope.account_id,
      platform: scope.platform,
      conversationId
    })
    db.prepare(
      'INSERT OR IGNORE INTO conversation_controls(delivery_scope,human_owned,revision) VALUES(?,0,0)'
    ).run(key)
    db.prepare(
      'UPDATE conversation_controls SET human_owned=1,revision=revision+1 WHERE delivery_scope=? AND human_owned<>1'
    ).run(key)
  }
  const post = readLedgerRestoreInventory(db, scope, {}, () => {})
  const receipt = RestoreRecoveryLocalReceiptSchema.parse({
    formatVersion: 1,
    applicationId,
    authorizationId: a.authorizationId,
    authorizationHash: hashContext(a),
    boundaryHash: a.boundaryHash,
    scope,
    caseId: a.caseId,
    uploadId: a.uploadId,
    restoreId: a.restoreId,
    contextHash: a.contextHash,
    inventoryBasisHash: a.inventoryBasisHash,
    postInventoryBasisHash: post.basisHash,
    quarantinedInboundCount,
    ownedConversationCount: histories.size,
    sourceMessageCount,
    appliedAt: now,
    localExecutionResolutionRequired: true,
    centralConfirmationRequired: true,
    automaticStart: false,
    canRelease: false
  })
  db.prepare(
    `INSERT INTO ledger_restore_recovery_applications(application_id,authorization_id,restore_id,scope_hash,request_hash,request_json,receipt_hash,receipt_json,applied_at)
    VALUES(?,?,?,?,?,?,?,?,?)`
  ).run(
    applicationId,
    a.authorizationId,
    a.restoreId,
    hashContext(scope),
    hashContext(p),
    JSON.stringify(p),
    hashContext(receipt),
    JSON.stringify(receipt),
    now
  )
  if (hashContext(readRestoreRecoveryApplication(db, a.authorizationId)) !== hashContext(receipt))
    conflict()
  return receipt
}
