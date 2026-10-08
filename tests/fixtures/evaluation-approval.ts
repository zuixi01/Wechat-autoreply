import { randomUUID } from 'node:crypto'
import type { Publication } from '../../server/src/generation/publication'
import { hashContext } from '../../src/core/reply/hashes'
import {
  EVALUATION_METHOD,
  evaluationSnapshotHash
} from '../../server/src/generation/evaluation-authorization'
import type { embeddedPostgres } from './embedded-postgres'

/** Privileged, synthetic fixture for generation tests. This deliberately bypasses
 * admission and is NOT a business evaluation or an example for operators. */
export async function seedSyntheticApproval(
  db: Pick<Awaited<ReturnType<typeof embeddedPostgres>>, 'adminQuery'>,
  p: Publication,
  tenantId = 'company',
  accountId = 'account-A'
): Promise<Publication> {
  if (!p.configuration.automaticEnabled) return p
  const id = randomUUID(),
    runId = randomUUID(),
    snapshot = evaluationSnapshotHash(p)
  const old = await db.adminQuery(
    'SELECT id FROM evaluation_approvals WHERE tenant_id=$1 AND account_id=$2 AND snapshot_hash=$3 AND revoked_at IS NULL AND expires_at>clock_timestamp()',
    [tenantId, accountId, snapshot]
  )
  if (old.rows[0]) return { ...p, evaluationApprovalId: (old.rows[0] as { id: string }).id }
  await db.adminQuery(
    `INSERT INTO employees(tenant_id,id,role) VALUES($1,'synthetic-reviewer','admin'),($1,'synthetic-adjudicator','employee') ON CONFLICT DO NOTHING`,
    [tenantId]
  )
  await db.adminQuery(
    `INSERT INTO evaluation_runs(tenant_id,account_id,id,snapshot_hash,publication_json,plan_json,created_by)
    VALUES($1,$2,$3,$4,$5::jsonb,'{}','synthetic-reviewer')`,
    [tenantId, accountId, runId, snapshot, JSON.stringify(p)]
  )
  const report = {
    method: EVALUATION_METHOD,
    metrics: { assessment: { status: 'observed_targets_met' } },
    fixtureOnly: true
  }
  await db.adminQuery(
    `INSERT INTO evaluation_approvals(tenant_id,account_id,id,run_id,snapshot_hash,dataset_hash,report_hash,report_json,approved_by,adjudicated_by,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'synthetic-reviewer','synthetic-adjudicator',clock_timestamp()+interval '1 day')`,
    [
      tenantId,
      accountId,
      id,
      runId,
      snapshot,
      hashContext('synthetic-fixture'),
      hashContext(report),
      JSON.stringify(report)
    ]
  )
  return { ...p, evaluationApprovalId: id }
}
