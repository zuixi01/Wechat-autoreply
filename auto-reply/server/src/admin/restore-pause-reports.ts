import type { PoolClient } from 'pg'
import { z } from 'zod'
import {
  RestorePauseReportSchema,
  type RestorePauseReport
} from '../../../src/shared/contracts/restoration'
import { hashContext } from '../../../src/core/reply/hashes'
import { readRestoreFrontier, RestoreReviewError, type RestoreReview } from './restore-review'

const Page = z.strictObject({
  after: z.uuid().optional(),
  limit: z.number().int().min(1).max(100).default(50)
})
type Scope = { tenant_id: string; actor_id: string }
export interface RestorePauseReceipt {
  caseId: string
  challengeId: string
  reportHash: string
  restoreId: string
  agentId: string
  contextHash: string
  frontierHash: string
  instanceId: string
  runtimeGeneration: number
  stoppedAt: number
  observedAt: number
  recordedAt: number
  declarationKind: 'target_main_process'
  receiptStatus: 'target_pause_report_recorded'
  requiresReconciliation: true
}
export type RestorePauseDetail = RestorePauseReceipt & { report: RestorePauseReport }
interface Row {
  challenge_id: string
  agent_id: string
  report_hash: string
  report_json: unknown
  recorded_at: Date
  case_id: string
  nonce_agent_id: string
  challenge_hash: string
  challenge_json: unknown
  issued_at: Date
  expires_at: Date
}
const Columns = `SELECT r.challenge_id,r.agent_id,r.report_hash,r.report_json,r.recorded_at,
  c.case_id,c.agent_id AS nonce_agent_id,c.challenge_hash,c.challenge_json,c.issued_at,c.expires_at
  FROM ledger_restore_pause_reports r JOIN ledger_restore_challenges c
  ON (c.tenant_id,c.account_id,c.id)=(r.tenant_id,r.account_id,r.challenge_id)
  WHERE r.tenant_id=$1 AND r.account_id=$2 AND c.case_id=$3`
function validate(
  row: Row,
  scope: Scope,
  accountId: string,
  review: RestoreReview,
  frontierHash: string
): { receipt: RestorePauseReceipt; report: RestorePauseReport } {
  try {
    const report = RestorePauseReportSchema.parse(row.report_json)
    const c = report.challenge,
      recordedAt = new Date(row.recorded_at).getTime()
    const { contextHash, ...descriptor } = c.context
    if (
      hashContext(report) !== row.report_hash ||
      hashContext(c) !== row.challenge_hash ||
      hashContext(c) !== hashContext(row.challenge_json) ||
      c.challengeId !== row.challenge_id ||
      c.caseId !== row.case_id ||
      c.caseId !== review.caseId ||
      c.scope.tenant_id !== scope.tenant_id ||
      c.scope.account_id !== accountId ||
      c.scope.agent_id !== row.agent_id ||
      row.agent_id !== row.nonce_agent_id ||
      row.agent_id !== review.agentId ||
      c.context.restoreId !== review.restoreId ||
      contextHash !== review.contextHash ||
      hashContext(descriptor) !== contextHash ||
      c.frontierHash !== frontierHash ||
      new Date(row.issued_at).getTime() !== c.issuedAt ||
      new Date(row.expires_at).getTime() !== c.expiresAt ||
      !Number.isSafeInteger(recordedAt) ||
      recordedAt < report.observedAt
    )
      throw Error('invalid')
    return {
      receipt: {
        caseId: c.caseId,
        challengeId: c.challengeId,
        reportHash: row.report_hash,
        restoreId: c.context.restoreId,
        agentId: c.scope.agent_id,
        contextHash,
        frontierHash,
        instanceId: report.instanceId,
        runtimeGeneration: report.runtimeGeneration,
        stoppedAt: report.stoppedAt,
        observedAt: report.observedAt,
        recordedAt,
        declarationKind: 'target_main_process',
        receiptStatus: 'target_pause_report_recorded',
        requiresReconciliation: true
      },
      report
    }
  } catch {
    throw new RestoreReviewError('RESTORE_REVIEW_CONFLICT')
  }
}
/** Authenticated administrator, account lock and tenant transaction supplied by caller. */
export async function readRestorePauseReceipts(
  db: PoolClient,
  scope: Scope,
  accountId: string,
  caseId: string,
  input: unknown
): Promise<RestorePauseReceipt[]> {
  const page = Page.parse(input)
  const { review, frontierHash } = await readRestoreFrontier(db, scope, accountId, caseId)
  const result = await db.query<Row>(
    `${Columns} AND ($4::uuid IS NULL OR r.challenge_id>$4::uuid) ORDER BY r.challenge_id LIMIT $5`,
    [scope.tenant_id, accountId, caseId, page.after ?? null, page.limit]
  )
  return result.rows.map((row) => validate(row, scope, accountId, review, frontierHash).receipt)
}
export async function readRestorePauseDetail(
  db: PoolClient,
  scope: Scope,
  accountId: string,
  caseId: string,
  challengeId: string
): Promise<RestorePauseDetail> {
  const { review, frontierHash } = await readRestoreFrontier(db, scope, accountId, caseId)
  const result = await db.query<Row>(`${Columns} AND r.challenge_id=$4`, [
    scope.tenant_id,
    accountId,
    caseId,
    challengeId
  ])
  if (!result.rows[0]) throw new RestoreReviewError('RESTORE_REVIEW_NOT_FOUND')
  const { receipt, report } = validate(result.rows[0], scope, accountId, review, frontierHash)
  return { ...receipt, report }
}
