import type { PoolClient } from 'pg'
import type { Scope } from '../auth/account-authority'

/** Caller holds the account lock; privacy cleanup and invalidation share its transaction. */
export async function invalidateLearningPreparations(
  db: PoolClient,
  scope: Scope,
  conversation: string,
  methodIds: string[] = []
): Promise<void> {
  await db.query(
    `DELETE FROM learning_preparations p WHERE tenant_id=$1 AND account_id=$2
      AND ($3='' OR conversation_id=$3 OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(p.selection_json->'methods') ref WHERE ref->>'id'=ANY($4::text[])
      ))`,
    [scope.tenant_id, scope.account_id, conversation, methodIds]
  )
  // Even forgetting an empty scope revokes snapshots; deleting data alone cannot express that event.
  await db.query(
    `INSERT INTO learning_context_epochs VALUES($1,$2,$3,1)
      ON CONFLICT(tenant_id,account_id,conversation_id) DO UPDATE SET version=learning_context_epochs.version+1`,
    [scope.tenant_id, scope.account_id, conversation]
  )
}
