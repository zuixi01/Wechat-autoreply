import type { PoolClient } from 'pg'
import type { Publication } from './publication'
import { hashContext } from '../../../src/core/reply/hashes'
import { preQuestions, auditQuestions } from '../reply/jev-pipeline'
import { EMPTY_ENTERPRISE_MEMORY_VERSION } from '../learning/learning-publication'

export const EVALUATION_METHOD = 'paired-conversation-v1-seed534-replicates2000'
/** Only the reference is excluded; every executable setting and knowledge byte is bound. */
export function evaluationSnapshotHash(p: Publication): string {
  const publication = { ...p, configuration: { ...p.configuration } }
  // The authoritative paired catalogue fields bind this projection; its duplicate in device sync is canonicalized.
  delete publication.configuration.memoryCorpusVersion
  // An implicit and explicit empty catalogue are the same legacy execution behavior.
  if (
    (publication.memoryCorpusVersion ?? EMPTY_ENTERPRISE_MEMORY_VERSION) ===
      EMPTY_ENTERPRISE_MEMORY_VERSION &&
    !publication.memoryManifest?.length
  ) {
    delete publication.memoryCorpusVersion
    delete publication.memoryManifest
  }
  delete publication.evaluationApprovalId
  return hashContext({
    publication,
    questionHash: hashContext({ pre: preQuestions(), post: auditQuestions() }),
    evaluationMethod: EVALUATION_METHOD
  })
}

export async function evaluationAuthorized(
  db: PoolClient,
  scope: { tenant_id: string; account_id: string },
  p: Publication
): Promise<boolean> {
  if (!p.configuration.automaticEnabled) return true
  if (!p.evaluationApprovalId) return false
  const result = await db.query(
    `SELECT a.snapshot_hash,a.report_hash,a.report_json FROM evaluation_approvals a
    JOIN evaluation_runs r ON (r.tenant_id,r.account_id,r.id)=(a.tenant_id,a.account_id,a.run_id)
    JOIN employees reviewer ON (reviewer.tenant_id,reviewer.id)=(a.tenant_id,a.approved_by)
    JOIN employees adjudicator ON (adjudicator.tenant_id,adjudicator.id)=(a.tenant_id,a.adjudicated_by)
    WHERE a.tenant_id=$1 AND a.account_id=$2 AND a.id=$3 AND a.revoked_at IS NULL
      AND a.expires_at>clock_timestamp() AND r.expires_at>clock_timestamp()
      AND r.snapshot_hash=a.snapshot_hash AND reviewer.enabled AND reviewer.role='admin'
      AND adjudicator.enabled AND a.approved_by<>a.adjudicated_by`,
    [scope.tenant_id, scope.account_id, p.evaluationApprovalId]
  )
  const a = result.rows[0]
  return (
    !!a &&
    a.snapshot_hash === evaluationSnapshotHash(p) &&
    a.report_hash === hashContext(a.report_json) &&
    a.report_json?.method === EVALUATION_METHOD &&
    a.report_json?.metrics?.assessment?.status === 'observed_targets_met'
  )
}
