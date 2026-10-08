import type { PoolClient } from 'pg'
import type { Scope } from '../auth/account-authority'
import { learningHash } from '../../../src/core/memory/learning-scope'
import { discardEvaluationCheckpointsWithin } from './learning-evaluation-checkpoint'

/** Called inside the existing authenticated account transaction. No customer identifiers survive in fee totals. */
export async function forgetLearningQueue(
  db: PoolClient,
  scope: Pick<Scope, 'tenant_id' | 'account_id'>,
  conversation: string
): Promise<void> {
  const at = Number(
    (await db.query('SELECT floor(extract(epoch from clock_timestamp())*1000)::text AS now'))
      .rows[0].now
  )
  await discardEvaluationCheckpointsWithin(db, scope, at)
  const keys = [scope.tenant_id, scope.account_id, conversation]
  const runs = (
    await db.query(
      'SELECT source_id,claim_token FROM learning_validation_runs WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3',
      keys
    )
  ).rows
  for (const run of runs) {
    await db.query(
      "INSERT INTO learning_tombstones VALUES($1,$2,$3,'validation_run',$4,floor(extract(epoch from clock_timestamp())*1000)) ON CONFLICT DO NOTHING",
      [...keys, learningHash(String(run.source_id))]
    )
    await db.query(
      'DELETE FROM learning_background_leases WHERE tenant_id=$1 AND account_id=$2 AND claim_token=$3',
      [scope.tenant_id, scope.account_id, run.claim_token]
    )
  }
  await db.query(
    `INSERT INTO learning_retained_usage
    SELECT tenant_id,account_id,day,SUM(charged_tokens),SUM(input_tokens),SUM(output_tokens),
      SUM(CASE WHEN measurement<>'not_dispatched' THEN 1 ELSE 0 END),
      SUM(CASE WHEN measurement='upper_bound' THEN 1 ELSE 0 END),SUM(CASE WHEN measurement='reported' THEN 1 ELSE 0 END)
    FROM learning_attempts WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3 GROUP BY tenant_id,account_id,day
    ON CONFLICT(tenant_id,account_id,day) DO UPDATE SET charged_tokens=learning_retained_usage.charged_tokens+excluded.charged_tokens,
      input_tokens=learning_retained_usage.input_tokens+excluded.input_tokens,output_tokens=learning_retained_usage.output_tokens+excluded.output_tokens,
      requests=learning_retained_usage.requests+excluded.requests,estimated_requests=learning_retained_usage.estimated_requests+excluded.estimated_requests,
      reported_requests=learning_retained_usage.reported_requests+excluded.reported_requests`,
    keys
  )
  await db.query(
    'DELETE FROM learning_background_leases WHERE tenant_id=$1 AND account_id=$2 AND claim_token IN (SELECT claim_token FROM learning_attempts WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3)',
    keys
  )
  await db.query(
    'DELETE FROM learning_attempts WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3',
    keys
  )
  await db.query(
    'DELETE FROM learning_jobs WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3',
    keys
  )
  await db.query(
    'DELETE FROM learning_validation_runs WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=$3',
    keys
  )
}
