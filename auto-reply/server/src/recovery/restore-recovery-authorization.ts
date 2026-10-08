import { z } from 'zod'
import type { PoolClient } from 'pg'
import type { Postgres } from '../database/postgres'
import { hashContext } from '../../../src/core/reply/hashes'
import {
  RestoreRecoveryApprovalInputSchema,
  RestoreRecoveryBoundarySchema,
  RestoreRecoveryAuthorizationReceiptSchema,
  type RestoreRecoveryBoundary,
  type RestoreRecoveryApprovalInput,
  type RestoreRecoveryAuthorizationReceipt
} from '../../../src/shared/contracts/restore-recovery'
import { authenticateRestoreMaintenance } from './restore-history-maintenance'
import { readVerifiedRestoreExecutionReview } from './restore-execution-maintenance'
import { readVerifiedRestoreHistoryEvidence } from '../admin/restore-history'
import { readCompleteRestoreAssessment } from '../admin/restore-assessment'
import { readCompleteRestoreInventory } from '../admin/restore-inventory'
import { readRestoreResolutionBasis } from './restore-resolution-basis'
type Scope = { tenant_id: string; actor_id: string }
export class RestoreRecoveryError extends Error {
  constructor(readonly code: 'RESTORE_RECOVERY_CONFLICT' | 'RESTORE_RECOVERY_NOT_READY') {
    super(code)
  }
}
function fail(ready = false): never {
  throw new RestoreRecoveryError(ready ? 'RESTORE_RECOVERY_NOT_READY' : 'RESTORE_RECOVERY_CONFLICT')
}
async function time(db: PoolClient): Promise<number> {
  return z
    .number()
    .int()
    .nonnegative()
    .safe()
    .parse(
      Number(
        (await db.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now'))
          .rows[0].now
      )
    )
}
interface RecoveryBasis {
  execution: Awaited<ReturnType<typeof readVerifiedRestoreExecutionReview>>
  history: Awaited<ReturnType<typeof readVerifiedRestoreHistoryEvidence>>
  inventory: Awaited<ReturnType<typeof readCompleteRestoreInventory>>
  assessment: Awaited<ReturnType<typeof readCompleteRestoreAssessment>>
  resolution: Awaited<ReturnType<typeof readRestoreResolutionBasis>>
  at: number
  expiresAt: number
}
export interface RestoreRecoveryPreview extends Omit<
  RestoreRecoveryApprovalInput,
  'authorizationId' | 'reviewedBy' | 'reviewedAt'
> {
  authorizationIdRequired: true
  independentMaintenanceApprovalRequired: true
  localDurableApplicationRequired: true
  centralCompletionRequired: true
  automaticStart: false
  canRelease: false
}
async function basis(
  db: PoolClient,
  s: Scope,
  accountId: string,
  caseId: string,
  uploadId: string,
  reviewId: string
): Promise<RecoveryBasis> {
  const execution = await readVerifiedRestoreExecutionReview(db, s, accountId, caseId, reviewId)
  if (execution.record.current.state !== 'current' || execution.input.uploadId !== uploadId)
    fail(true)
  const history = await readVerifiedRestoreHistoryEvidence(
    db,
    s,
    accountId,
    caseId,
    execution.input.historyProofId
  )
  if (history.record.current.state !== 'current') fail(true)
  const inventory = await readCompleteRestoreInventory(db, s, accountId, caseId, uploadId)
  const assessment = await readCompleteRestoreAssessment(db, s, accountId, caseId, uploadId)
  const at = await time(db),
    resolution = await readRestoreResolutionBasis(
      db,
      s,
      assessment,
      execution.input,
      history.proof,
      at
    )
  if (
    (
      await db.query(
        'SELECT 1 FROM account_leases WHERE tenant_id=$1 AND account_id=$2 AND expires_at>clock_timestamp()',
        [s.tenant_id, accountId]
      )
    ).rowCount
  )
    fail(true)
  return {
    execution,
    history,
    inventory,
    assessment,
    resolution,
    at,
    expiresAt: Math.min(
      at + 300000,
      history.proof.capturedAt + 300000,
      history.proof.observedThrough + 300000,
      execution.input.reviewedAt + 300000,
      history.requirement.sourceTrust.notAfter
    )
  }
}
export async function previewRestoreRecovery(
  db: PoolClient,
  s: Scope,
  accountId: string,
  caseId: string,
  uploadId: string,
  reviewId: string
): Promise<RestoreRecoveryPreview> {
  const b = await basis(db, s, accountId, caseId, uploadId, reviewId)
  return {
    tenantId: s.tenant_id,
    accountId,
    caseId,
    uploadId,
    reviewId,
    expectedContextHash: b.inventory.manifest.context.contextHash,
    expectedInventoryBasisHash: b.inventory.manifest.basisHash,
    expectedAssessmentBasisHash: b.assessment.basisHash,
    expectedHistoryReceiptHash: hashContext(b.history.record.receipt),
    expectedExecutionReceiptHash: hashContext(b.execution.record.receipt),
    expectedResolutionBasisHash: b.resolution.resolutionBasisHash,
    historyPolicy: 'quarantine_all_history' as const,
    authorizationIdRequired: true,
    independentMaintenanceApprovalRequired: true,
    localDurableApplicationRequired: true,
    centralCompletionRequired: true,
    automaticStart: false,
    canRelease: false
  }
}
export interface RestoreRecoveryAuthorizationResult {
  receipt: RestoreRecoveryAuthorizationReceipt
  current: {
    state:
      | 'current'
      | 'basis_changed'
      | 'authorization_expired'
      | 'authorization_superseded'
      | 'evidence_unavailable'
    canRelease: false
  }
  canRelease: false
}
const select = `SELECT tenant_id,account_id,case_id,upload_id,authorization_id,review_id,request_hash,
 CASE WHEN octet_length(request_json::text)<=16384 THEN request_json END AS request_json,
 boundary_hash,CASE WHEN octet_length(boundary_json::text)<=2097152 THEN boundary_json END AS boundary_json,
 receipt_hash,CASE WHEN octet_length(receipt_json::text)<=16384 THEN receipt_json END AS receipt_json,
 recorded_by,recorded_at,expires_at FROM ledger_restore_recovery_authorizations
 WHERE tenant_id=$1 AND account_id=$2 AND authorization_id=$3`
/** Returns original evidence and its separate present usability; not a completion gate. */
export async function readRestoreRecoveryAuthorization(
  db: PoolClient,
  s: Scope,
  accountId: string,
  caseId: string,
  authorizationId: string
): Promise<RestoreRecoveryAuthorizationResult> {
  return (await readVerifiedRestoreRecoveryAuthorization(db, s, accountId, caseId, authorizationId))
    .record
}
export async function readVerifiedRestoreRecoveryAuthorization(
  db: PoolClient,
  s: Scope,
  accountId: string,
  caseId: string,
  authorizationId: string
): Promise<{ record: RestoreRecoveryAuthorizationResult; boundary: RestoreRecoveryBoundary }> {
  const row = (await db.query(select, [s.tenant_id, accountId, authorizationId])).rows[0]
  if (!row || row.case_id !== caseId) fail()
  const request = RestoreRecoveryApprovalInputSchema.parse(row.request_json),
    boundary = RestoreRecoveryBoundarySchema.parse(row.boundary_json),
    receipt = RestoreRecoveryAuthorizationReceiptSchema.parse(row.receipt_json)
  if (
    request.tenantId !== s.tenant_id ||
    request.accountId !== accountId ||
    request.caseId !== caseId ||
    request.uploadId !== row.upload_id ||
    request.reviewId !== row.review_id ||
    request.authorizationId !== row.authorization_id ||
    request.authorizationId !== receipt.authorizationId ||
    boundary.authorizationId !== receipt.authorizationId ||
    hashContext(request) !== row.request_hash ||
    receipt.requestHash !== row.request_hash ||
    hashContext(receipt) !== row.receipt_hash ||
    hashContext(boundary) !== row.boundary_hash ||
    receipt.boundaryHash !== row.boundary_hash ||
    receipt.recordedBy !== row.recorded_by ||
    receipt.recordedAt !== new Date(row.recorded_at).getTime() ||
    receipt.expiresAt !== new Date(row.expires_at).getTime() ||
    receipt.caseId !== request.caseId ||
    receipt.uploadId !== request.uploadId ||
    receipt.reviewId !== request.reviewId ||
    hashContext(receipt.scope) !== hashContext(boundary.history.scope) ||
    receipt.restoreId !== boundary.history.restoreId ||
    receipt.contextHash !== boundary.history.contextHash ||
    receipt.inventoryBasisHash !== boundary.manifest.basisHash ||
    receipt.contextHash !== request.expectedContextHash ||
    receipt.inventoryBasisHash !== request.expectedInventoryBasisHash ||
    receipt.assessmentBasisHash !== request.expectedAssessmentBasisHash ||
    receipt.historyReceiptHash !== request.expectedHistoryReceiptHash ||
    receipt.executionReceiptHash !== request.expectedExecutionReceiptHash ||
    receipt.resolutionBasisHash !== request.expectedResolutionBasisHash ||
    receipt.historyReceiptHash !== boundary.historyReceiptHash ||
    receipt.executionReceiptHash !== boundary.executionReceiptHash ||
    receipt.resolutionBasisHash !== boundary.resolutionBasisHash ||
    request.reviewedAt > receipt.recordedAt ||
    receipt.recordedAt - request.reviewedAt > 300000
  )
    fail()
  const execution = await readVerifiedRestoreExecutionReview(
    db,
    s,
    accountId,
    caseId,
    receipt.reviewId
  )
  const history = await readVerifiedRestoreHistoryEvidence(
    db,
    s,
    accountId,
    caseId,
    receipt.historyProofId
  )
  const inventory = await readCompleteRestoreInventory(db, s, accountId, caseId, receipt.uploadId)
  if (
    hashContext(execution.record.receipt) !== receipt.executionReceiptHash ||
    hashContext(history.record.receipt) !== receipt.historyReceiptHash ||
    execution.input.historyProofId !== receipt.historyProofId ||
    hashContext(history.proof) !== hashContext(boundary.history) ||
    hashContext(inventory.manifest) !== hashContext(boundary.manifest) ||
    receipt.recordedAt <
      Math.max(execution.record.receipt.recordedAt, history.record.receipt.recordedAt) ||
    receipt.historyProofId !== boundary.history.proofId ||
    receipt.assessmentBasisHash !== history.record.receipt.assessmentBasisHash ||
    receipt.assessmentBasisHash !== execution.record.receipt.assessmentBasisHash ||
    receipt.expiresAt !==
      Math.min(
        receipt.recordedAt + 300000,
        history.proof.capturedAt + 300000,
        history.proof.observedThrough + 300000,
        execution.input.reviewedAt + 300000,
        history.requirement.sourceTrust.notAfter
      )
  )
    fail()
  const at = await time(db)
  let state: RestoreRecoveryAuthorizationResult['current']['state'] = 'current'
  const latest = (
    await db.query(
      'SELECT authorization_id FROM ledger_restore_recovery_authorizations WHERE tenant_id=$1 AND account_id=$2 AND case_id=$3 ORDER BY recorded_at DESC,authorization_id DESC LIMIT 1',
      [s.tenant_id, accountId, caseId]
    )
  ).rows[0]
  if (at < receipt.recordedAt || at >= receipt.expiresAt) state = 'authorization_expired'
  else if (latest?.authorization_id !== receipt.authorizationId) state = 'authorization_superseded'
  else {
    try {
      const b = await basis(db, s, accountId, caseId, receipt.uploadId, receipt.reviewId)
      if (
        b.resolution.resolutionBasisHash !== receipt.resolutionBasisHash ||
        b.assessment.basisHash !== receipt.assessmentBasisHash
      )
        state = 'basis_changed'
    } catch {
      state = 'evidence_unavailable'
    }
  }
  return { record: { receipt, current: { state, canRelease: false }, canRelease: false }, boundary }
}
export class RestoreRecoveryMaintenance {
  constructor(private readonly db: Postgres) {}
  approve(raw: unknown): Promise<RestoreRecoveryAuthorizationResult> {
    if (Buffer.byteLength(JSON.stringify(raw) ?? '') > 16384) fail()
    const input = RestoreRecoveryApprovalInputSchema.parse(raw)
    return this.db.transaction(input.tenantId, async (db) => {
      const login = await authenticateRestoreMaintenance(db),
        s = { tenant_id: input.tenantId, actor_id: login }
      const account = (
        await db.query('SELECT paused FROM accounts WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [
          input.tenantId,
          input.accountId
        ])
      ).rows[0]
      if (!account) fail()
      const old = (await db.query(select, [input.tenantId, input.accountId, input.authorizationId]))
        .rows[0]
      if (old) {
        if (old.recorded_by !== login || old.request_hash !== hashContext(input)) fail()
        return readRestoreRecoveryAuthorization(
          db,
          s,
          input.accountId,
          input.caseId,
          input.authorizationId
        )
      }
      if (!account.paused) fail(true)
      const b = await basis(db, s, input.accountId, input.caseId, input.uploadId, input.reviewId)
      if (
        input.expectedContextHash !== b.inventory.manifest.context.contextHash ||
        input.expectedInventoryBasisHash !== b.inventory.manifest.basisHash ||
        input.expectedAssessmentBasisHash !== b.assessment.basisHash ||
        input.expectedHistoryReceiptHash !== hashContext(b.history.record.receipt) ||
        input.expectedExecutionReceiptHash !== hashContext(b.execution.record.receipt) ||
        input.expectedResolutionBasisHash !== b.resolution.resolutionBasisHash
      )
        fail()
      if (input.reviewedAt > b.at || b.at - input.reviewedAt > 300000 || b.expiresAt <= b.at)
        fail(true)
      const boundary = RestoreRecoveryBoundarySchema.parse({
        formatVersion: 1,
        kind: 'restore-account-boundary',
        authorizationId: input.authorizationId,
        manifest: b.inventory.manifest,
        history: b.history.proof,
        historyReceiptHash: input.expectedHistoryReceiptHash,
        executionReceiptHash: input.expectedExecutionReceiptHash,
        resolutionBasisHash: input.expectedResolutionBasisHash,
        humanOwnershipPolicy: 'all_restored_conversations'
      })
      if (Buffer.byteLength(JSON.stringify(boundary)) > 2097152) fail()
      const receipt = RestoreRecoveryAuthorizationReceiptSchema.parse({
        formatVersion: 1,
        authorizationId: input.authorizationId,
        scope: boundary.history.scope,
        caseId: input.caseId,
        uploadId: input.uploadId,
        reviewId: input.reviewId,
        restoreId: boundary.history.restoreId,
        contextHash: input.expectedContextHash,
        inventoryBasisHash: input.expectedInventoryBasisHash,
        assessmentBasisHash: input.expectedAssessmentBasisHash,
        historyProofId: boundary.history.proofId,
        historyReceiptHash: input.expectedHistoryReceiptHash,
        executionReceiptHash: input.expectedExecutionReceiptHash,
        resolutionBasisHash: input.expectedResolutionBasisHash,
        boundaryHash: hashContext(boundary),
        requestHash: hashContext(input),
        historyPolicy: input.historyPolicy,
        recordedBy: login,
        recordedAt: b.at,
        expiresAt: b.expiresAt,
        status: 'approved_for_boundary',
        localDurableApplicationRequired: true,
        centralCompletionRequired: true,
        physicalFactsVerifiedByThisCommand: false,
        automaticStart: false,
        canRelease: false
      })
      await db.query(
        `INSERT INTO ledger_restore_recovery_authorizations(tenant_id,account_id,case_id,upload_id,authorization_id,review_id,request_hash,request_json,boundary_hash,boundary_json,receipt_hash,receipt_json,recorded_by,recorded_at,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb,$11,$12::jsonb,$13,$14,$15)`,
        [
          input.tenantId,
          input.accountId,
          input.caseId,
          input.uploadId,
          input.authorizationId,
          input.reviewId,
          hashContext(input),
          JSON.stringify(input),
          hashContext(boundary),
          JSON.stringify(boundary),
          hashContext(receipt),
          JSON.stringify(receipt),
          login,
          new Date(b.at),
          new Date(b.expiresAt)
        ]
      )
      return { receipt, current: { state: 'current', canRelease: false }, canRelease: false }
    })
  }
}
