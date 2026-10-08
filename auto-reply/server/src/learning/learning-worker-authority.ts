import { z } from 'zod'
import type { PoolClient } from 'pg'
import type { Postgres } from '../database/postgres'
import { AuthorityError, type Scope } from '../auth/account-authority'
import type { LearningAccountAuthority } from './learning-account'
import { learningHash } from '../../../src/core/memory/learning-scope'

const ScopeSchema = z.strictObject({
  tenant_id: z.string().min(1),
  employee_id: z.string().min(1),
  account_id: z.string().min(1),
  agent_id: z.string().min(1),
  platform: z.enum(['wechat', 'wework'])
})

/** The authenticated database login, not a UUID or device credential, grants worker authority. */
export class EnterpriseLearningWorkerAuthority implements LearningAccountAuthority {
  constructor(private readonly db: Postgres) {}

  async references(): Promise<string[]> {
    try {
      const rows = await this.db.pool.query(
        'SELECT id::text FROM autoreply.learning_worker_references()'
      )
      return z
        .array(z.strictObject({ id: z.string().uuid() }))
        .parse(rows.rows)
        .map((row) => row.id)
    } catch {
      throw new AuthorityError('DENIED')
    }
  }

  private async authenticate(reference: string, client?: PoolClient): Promise<Scope> {
    if (!z.string().uuid().safeParse(reference).success) throw new AuthorityError('DENIED')
    try {
      const result = await (client ?? this.db.pool).query(
        'SELECT * FROM autoreply.authenticate_learning_worker($1::uuid,$2)',
        [reference, Boolean(client)]
      )
      return ScopeSchema.parse(result.rows[0])
    } catch {
      throw new AuthorityError('DENIED')
    }
  }

  async withLockedAccount<T>(
    reference: string,
    operation: (client: PoolClient, scope: Scope) => Promise<T>,
    allowPaused = false
  ): Promise<T> {
    const scope = await this.authenticate(reference)
    return this.db.transaction(scope.tenant_id, async (client) => {
      const current = await this.authenticate(reference, client)
      if (learningHash(scope) !== learningHash(current)) throw new AuthorityError('DENIED')
      await client.query("SELECT set_config('app.learning_account_id',$1,true)", [scope.account_id])
      const account = await client.query(
        'SELECT paused FROM accounts WHERE tenant_id=$1 AND id=$2',
        [scope.tenant_id, scope.account_id]
      )
      if (!account.rows.length) throw new AuthorityError('DENIED')
      if (account.rows[0].paused && !allowPaused) throw new AuthorityError('PAUSED')
      return operation(client, current)
    })
  }
}
