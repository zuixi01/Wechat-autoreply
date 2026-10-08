import type { PoolClient } from 'pg'
import type { Scope } from '../auth/account-authority'
import type { EnterpriseLearningUsage } from './learning-queue'

export async function learningForegroundWithin(
  db: PoolClient,
  scope: Scope
): Promise<{ at: number; revision: number; running: boolean }> {
  const keys = [scope.tenant_id, scope.account_id]
  const row = (
    await db.query(
      'SELECT last_activity_at,revision FROM learning_foreground_activity WHERE tenant_id=$1 AND account_id=$2',
      keys
    )
  ).rows[0]
  const running = !!(
    await db.query(
      "SELECT 1 FROM generation_tasks WHERE tenant_id=$1 AND account_id=$2 AND status='running' AND expires_at>clock_timestamp() LIMIT 1",
      keys
    )
  ).rowCount
  return { at: Number(row?.last_activity_at ?? 0), revision: Number(row?.revision ?? 0), running }
}
/** All purposes use the same account UTC ledger, including anonymous totals after forgetting. */
export async function learningUsageWithin(
  db: PoolClient,
  scope: Scope,
  at: number
): Promise<EnterpriseLearningUsage> {
  const day = new Date(at).toISOString().slice(0, 10)
  const row = (
    await db.query(
      `SELECT COALESCE(SUM(charged_tokens),0)::text AS reserved,COALESCE(SUM(input_tokens),0)::text AS input,
    COALESCE(SUM(output_tokens),0)::text AS output,COALESCE(SUM(requests),0)::text AS requests,
    COALESCE(SUM(estimated_requests),0)::text AS estimated,COALESCE(SUM(reported_requests),0)::text AS reported FROM (
    SELECT charged_tokens,input_tokens,output_tokens,CASE WHEN measurement<>'not_dispatched' THEN 1 ELSE 0 END AS requests,
      CASE WHEN measurement='upper_bound' THEN 1 ELSE 0 END AS estimated_requests,CASE WHEN measurement='reported' THEN 1 ELSE 0 END AS reported_requests
      FROM learning_attempts WHERE tenant_id=$1 AND account_id=$2 AND day=$3::date
    UNION ALL SELECT charged_tokens,input_tokens,output_tokens,requests,estimated_requests,reported_requests FROM learning_retained_usage WHERE tenant_id=$1 AND account_id=$2 AND day=$3::date
    ) AS costs`,
      [scope.tenant_id, scope.account_id, day]
    )
  ).rows[0]
  return {
    day,
    reservedTokens: Number(row.reserved),
    inputTokens: Number(row.input),
    outputTokens: Number(row.output),
    requests: Number(row.requests),
    estimatedRequests: Number(row.estimated),
    reportedRequests: Number(row.reported)
  }
}
/** Any worker can reclaim an expired global slot; fees remain reserved until measured. */
export async function expireLearningLeaseWithin(
  db: PoolClient,
  scope: Scope,
  token: string,
  at: number
): Promise<void> {
  const keys = [scope.tenant_id, scope.account_id, token]
  await db.query(
    `UPDATE learning_attempts SET state='timed_out',failure_code='lease_expired'
    WHERE tenant_id=$1 AND account_id=$2 AND state='running' AND (claim_token=$3 OR validation_run_id IN
      (SELECT id FROM learning_validation_runs WHERE tenant_id=$1 AND account_id=$2 AND claim_token=$3))`,
    keys
  )
  await db.query(
    "UPDATE learning_validation_runs SET state='timed_out',finished_at=$4 WHERE tenant_id=$1 AND account_id=$2 AND claim_token=$3 AND state='running'",
    [...keys, at]
  )
}
