import { randomUUID } from 'node:crypto'
import { lockRestoreHistoryKey, restoreHistoryKeySha256 } from '../recovery/restore-history-key'
import { z } from 'zod'
import type { PoolClient } from 'pg'
import { Hash } from '../../../src/shared/contracts/identity'
import {
  RestoreHistorySubmissionSchema,
  RestoreHistoryReceiptSchema,
  type RestoreHistoryReceipt
} from '../../../src/shared/contracts/restore-history'
import { hashContext } from '../../../src/core/reply/hashes'
import {
  RestoreHistorySourceTrustSchema,
  RestoreHistoryProofVerifier,
  type RestoreHistoryRequirement
} from '../recovery/restore-history-proof'
import { readCompleteRestoreInventory } from './restore-inventory'
import { readCompleteRestoreAssessment } from './restore-assessment'
import { readRestoreReview } from './restore-review'

const Millis = z.number().int().nonnegative().safe()
export const RestoreHistoryRequirementRecordSchema = z.strictObject({
  formatVersion: z.literal(1),
  requirementId: z.uuid().toLowerCase(),
  caseId: z.uuid().toLowerCase(),
  uploadId: z.uuid().toLowerCase(),
  restoreId: z.uuid().toLowerCase(),
  contextHash: Hash,
  inventoryBasisHash: Hash,
  assessmentBasisHash: Hash,
  scopeHash: Hash,
  platformAccountIdHash: Hash,
  backupStartedAt: Millis,
  backupStartVerificationSha256: Hash,
  allDevicesStoppedAt: Millis,
  deviceStopVerificationSha256: Hash,
  sourceTrust: RestoreHistorySourceTrustSchema,
  recordedAt: Millis
})
type Scope = { tenant_id: string; actor_id: string }
type Requirement = z.infer<typeof RestoreHistoryRequirementRecordSchema>
export class RestoreHistoryRecordError extends Error {
  constructor(
    readonly code:
      | 'RESTORE_HISTORY_CONFLICT'
      | 'RESTORE_HISTORY_NOT_FOUND'
      | 'RESTORE_HISTORY_NOT_READY'
  ) {
    super(code)
    this.name = 'RestoreHistoryRecordError'
  }
}
function conflict(): never {
  throw new RestoreHistoryRecordError('RESTORE_HISTORY_CONFLICT')
}
function notReady(): never {
  throw new RestoreHistoryRecordError('RESTORE_HISTORY_NOT_READY')
}
interface Row {
  tenant_id: string
  account_id: string
  case_id: string
  upload_id: string
  proof_id: string
  requirement_id: string
  request_hash: string
  request_json: unknown
  receipt_hash: string
  receipt_json: unknown
  recorded_by: string
  recorded_at: Date
}
export interface RestoreHistoryRecordResult {
  receipt: RestoreHistoryReceipt
  current: {
    state:
      | 'current'
      | 'source_revoked'
      | 'evidence_expired'
      | 'requirement_superseded'
      | 'basis_changed'
      | 'state_unavailable'
    canRelease: false
  }
  canRelease: false
}
const Select = `SELECT tenant_id,account_id,case_id,upload_id,proof_id,requirement_id,request_hash,
 CASE WHEN octet_length(request_json::text)<=1048576 THEN request_json ELSE NULL END AS request_json,
 receipt_hash,CASE WHEN octet_length(receipt_json::text)<=16384 THEN receipt_json ELSE NULL END AS receipt_json,
 recorded_by,recorded_at FROM ledger_restore_history_proofs WHERE tenant_id=$1 AND account_id=$2 AND proof_id=$3`
async function time(db: PoolClient): Promise<number> {
  return Millis.parse(
    Number(
      (await db.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now'))
        .rows[0].now
    )
  )
}
async function requirement(
  db: PoolClient,
  s: Scope,
  accountId: string,
  caseId: string,
  id: string
): Promise<Requirement> {
  const row = (
    await db.query(
      `SELECT id,upload_id,requirement_hash,
   CASE WHEN octet_length(requirement_json::text)<=16384 THEN requirement_json ELSE NULL END AS requirement_json,recorded_at
   FROM ledger_restore_history_requirements WHERE tenant_id=$1 AND account_id=$2 AND case_id=$3 AND id=$4`,
      [s.tenant_id, accountId, caseId, id]
    )
  ).rows[0]
  if (!row) throw new RestoreHistoryRecordError('RESTORE_HISTORY_NOT_FOUND')
  try {
    const r = RestoreHistoryRequirementRecordSchema.parse(row.requirement_json)
    if (
      r.requirementId !== row.id ||
      r.caseId !== caseId ||
      r.uploadId !== row.upload_id ||
      hashContext(r) !== row.requirement_hash ||
      r.recordedAt !== new Date(row.recorded_at).getTime() ||
      r.sourceTrust.tenantId !== s.tenant_id ||
      r.sourceTrust.accountId !== accountId ||
      r.sourceTrust.platformAccountIdHash !== r.platformAccountIdHash
    )
      conflict()
    // Also validates the algorithm/key/validity configuration without registering any production key.
    new RestoreHistoryProofVerifier([r.sourceTrust])
    return r
  } catch {
    conflict()
  }
}
async function revokedAt(db: PoolClient, r: Requirement): Promise<number | null> {
  const sha = restoreHistoryKeySha256(r.sourceTrust.publicKeyPem)
  await lockRestoreHistoryKey(db, sha)
  const role = (await db.query('SELECT current_user AS role')).rows[0]?.role
  const row = (
    await db.query(
      role === 'autoreply_restore_reader'
        ? 'SELECT recorded_at FROM autoreply.restore_recovery_key_revocation($1)'
        : 'SELECT recorded_at FROM restore_history_key_revocations WHERE key_sha256=$1',
      [sha]
    )
  ).rows[0]
  return row ? Millis.parse(new Date(row.recorded_at).getTime()) : null
}
async function facts(
  db: PoolClient,
  s: Scope,
  accountId: string,
  r: Requirement
): Promise<RestoreHistoryRequirement> {
  const review = await readRestoreReview(db, s, accountId, r.caseId)
  const inventory = await readCompleteRestoreInventory(db, s, accountId, r.caseId, r.uploadId)
  if (
    r.restoreId !== inventory.manifest.context.restoreId.toLowerCase() ||
    r.contextHash !== review.contextHash ||
    r.inventoryBasisHash !== inventory.manifest.basisHash ||
    r.scopeHash !== hashContext(inventory.manifest.scope) ||
    r.sourceTrust.platform !== inventory.manifest.scope.platform ||
    r.recordedAt < review.openedAt
  )
    conflict()
  return {
    caseId: r.caseId,
    uploadId: r.uploadId,
    manifest: inventory.manifest,
    items: inventory.items.map((i) => i.local),
    platformAccountIdHash: r.platformAccountIdHash,
    backupStartedAt: r.backupStartedAt,
    allDevicesStoppedAt: Math.max(r.allDevicesStoppedAt, r.recordedAt)
  }
}
interface StoredProof {
  request: z.infer<typeof RestoreHistorySubmissionSchema>
  receipt: RestoreHistoryReceipt
  r: Requirement
  revoked: number | null
}
async function stored(
  db: PoolClient,
  s: Scope,
  accountId: string,
  caseId: string,
  row: Row
): Promise<StoredProof> {
  try {
    const request = RestoreHistorySubmissionSchema.parse(row.request_json),
      receipt = RestoreHistoryReceiptSchema.parse(row.receipt_json)
    const r = await requirement(db, s, accountId, caseId, row.requirement_id)
    if (
      row.tenant_id !== s.tenant_id ||
      row.account_id !== accountId ||
      row.case_id !== caseId ||
      row.proof_id !== receipt.proofId ||
      row.upload_id !== receipt.uploadId ||
      request.requirementId !== r.requirementId ||
      receipt.requirementId !== r.requirementId ||
      receipt.caseId !== caseId ||
      receipt.requirementHash !== hashContext(r) ||
      receipt.assessmentBasisHash !== r.assessmentBasisHash ||
      row.request_hash !== hashContext(request) ||
      row.receipt_hash !== hashContext(receipt) ||
      receipt.recordedBy !== row.recorded_by ||
      receipt.recordedAt !== new Date(row.recorded_at).getTime() ||
      receipt.recordedAt < r.recordedAt
    )
      conflict()
    const revoked = await revokedAt(db, r)
    if (revoked !== null && revoked <= receipt.recordedAt) conflict()
    const verified = new RestoreHistoryProofVerifier([r.sourceTrust]).check(
      request.signedProof,
      await facts(db, s, accountId, r),
      receipt.recordedAt
    )
    if (hashContext(verified) !== hashContext(receipt.checked)) conflict()
    return { request, receipt, r, revoked }
  } catch {
    conflict()
  }
}
async function current(
  db: PoolClient,
  s: Scope,
  accountId: string,
  value: Awaited<ReturnType<typeof stored>>
): Promise<RestoreHistoryRecordResult> {
  const { receipt, r, revoked } = value
  let state: RestoreHistoryRecordResult['current']['state'] = 'current'
  const now = await time(db)
  const latest = (
    await db.query(
      'SELECT id FROM ledger_restore_history_requirements WHERE tenant_id=$1 AND account_id=$2 AND case_id=$3 ORDER BY recorded_at DESC,id DESC LIMIT 1',
      [s.tenant_id, accountId, r.caseId]
    )
  ).rows[0]
  if (revoked !== null) state = 'source_revoked'
  else if (
    now < r.sourceTrust.notBefore ||
    now >= r.sourceTrust.notAfter ||
    now < receipt.recordedAt ||
    now - receipt.checked.capturedAt > 300000 ||
    now - receipt.checked.observedThrough > 300000
  )
    state = 'evidence_expired'
  else if (latest?.id !== r.requirementId) state = 'requirement_superseded'
  else {
    try {
      const assessment = await readCompleteRestoreAssessment(db, s, accountId, r.caseId, r.uploadId)
      if (assessment.basisHash !== r.assessmentBasisHash) state = 'basis_changed'
    } catch {
      state = 'state_unavailable'
    }
  }
  return { receipt, current: { state, canRelease: false }, canRelease: false }
}
/** Exact authenticated account lock and transaction supplied by Administration. */
export async function readRestoreHistoryProof(
  db: PoolClient,
  s: Scope,
  accountId: string,
  caseId: string,
  proofId: string
): Promise<RestoreHistoryRecordResult> {
  return (await readVerifiedRestoreHistoryEvidence(db, s, accountId, caseId, proofId)).record
}
/** Internal recovery composition: still validates the stored signature and current state;
 * ordinary administration responses do not expose the underlying history payload. */
export async function readVerifiedRestoreHistoryEvidence(
  db: PoolClient,
  s: Scope,
  accountId: string,
  caseId: string,
  proofId: string
): Promise<{
  record: RestoreHistoryRecordResult
  proof: z.infer<typeof RestoreHistorySubmissionSchema>['signedProof']['proof']
  requirement: Requirement
}> {
  const row = (await db.query<Row>(Select, [s.tenant_id, accountId, proofId])).rows[0]
  if (!row || row.case_id !== caseId)
    throw new RestoreHistoryRecordError('RESTORE_HISTORY_NOT_FOUND')
  const value = await stored(db, s, accountId, caseId, row)
  return {
    record: await current(db, s, accountId, value),
    proof: value.request.signedProof.proof,
    requirement: value.r
  }
}
export async function recordRestoreHistoryProof(
  db: PoolClient,
  s: Scope,
  accountId: string,
  caseId: string,
  uploadId: string,
  raw: unknown
): Promise<RestoreHistoryRecordResult> {
  if (Buffer.byteLength(JSON.stringify(raw) ?? '') > 1048576) conflict()
  const request = RestoreHistorySubmissionSchema.parse(raw),
    proof = request.signedProof.proof
  if (
    proof.caseId !== caseId ||
    proof.uploadId !== uploadId ||
    proof.scope.tenant_id !== s.tenant_id ||
    proof.scope.account_id !== accountId
  )
    conflict()
  const old = (await db.query<Row>(Select, [s.tenant_id, accountId, proof.proofId])).rows[0]
  if (old) {
    const checked = await stored(db, s, accountId, caseId, old)
    if (hashContext(request) !== hashContext(checked.request)) conflict()
    return current(db, s, accountId, checked)
  }
  const r = await requirement(db, s, accountId, caseId, request.requirementId)
  if (r.uploadId !== uploadId) conflict()
  const now = await time(db),
    revoked = await revokedAt(db, r)
  const latest = (
    await db.query(
      'SELECT id FROM ledger_restore_history_requirements WHERE tenant_id=$1 AND account_id=$2 AND case_id=$3 ORDER BY recorded_at DESC,id DESC LIMIT 1',
      [s.tenant_id, accountId, caseId]
    )
  ).rows[0]
  if (revoked !== null || latest?.id !== r.requirementId) notReady()
  const required = await facts(db, s, accountId, r)
  const assessment = await readCompleteRestoreAssessment(db, s, accountId, caseId, uploadId)
  if (assessment.basisHash !== r.assessmentBasisHash) notReady()
  const checked = new RestoreHistoryProofVerifier([r.sourceTrust]).check(
    request.signedProof,
    required,
    now
  )
  const receipt = RestoreHistoryReceiptSchema.parse({
    formatVersion: 1,
    kind: 'restore-history-evidence',
    proofId: proof.proofId,
    caseId,
    uploadId,
    requirementId: r.requirementId,
    requirementHash: hashContext(r),
    assessmentBasisHash: r.assessmentBasisHash,
    checked,
    recordedBy: s.actor_id,
    recordedAt: now,
    physicalHistoryReviewRequired: true,
    executionOutcomesRequired: true,
    automaticStart: false,
    canRelease: false
  })
  await db.query(
    `INSERT INTO ledger_restore_history_proofs(tenant_id,account_id,case_id,upload_id,proof_id,requirement_id,request_hash,request_json,receipt_hash,receipt_json,recorded_by,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb,$11,$12)`,
    [
      s.tenant_id,
      accountId,
      caseId,
      uploadId,
      proof.proofId,
      r.requirementId,
      hashContext(request),
      JSON.stringify(request),
      hashContext(receipt),
      JSON.stringify(receipt),
      s.actor_id,
      new Date(now)
    ]
  )
  await db.query(
    `INSERT INTO audit_events(tenant_id,id,actor_id,kind,account_id,details_json) VALUES($1,$2,$3,'ledger_restore_history_recorded',$4,$5::jsonb)`,
    [
      s.tenant_id,
      randomUUID(),
      s.actor_id,
      accountId,
      JSON.stringify({
        caseId,
        uploadId,
        proofId: proof.proofId,
        requirementId: r.requirementId,
        signedProofHash: checked.signedProofHash,
        canRelease: false
      })
    ]
  )
  return { receipt, current: { state: 'current', canRelease: false }, canRelease: false }
}
