import type { PoolClient } from 'pg'

export async function hasUnappliedRequestSeals(
  db: Pick<PoolClient, 'query'>,
  tenant: string,
  account: string
): Promise<boolean> {
  return !!(
    await db.query(
      `SELECT 1 FROM execution_request_seals s WHERE tenant_id=$1 AND account_id=$2
    AND NOT EXISTS(SELECT 1 FROM execution_request_seal_applications a WHERE
      (a.tenant_id,a.account_id,a.seal_id)=(s.tenant_id,s.account_id,s.id) AND a.seal_hash=s.seal_hash AND a.agent_id=s.agent_id) LIMIT 1`,
      [tenant, account]
    )
  ).rowCount
}
