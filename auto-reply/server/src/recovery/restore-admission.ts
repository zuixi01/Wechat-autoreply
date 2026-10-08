import type { Postgres } from '../database/postgres'
import { authenticateRestoreMaintenance } from './restore-history-maintenance'
import { readRestoreCompletionAudit } from '../admin/restore-completion-audit'
import { hashContext } from '../../../src/core/reply/hashes'
import {
  RestoreAdmissionApprovalInputSchema,
  RestoreAdmissionReceiptSchema,
  type RestoreAdmissionReceipt
} from '../../../src/shared/contracts/restore-admission'
import { RestoreRecoveryCompletionInputSchema } from '../../../src/shared/contracts/restore-completion'
import { restoreHistoryKeySha256 } from './restore-history-key'

export class RestoreAdmissionError extends Error {
  constructor(readonly code: 'RESTORE_ADMISSION_CONFLICT' | 'RESTORE_ADMISSION_NOT_READY') {
    super(code)
  }
}
function conflict(): never {
  throw new RestoreAdmissionError('RESTORE_ADMISSION_CONFLICT')
}
function notReady(): never {
  throw new RestoreAdmissionError('RESTORE_ADMISSION_NOT_READY')
}
/** Independent whole-account review. Does not clear a local profile fence or start a worker. */
export class RestoreAdmissionMaintenance {
  constructor(private readonly database: Postgres) {}
  approve(raw: unknown): Promise<RestoreAdmissionReceipt> {
    if (Buffer.byteLength(JSON.stringify(raw) ?? '') > 16384) conflict()
    const input = RestoreAdmissionApprovalInputSchema.parse(raw)
    return this.database.transaction(input.tenantId, async (db) => {
      const login = await authenticateRestoreMaintenance(db),
        account = (
          await db.query('SELECT paused FROM accounts WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [
            input.tenantId,
            input.accountId
          ])
        ).rows[0]
      if (!account) conflict()
      const old = (
        await db.query(
          "SELECT *,encode(sha256(convert_to(jsonb_build_object('request',request_json,'receipt',receipt_json)::text,'UTF8')),'hex') AS actual_storage_hash FROM ledger_restore_admissions WHERE tenant_id=$1 AND account_id=$2 AND approval_id=$3",
          [input.tenantId, input.accountId, input.approvalId]
        )
      ).rows[0]
      if (old) {
        const original = RestoreAdmissionApprovalInputSchema.parse(old.request_json),
          receipt = RestoreAdmissionReceiptSchema.parse(old.receipt_json)
        if (
          old.actual_storage_hash !== old.storage_hash ||
          hashContext(input) !== old.request_hash ||
          hashContext(original) !== old.request_hash ||
          hashContext(receipt) !== old.receipt_hash ||
          receipt.requestHash !== old.request_hash ||
          receipt.auditBasisHash !== input.expectedBasisHash ||
          receipt.reviewedBy !== input.reviewedBy ||
          receipt.reviewedAt !== input.reviewedAt ||
          receipt.evidenceSha256 !== input.evidenceSha256 ||
          receipt.approvalId !== input.approvalId ||
          receipt.scope.tenant_id !== input.tenantId ||
          receipt.scope.account_id !== input.accountId ||
          receipt.recordedBy !== login ||
          old.recorded_by !== login ||
          new Date(old.recorded_at).getTime() !== receipt.recordedAt
        )
          conflict()
        // Original immutable review only; never turns a historical retry into current admission.
        return receipt
      }
      if (!account.paused) notReady()
      const audit = await readRestoreCompletionAudit(
        db,
        { tenant_id: input.tenantId, actor_id: login },
        input.accountId
      )
      if (!audit.allCasesPrepared || !audit.preparedUntil) notReady()
      if (audit.basisHash !== input.expectedBasisHash) conflict()
      const latest = (
        await db.query(
          'SELECT id FROM ledger_restore_reviews WHERE tenant_id=$1 AND account_id=$2 ORDER BY opened_at DESC,id DESC LIMIT 1',
          [input.tenantId, input.accountId]
        )
      ).rows[0]
      const current = audit.cases.find((c) => c.caseId === latest.id)!
      const completion = (
        await db.query(
          'SELECT request_json FROM ledger_restore_recovery_completions WHERE tenant_id=$1 AND account_id=$2 AND completion_id=$3',
          [input.tenantId, input.accountId, current.completionId]
        )
      ).rows[0]
      const prepared = RestoreRecoveryCompletionInputSchema.parse(completion.request_json)
      const keys = new Set<string>()
      for (const item of audit.cases) {
        const c = (
          await db.query(
            'SELECT request_json FROM ledger_restore_recovery_completions WHERE tenant_id=$1 AND account_id=$2 AND completion_id=$3',
            [input.tenantId, input.accountId, item.completionId]
          )
        ).rows[0]
        keys.add(
          restoreHistoryKeySha256(
            RestoreRecoveryCompletionInputSchema.parse(c.request_json).observationGrant.sourceTrust
              .publicKeyPem
          )
        )
        await db.query(
          'INSERT INTO ledger_restore_admission_cases(tenant_id,account_id,approval_id,case_id) VALUES($1,$2,$3,$4)',
          [input.tenantId, input.accountId, input.approvalId, item.caseId]
        )
      }
      for (const sha of [...keys].sort())
        await db.query(
          'INSERT INTO ledger_restore_admission_keys(tenant_id,account_id,approval_id,key_sha256) VALUES($1,$2,$3,$4)',
          [input.tenantId, input.accountId, input.approvalId, sha]
        )
      await db.query(
        'INSERT INTO ledger_restore_admission_permits SELECT tenant_id,account_id,$3,id FROM execution_permits WHERE tenant_id=$1 AND account_id=$2',
        [input.tenantId, input.accountId, input.approvalId]
      )
      await db.query(
        'INSERT INTO ledger_restore_admission_seals SELECT tenant_id,account_id,$3,id FROM execution_request_seals WHERE tenant_id=$1 AND account_id=$2',
        [input.tenantId, input.accountId, input.approvalId]
      )
      const sets = (
        await db.query(
          `SELECT
        (SELECT encode(sha256(convert_to(coalesce(jsonb_agg(permit_id ORDER BY permit_id),'[]'::jsonb)::text,'UTF8')),'hex') FROM ledger_restore_admission_permits WHERE tenant_id=$1 AND account_id=$2 AND approval_id=$3) AS permits,
        (SELECT encode(sha256(convert_to(coalesce(jsonb_agg(seal_id ORDER BY seal_id),'[]'::jsonb)::text,'UTF8')),'hex') FROM ledger_restore_admission_seals WHERE tenant_id=$1 AND account_id=$2 AND approval_id=$3) AS seals,
        floor(extract(epoch FROM clock_timestamp())*1000)::text AS now`,
          [input.tenantId, input.accountId, input.approvalId]
        )
      ).rows[0]
      const now = Number(sets.now)
      if (now >= audit.preparedUntil || input.reviewedAt > now || now - input.reviewedAt > 300000)
        notReady()
      const receipt = RestoreAdmissionReceiptSchema.parse({
        formatVersion: 1,
        approvalId: input.approvalId,
        requestHash: hashContext(input),
        auditBasisHash: audit.basisHash,
        scope: prepared.boundaryApplication.scope,
        restoreId: current.restoreId,
        contextHash: current.contextHash,
        provenanceHash: current.provenanceHash,
        cases: audit.cases,
        sourceKeyHashes: [...keys].sort(),
        permitSetStorageHash: sets.permits,
        sealSetStorageHash: sets.seals,
        reviewedBy: input.reviewedBy,
        reviewedAt: input.reviewedAt,
        evidenceSha256: input.evidenceSha256,
        recordedBy: login,
        recordedAt: now,
        status: 'account_restore_admission_approved',
        centralAdmissionApproved: true,
        localAdmissionRequired: true,
        physicalVerificationPerformedByThisCommand: false,
        automaticStart: false
      })
      if (Buffer.byteLength(JSON.stringify(receipt)) > 1048576) conflict()
      // Child FKs defer until commit. Inserting the sealed parent last distinguishes
      // initial membership from any later attempt to add authority to this review.
      await db.query(
        `INSERT INTO ledger_restore_admissions(tenant_id,account_id,approval_id,agent_id,request_hash,request_json,receipt_hash,receipt_json,storage_hash,recorded_by,recorded_at)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,encode(sha256(convert_to(jsonb_build_object('request',$6::jsonb,'receipt',$8::jsonb)::text,'UTF8')),'hex'),$9,$10)`,
        [
          input.tenantId,
          input.accountId,
          input.approvalId,
          receipt.scope.agent_id,
          hashContext(input),
          JSON.stringify(input),
          hashContext(receipt),
          JSON.stringify(receipt),
          login,
          new Date(now)
        ]
      )
      await db.query(
        `INSERT INTO audit_events(tenant_id,id,actor_id,kind,account_id,details_json) VALUES($1,$2,$3,'ledger_restore_admission_approved',$4,$5::jsonb)`,
        [
          input.tenantId,
          input.approvalId,
          login,
          input.accountId,
          JSON.stringify({
            approvalId: input.approvalId,
            auditBasisHash: audit.basisHash,
            receiptHash: hashContext(receipt),
            automaticStart: false
          })
        ]
      )
      if (
        !(
          await db.query('SELECT autoreply.restore_admission_current($1,$2,$3) AS current', [
            input.tenantId,
            input.accountId,
            receipt.scope.agent_id
          ])
        ).rows[0].current
      )
        notReady()
      return receipt
    })
  }
}
