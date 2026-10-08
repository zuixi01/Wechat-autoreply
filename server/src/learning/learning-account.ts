import { z } from 'zod'
import type { PoolClient } from 'pg'
import type { AccountAuthority, Scope } from '../auth/account-authority'
import {
  LearningSettingsSchema,
  type LearningSettings
} from '../../../src/shared/contracts/learning-memory'

const Id = z.string().trim().min(1).max(128)
export type LearningAccountAuthority = Pick<AccountAuthority, 'withLockedAccount'>
/** Account identity and time are supplied by the host, never by an HTTP payload. */
export function withLearningAccount<T>(
  authority: LearningAccountAuthority,
  credential: string,
  conversationId: string | null,
  operation: (db: PoolClient, scope: Scope, conversation: string, at: number) => Promise<T>,
  clock?: () => number
): Promise<T> {
  const conversation = conversationId === null ? '' : Id.parse(conversationId)
  return authority.withLockedAccount(
    credential,
    async (db, scope) => {
      await db.query("SELECT set_config('app.learning_account_id',$1,true)", [scope.account_id])
      const at = clock
        ? clock()
        : Number(
            (
              await db.query(
                'SELECT floor(extract(epoch from clock_timestamp())*1000)::text AS now'
              )
            ).rows[0].now
          )
      z.number().int().nonnegative().safe().parse(at)
      return operation(db, scope, conversation, at)
    },
    true
  )
}

export async function effectiveLearningSettings(
  db: PoolClient,
  scope: Pick<Scope, 'tenant_id' | 'account_id'>,
  conversation: string
): Promise<LearningSettings> {
  const rows = (
    await db.query(
      'SELECT conversation_id,payload FROM learning_settings WHERE tenant_id=$1 AND account_id=$2 AND conversation_id=ANY($3::text[])',
      [scope.tenant_id, scope.account_id, [...new Set(['', conversation])]]
    )
  ).rows
  const parent = LearningSettingsSchema.parse(
    rows.find((row) => row.conversation_id === '')?.payload ?? {}
  )
  const value = LearningSettingsSchema.parse({
    ...parent,
    ...(rows.find((row) => row.conversation_id === conversation)?.payload ?? {})
  })
  if (conversation) {
    if (parent.mode === 'off') value.mode = 'off'
    if (!parent.memoryEnabled) value.memoryEnabled = false
    if (!parent.curationEnabled) value.curationEnabled = false
  }
  return value
}

/** A monotonic sequence detects preemption even when start/end share one clock millisecond. */
export async function recordLearningForegroundWithin(
  db: PoolClient,
  scope: Pick<Scope, 'tenant_id' | 'account_id'>,
  at?: number
): Promise<void> {
  await db.query("SELECT set_config('app.learning_account_id',$1,true)", [scope.account_id])
  const stamp =
    at ??
    Number(
      (await db.query('SELECT floor(extract(epoch from clock_timestamp())*1000)::text AS now'))
        .rows[0].now
    )
  await db.query(
    `INSERT INTO learning_foreground_activity(tenant_id,account_id,last_activity_at) VALUES($1,$2,$3)
    ON CONFLICT(tenant_id,account_id) DO UPDATE SET last_activity_at=GREATEST(learning_foreground_activity.last_activity_at,excluded.last_activity_at),revision=learning_foreground_activity.revision+1`,
    [scope.tenant_id, scope.account_id, stamp]
  )
}
