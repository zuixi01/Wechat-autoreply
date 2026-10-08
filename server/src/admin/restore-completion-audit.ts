import type { PoolClient } from 'pg'
import { hashContext } from '../../../src/core/reply/hashes'
import { Id } from '../../../src/shared/contracts/identity'
import {
  RestoreRecoveryCompletionInputSchema,
  parseRestoreRecoveryCompletionInput,
  parseRestoreRecoveryCompletionReceipt
} from '../../../src/shared/contracts/restore-completion'
import { RestoreRecoveryPackageSchema } from '../../../src/shared/contracts/restore-recovery'
import { parseRestoreResolutionPackage } from '../../../src/shared/contracts/restore-resolution'
import { readVerifiedRestoreRecoveryAuthorization } from '../recovery/restore-recovery-authorization'
import { readVerifiedRestoreExecutionReview } from '../recovery/restore-execution-maintenance'
import { readRestoreResolutionEvidence } from '../recovery/restore-resolution-basis'
import { readCompleteRestoreAssessment } from './restore-assessment'
import { readRestoreReview } from './restore-review'
import { readVerifiedRestoreHistoryEvidence } from './restore-history'
import { lockRestoreHistoryKey, restoreHistoryKeySha256 } from '../recovery/restore-history-key'

export class RestoreCompletionAuditError extends Error {
  readonly code = 'RESTORE_COMPLETION_AUDIT_CONFLICT'
  constructor() {
    super('RESTORE_COMPLETION_AUDIT_CONFLICT')
  }
}
type CaseState =
  | 'awaiting_authorization'
  | 'awaiting_declaration'
  | 'awaiting_current_evidence'
  | 'ready_for_independent_review'
export interface RestoreCompletionAudit {
  tenantId: string
  accountId: string
  basisHash: string
  cases: {
    caseId: string
    restoreId: string
    contextHash: string
    agentId: string
    reviewHash: string
    authorizationId: string | null
    completionId: string | null
    requestHash: string | null
    receiptHash: string | null
    provenanceHash: string | null
    provenanceCount: number | null
    state: CaseState
  }[]
  readyCases: number
  pendingCases: number
  allCasesPrepared: boolean
  preparedUntil: number | null
  finalAdmissionRequired: true
  physicalDurabilityVerifiedByThisRead: false
  automaticStart: false
  canRelease: false
}
function conflict(): never {
  throw new RestoreCompletionAuditError()
}

/** Caller authenticates the administrator and locks the account. No row or fence is changed. */
export async function readRestoreCompletionAudit(
  db: PoolClient,
  scope: { tenant_id: string; actor_id: string },
  accountId: string
): Promise<RestoreCompletionAudit> {
  accountId = Id.parse(accountId)
  const reviews = (
      await db.query(
        'SELECT id FROM ledger_restore_reviews WHERE tenant_id=$1 AND account_id=$2 ORDER BY id',
        [scope.tenant_id, accountId]
      )
    ).rows,
    cases: RestoreCompletionAudit['cases'] = [],
    readyUntil = new Map<string, number>()
  let encodedBytes = 2
  // Several cases may use different source keys shared with another account.
  // Acquire canonical DER key locks in one order before any per-case reader.
  const sourceKeys = (
    await db.query(
      `SELECT q.requirement_json->'sourceTrust'->>'publicKeyPem' AS pem
      FROM (SELECT DISTINCT ON (case_id) * FROM ledger_restore_recovery_authorizations
        WHERE tenant_id=$1 AND account_id=$2 ORDER BY case_id,recorded_at DESC,authorization_id DESC) a
      JOIN ledger_restore_history_proofs h ON (h.tenant_id,h.account_id,h.case_id)=(a.tenant_id,a.account_id,a.case_id)
        AND h.proof_id=(a.receipt_json->>'historyProofId')::uuid
      JOIN ledger_restore_history_requirements q ON (q.tenant_id,q.account_id,q.case_id,q.id)=(h.tenant_id,h.account_id,h.case_id,h.requirement_id)`,
      [scope.tenant_id, accountId]
    )
  ).rows.map((r) => restoreHistoryKeySha256(String(r.pem)))
  for (const sha of [...new Set(sourceKeys)].sort()) await lockRestoreHistoryKey(db, sha)
  for (const row of reviews) {
    const review = await readRestoreReview(db, scope, accountId, row.id),
      authorization = (
        await db.query(
          `SELECT authorization_id FROM ledger_restore_recovery_authorizations
          WHERE tenant_id=$1 AND account_id=$2 AND case_id=$3 ORDER BY recorded_at DESC,authorization_id DESC LIMIT 1`,
          [scope.tenant_id, accountId, review.caseId]
        )
      ).rows[0],
      item: RestoreCompletionAudit['cases'][number] = {
        caseId: review.caseId,
        restoreId: review.restoreId,
        contextHash: review.contextHash,
        agentId: review.agentId,
        reviewHash: hashContext(review),
        authorizationId: authorization?.authorization_id ?? null,
        completionId: null,
        requestHash: null,
        receiptHash: null,
        provenanceHash: null,
        provenanceCount: null,
        state: 'awaiting_authorization'
      }
    if (authorization) {
      const completion = (
        await db.query(
          `SELECT * FROM ledger_restore_recovery_completions
          WHERE tenant_id=$1 AND account_id=$2 AND case_id=$3 AND authorization_id=$4`,
          [scope.tenant_id, accountId, review.caseId, authorization.authorization_id]
        )
      ).rows[0]
      item.state = 'awaiting_declaration'
      if (completion) {
        const input = RestoreRecoveryCompletionInputSchema.parse(completion.request_json),
          ack = parseRestoreRecoveryCompletionReceipt(completion.receipt_json, input),
          b = input.boundaryApplication
        if (
          completion.request_hash !== hashContext(input) ||
          completion.receipt_hash !== hashContext(ack) ||
          completion.completion_id !== input.completionId ||
          completion.authorization_id !== b.authorizationId ||
          completion.agent_id !== review.agentId ||
          b.caseId !== review.caseId ||
          b.scope.tenant_id !== scope.tenant_id ||
          b.scope.account_id !== accountId ||
          b.scope.agent_id !== review.agentId ||
          b.restoreId !== review.restoreId ||
          b.contextHash !== review.contextHash ||
          new Date(completion.recorded_at).getTime() !== ack.recordedAt
        )
          conflict()
        const verified = await readVerifiedRestoreRecoveryAuthorization(
            db,
            scope,
            accountId,
            review.caseId,
            b.authorizationId
          ),
          p = RestoreRecoveryPackageSchema.parse({
            authorization: verified.record.receipt,
            boundary: verified.boundary
          }),
          a = p.authorization,
          execution = await readVerifiedRestoreExecutionReview(
            db,
            scope,
            accountId,
            review.caseId,
            a.reviewId
          ),
          history = await readVerifiedRestoreHistoryEvidence(
            db,
            scope,
            accountId,
            review.caseId,
            a.historyProofId
          ),
          assessment = await readCompleteRestoreAssessment(
            db,
            scope,
            accountId,
            review.caseId,
            a.uploadId
          ),
          now = Number(
            (
              await db.query(
                'SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now'
              )
            ).rows[0].now
          ),
          evidence = await readRestoreResolutionEvidence(
            db,
            scope,
            assessment,
            execution.input,
            p.boundary.history,
            now
          ),
          resolutions = parseRestoreResolutionPackage(
            {
              formatVersion: 1,
              authorizationId: a.authorizationId,
              authorizationHash: hashContext(a),
              boundaryHash: a.boundaryHash,
              resolutionBasisHash: a.resolutionBasisHash,
              review: execution.input,
              reviewReceipt: execution.record.receipt,
              subjects: evidence.subjects,
              localExecutions: evidence.localExecutions,
              records: evidence.records,
              automaticStart: false,
              canRelease: false
            },
            p
          )
        parseRestoreRecoveryCompletionInput(input, p, resolutions)
        if (input.observationGrant.sourceTrustHash !== hashContext(history.requirement.sourceTrust))
          conflict()
        item.completionId = input.completionId
        item.requestHash = hashContext(input)
        item.receiptHash = hashContext(ack)
        item.provenanceHash = hashContext(input.provenance)
        item.provenanceCount = input.provenance.length
        item.state =
          verified.record.current.state === 'current' &&
          execution.record.current.state === 'current' &&
          history.record.current.state === 'current'
            ? 'ready_for_independent_review'
            : 'awaiting_current_evidence'
        readyUntil.set(item.caseId, Math.min(a.expiresAt, history.requirement.sourceTrust.notAfter))
      }
    }
    // Refuse an oversized complete audit; never silently return a first page as the account.
    encodedBytes += Buffer.byteLength(JSON.stringify(item)) + Number(cases.length > 0)
    if (encodedBytes > 1048576) conflict()
    cases.push(item)
  }
  // A large audit must not retain readiness sampled before an earlier case expired.
  const completedAt = Number(
    (
      await db.query(
        'SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS completed_at'
      )
    ).rows[0].completed_at
  )
  for (const item of cases)
    if (
      item.state === 'ready_for_independent_review' &&
      completedAt >= readyUntil.get(item.caseId)!
    )
      item.state = 'awaiting_current_evidence'
  const readyCases = cases.filter((c) => c.state === 'ready_for_independent_review').length,
    basis = { tenantId: scope.tenant_id, accountId, cases }
  return {
    ...basis,
    basisHash: hashContext(basis),
    readyCases,
    pendingCases: cases.length - readyCases,
    allCasesPrepared: cases.length > 0 && readyCases === cases.length,
    preparedUntil:
      cases.length > 0 && readyCases === cases.length ? Math.min(...readyUntil.values()) : null,
    finalAdmissionRequired: true,
    physicalDurabilityVerifiedByThisRead: false,
    automaticStart: false,
    canRelease: false
  }
}
