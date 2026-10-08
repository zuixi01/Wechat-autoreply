import { z } from 'zod'
import type { PoolClient } from 'pg'
import type { Postgres } from '../database/postgres'
import { hashContext } from '../../../src/core/reply/hashes'
import {
  RestoreExecutionReviewInputSchema,
  RestoreExecutionReviewReceiptSchema,
  type RestoreExecutionReviewReceipt
} from '../../../src/shared/contracts/restore-execution'
import { authenticateRestoreMaintenance } from './restore-history-maintenance'
import { readVerifiedRestoreHistoryEvidence } from '../admin/restore-history'
import { readCompleteRestoreAssessment } from '../admin/restore-assessment'
import {
  checkRestoreExecutionOutcomes,
  restoreExecutionSubjects,
  RestoreExecutionError
} from './restore-execution-proof'

type Scope = { tenant_id: string; actor_id: string }
export interface RestoreExecutionReviewResult {
  receipt: RestoreExecutionReviewReceipt
  current: {
    state:
      | 'current'
      | 'history_unavailable'
      | 'history_not_current'
      | 'basis_changed'
      | 'evidence_expired'
    canRelease: false
  }
  canRelease: false
}
function fail(code: RestoreExecutionError['code'] = 'restore_execution_conflict'): never {
  throw new RestoreExecutionError(code)
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
function bounded(raw: unknown): void {
  if (Buffer.byteLength(JSON.stringify(raw) ?? '') > 1048576) fail()
}
const select = `SELECT tenant_id,account_id,case_id,upload_id,review_id,history_proof_id,request_hash,
 CASE WHEN octet_length(request_json::text)<=1048576 THEN request_json ELSE NULL END AS request_json,
 subjects_hash,CASE WHEN octet_length(subjects_json::text)<=1048576 THEN subjects_json ELSE NULL END AS subjects_json,
 receipt_hash,CASE WHEN octet_length(receipt_json::text)<=16384 THEN receipt_json ELSE NULL END AS receipt_json,
 recorded_by,recorded_at FROM ledger_restore_execution_reviews WHERE tenant_id=$1 AND account_id=$2 AND review_id=$3`
/** Called with an authenticated administrator or independent maintenance transaction and account lock. */
export async function readRestoreExecutionReview(
  db: PoolClient,
  s: Scope,
  accountId: string,
  caseId: string,
  reviewId: string
): Promise<RestoreExecutionReviewResult> {
  return (await readVerifiedRestoreExecutionReview(db, s, accountId, caseId, reviewId)).record
}
/** Internal final-recovery composition; public administrator reads keep metadata receipts only. */
export async function readVerifiedRestoreExecutionReview(
  db: PoolClient,
  s: Scope,
  accountId: string,
  caseId: string,
  reviewId: string
): Promise<{
  record: RestoreExecutionReviewResult
  input: ReturnType<typeof RestoreExecutionReviewInputSchema.parse>
  subjects: ReturnType<typeof restoreExecutionSubjects>
  history: Awaited<ReturnType<typeof readVerifiedRestoreHistoryEvidence>>['proof']
}> {
  const row = (await db.query(select, [s.tenant_id, accountId, reviewId])).rows[0]
  if (!row || row.case_id !== caseId) fail()
  const input = RestoreExecutionReviewInputSchema.parse(row.request_json),
    receipt = RestoreExecutionReviewReceiptSchema.parse(row.receipt_json)
  if (
    input.tenantId !== s.tenant_id ||
    input.accountId !== accountId ||
    input.caseId !== caseId ||
    input.uploadId !== row.upload_id ||
    input.reviewId !== row.review_id ||
    input.historyProofId !== row.history_proof_id ||
    hashContext(input) !== row.request_hash ||
    receipt.recordedBy !== row.recorded_by ||
    receipt.recordedAt !== new Date(row.recorded_at).getTime() ||
    receipt.requestHash !== row.request_hash ||
    hashContext(receipt) !== row.receipt_hash ||
    receipt.subjectsSnapshotHash !== row.subjects_hash ||
    hashContext(row.subjects_json) !== row.subjects_hash
  )
    fail()
  const history = await readVerifiedRestoreHistoryEvidence(
    db,
    s,
    accountId,
    caseId,
    input.historyProofId
  )
  const checked = checkRestoreExecutionOutcomes(
    input,
    row.subjects_json,
    history.proof,
    Math.max(history.requirement.recordedAt, history.requirement.allDevicesStoppedAt),
    receipt.recordedAt
  )
  const expected = RestoreExecutionReviewReceiptSchema.parse({
    formatVersion: 1,
    reviewId: input.reviewId,
    tenantId: input.tenantId,
    accountId: input.accountId,
    caseId: input.caseId,
    uploadId: input.uploadId,
    historyProofId: input.historyProofId,
    assessmentBasisHash: input.assessmentBasisHash,
    historyReceiptHash: hashContext(history.record.receipt),
    subjectsSnapshotHash: hashContext(checked.subjects),
    requestHash: hashContext(input),
    outcomesHash: checked.outcomesHash,
    subjects: checked.subjects.length,
    confirmed: checked.confirmed,
    notSent: checked.notSent,
    executionGroups: checked.executionGroups,
    recordedBy: row.recorded_by,
    recordedAt: receipt.recordedAt,
    maintenanceReviewRecorded: true,
    physicalOutcomeVerifiedByThisCommand: false,
    separateReconciliationRequired: true,
    automaticStart: false,
    canRelease: false
  })
  if (
    hashContext(expected) !== row.receipt_hash ||
    input.assessmentBasisHash !== history.record.receipt.assessmentBasisHash ||
    input.uploadId !== history.record.receipt.uploadId ||
    receipt.recordedAt < history.record.receipt.recordedAt
  )
    fail()
  const at = await time(db)
  let state: RestoreExecutionReviewResult['current']['state'] = 'current'
  if (history.record.current.state !== 'current') state = 'history_not_current'
  else if (at < receipt.recordedAt || at - input.reviewedAt > 300000) state = 'evidence_expired'
  else {
    try {
      const assessment = await readCompleteRestoreAssessment(
        db,
        s,
        accountId,
        caseId,
        input.uploadId
      )
      if (
        assessment.basisHash !== input.assessmentBasisHash ||
        hashContext(restoreExecutionSubjects(assessment)) !== receipt.subjectsSnapshotHash
      )
        state = 'basis_changed'
    } catch {
      state = 'history_unavailable'
    }
  }
  return {
    record: { receipt, current: { state, canRelease: false }, canRelease: false },
    input,
    subjects: checked.subjects,
    history: history.proof
  }
}
export class RestoreExecutionMaintenance {
  constructor(private readonly db: Postgres) {}
  authenticate(): Promise<string> {
    return this.db.transaction('', authenticateRestoreMaintenance)
  }
  record(raw: unknown): Promise<RestoreExecutionReviewResult> {
    bounded(raw)
    const input = RestoreExecutionReviewInputSchema.parse(raw)
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
      const old = (await db.query(select, [input.tenantId, input.accountId, input.reviewId]))
        .rows[0]
      if (old) {
        if (old.recorded_by !== login || old.request_hash !== hashContext(input)) fail()
        return readRestoreExecutionReview(db, s, input.accountId, input.caseId, input.reviewId)
      }
      if (
        !account.paused ||
        (
          await db.query(
            'SELECT 1 FROM account_leases WHERE tenant_id=$1 AND account_id=$2 AND expires_at>clock_timestamp()',
            [input.tenantId, input.accountId]
          )
        ).rowCount
      )
        fail('restore_execution_not_ready')
      const history = await readVerifiedRestoreHistoryEvidence(
        db,
        s,
        input.accountId,
        input.caseId,
        input.historyProofId
      )
      if (history.record.current.state !== 'current') fail('restore_execution_not_ready')
      const assessment = await readCompleteRestoreAssessment(
        db,
        s,
        input.accountId,
        input.caseId,
        input.uploadId
      )
      if (
        assessment.basisHash !== input.assessmentBasisHash ||
        input.assessmentBasisHash !== history.record.receipt.assessmentBasisHash ||
        input.uploadId !== history.record.receipt.uploadId
      )
        fail()
      const at = await time(db),
        checked = checkRestoreExecutionOutcomes(
          input,
          restoreExecutionSubjects(assessment),
          history.proof,
          Math.max(history.requirement.recordedAt, history.requirement.allDevicesStoppedAt),
          at
        )
      bounded(checked.subjects)
      const receipt = RestoreExecutionReviewReceiptSchema.parse({
        formatVersion: 1,
        reviewId: input.reviewId,
        tenantId: input.tenantId,
        accountId: input.accountId,
        caseId: input.caseId,
        uploadId: input.uploadId,
        historyProofId: input.historyProofId,
        assessmentBasisHash: input.assessmentBasisHash,
        historyReceiptHash: hashContext(history.record.receipt),
        subjectsSnapshotHash: hashContext(checked.subjects),
        requestHash: hashContext(input),
        outcomesHash: checked.outcomesHash,
        subjects: checked.subjects.length,
        confirmed: checked.confirmed,
        notSent: checked.notSent,
        executionGroups: checked.executionGroups,
        recordedBy: login,
        recordedAt: at,
        maintenanceReviewRecorded: true,
        physicalOutcomeVerifiedByThisCommand: false,
        separateReconciliationRequired: true,
        automaticStart: false,
        canRelease: false
      })
      await db.query(
        `INSERT INTO ledger_restore_execution_reviews
    (tenant_id,account_id,case_id,upload_id,review_id,history_proof_id,request_hash,request_json,subjects_hash,subjects_json,receipt_hash,receipt_json,recorded_by,recorded_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb,$11,$12::jsonb,$13,$14)`,
        [
          input.tenantId,
          input.accountId,
          input.caseId,
          input.uploadId,
          input.reviewId,
          input.historyProofId,
          hashContext(input),
          JSON.stringify(input),
          hashContext(checked.subjects),
          JSON.stringify(checked.subjects),
          hashContext(receipt),
          JSON.stringify(receipt),
          login,
          new Date(at)
        ]
      )
      return { receipt, current: { state: 'current', canRelease: false }, canRelease: false }
    })
  }
}
