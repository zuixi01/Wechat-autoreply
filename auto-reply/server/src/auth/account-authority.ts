import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { PoolClient } from 'pg'
import { IdentitySchema, type Identity } from '../../../src/shared/contracts/identity'
import type { LeaseGrant } from '../../../src/core/agent/lease-guard'
import { Postgres } from '../database/postgres'
import { hasUnappliedRequestSeals } from '../execution/request-seal-state'

export class AuthorityError extends Error {
  constructor(
    readonly code:
      | 'DENIED'
      | 'PAUSED'
      | 'LEASE_CONFLICT'
      | 'UNRESOLVED_EXECUTION'
      | 'UNRESOLVED_RESTORE'
      | 'INVALID_REQUEST'
  ) {
    super(code)
    this.name = 'AuthorityError'
  }
}
const ScopeSchema = z.object({
  tenant_id: z.string().min(1),
  employee_id: z.string().min(1),
  account_id: z.string().min(1),
  agent_id: z.string().min(1),
  platform: z.enum(['wechat', 'wework'])
})
export type Scope = z.infer<typeof ScopeSchema>
const Token = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
export function newCredential(): string {
  return randomBytes(32).toString('base64url')
}

/** Device authority is always read from the credential, never from a client's tenantId. */
export class AccountAuthority {
  constructor(
    private readonly db: Postgres,
    private readonly leaseMs = 10000
  ) {
    if (!Number.isInteger(leaseMs) || leaseMs < 1000 || leaseMs > 30000)
      throw new AuthorityError('INVALID_REQUEST')
  }

  async register(code: string, agentId: string): Promise<{ credential: string; scope: Scope }> {
    if (!Token.safeParse(code).success || !z.string().uuid().safeParse(agentId).success)
      throw new AuthorityError('INVALID_REQUEST')
    const credential = newCredential()
    try {
      const result = await this.db.pool.query(
        'SELECT * FROM autoreply.redeem_enrollment($1,$2,$3)',
        [tokenHash(code), agentId, tokenHash(credential)]
      )
      return { credential, scope: ScopeSchema.parse(result.rows[0]) }
    } catch {
      throw new AuthorityError('DENIED')
    }
  }

  async authenticate(credential: string): Promise<Scope> {
    if (!Token.safeParse(credential).success) throw new AuthorityError('DENIED')
    const result = await this.db.pool.query('SELECT * FROM autoreply.authenticate_device($1)', [
      tokenHash(credential)
    ])
    const scope = ScopeSchema.safeParse(result.rows[0])
    if (!scope.success) throw new AuthorityError('DENIED')
    return scope.data
  }

  async acquireLease(
    credential: string,
    loginEpoch: number,
    clientInstanceId: string
  ): Promise<LeaseGrant> {
    if (
      !z.number().int().nonnegative().safeParse(loginEpoch).success ||
      !z.string().min(1).max(128).safeParse(clientInstanceId).success
    )
      throw new AuthorityError('INVALID_REQUEST')
    const scope = await this.authenticate(credential)
    return this.db.transaction(scope.tenant_id, async (client) => {
      await this.lockAuthority(client, scope, credential)
      if (await hasUnappliedRequestSeals(client, scope.tenant_id, scope.account_id))
        throw new AuthorityError('UNRESOLVED_EXECUTION')
      const current = await client.query(
        `SELECT *, expires_at>clock_timestamp() AS live FROM account_leases
        WHERE tenant_id=$1 AND account_id=$2 FOR UPDATE`,
        [scope.tenant_id, scope.account_id]
      )
      const previous = current.rows[0]
      const sameHolder =
        previous &&
        previous.agent_id === scope.agent_id &&
        Number(previous.login_epoch) === loginEpoch &&
        previous.client_instance_id === clientInstanceId
      if (previous?.live && !sameHolder) throw new AuthorityError('LEASE_CONFLICT')
      // Same live holder may renew while settling an operation, but no expired lease can
      // be transferred until previously issued execution permits have been reconciled.
      if (!previous?.live) {
        const unresolved = await client.query(
          `SELECT 1 FROM execution_permits p WHERE tenant_id=$1 AND account_id=$2
          AND status IN ('issued','unknown') AND NOT EXISTS(SELECT 1 FROM reconciliation_decisions d
          JOIN reconciliation_applied a ON (a.tenant_id,a.account_id,a.decision_id)=(d.tenant_id,d.account_id,d.id)
          WHERE (d.tenant_id,d.account_id,d.permit_id)=(p.tenant_id,p.account_id,p.id)) LIMIT 1`,
          [scope.tenant_id, scope.account_id]
        )
        if (unresolved.rowCount) throw new AuthorityError('UNRESOLVED_EXECUTION')
      }
      const version =
        sameHolder && previous.live ? Number(previous.version) : Number(previous?.version ?? 0) + 1
      if (!Number.isSafeInteger(version)) throw new AuthorityError('INVALID_REQUEST')
      const updated = await client.query(
        `INSERT INTO account_leases(tenant_id,account_id,agent_id,login_epoch,client_instance_id,version,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+$7*interval '1 millisecond')
        ON CONFLICT(tenant_id,account_id) DO UPDATE SET agent_id=EXCLUDED.agent_id,login_epoch=EXCLUDED.login_epoch,
          client_instance_id=EXCLUDED.client_instance_id,version=EXCLUDED.version,expires_at=EXCLUDED.expires_at
        RETURNING floor(extract(epoch from clock_timestamp())*1000)::text AS issued,
          floor(extract(epoch from expires_at)*1000)::text AS expires`,
        [
          scope.tenant_id,
          scope.account_id,
          scope.agent_id,
          loginEpoch,
          clientInstanceId,
          version,
          this.leaseMs
        ]
      )
      const identity: Identity = IdentitySchema.parse({
        tenantId: scope.tenant_id,
        employeeId: scope.employee_id,
        accountId: scope.account_id,
        agentId: scope.agent_id,
        platform: scope.platform,
        loginEpoch,
        clientInstanceId
      })
      return {
        identity,
        leaseId: tokenHash(`${scope.tenant_id}:${scope.account_id}:${version}`),
        version,
        serverIssuedAt: Number(updated.rows[0].issued),
        expiresAt: Number(updated.rows[0].expires)
      }
    })
  }

  async heartbeat(credential: string): Promise<Scope> {
    return this.authenticate(credential)
  }

  /** Server-internal transaction boundary; every execution uses this same account lock. */
  async withLockedAccount<T>(
    credential: string,
    operation: (client: PoolClient, scope: Scope) => Promise<T>,
    allowPaused = false
  ): Promise<T> {
    const scope = await this.authenticate(credential)
    return this.db.transaction(scope.tenant_id, async (client) => {
      await this.lockAuthority(client, scope, credential, allowPaused)
      return operation(client, scope)
    })
  }

  private async lockAuthority(
    client: PoolClient,
    scope: Scope,
    credential: string,
    allowPaused = false
  ): Promise<void> {
    // All account changes acquire the account lock before device locks, including revoke.
    const account = await client.query(
      'SELECT enabled,paused FROM accounts WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
      [scope.tenant_id, scope.account_id]
    )
    if (!account.rows[0]?.enabled) throw new AuthorityError('DENIED')
    if (account.rows[0].paused && !allowPaused) throw new AuthorityError('PAUSED')
    const agent = await client.query(
      'SELECT token_hash,revoked_at FROM agents WHERE tenant_id=$1 AND id=$2 FOR SHARE',
      [scope.tenant_id, scope.agent_id]
    )
    if (
      !agent.rows[0] ||
      agent.rows[0].revoked_at ||
      agent.rows[0].token_hash !== tokenHash(credential)
    )
      throw new AuthorityError('DENIED')
    const employee = await client.query(
      'SELECT enabled FROM employees WHERE tenant_id=$1 AND id=$2 FOR SHARE',
      [scope.tenant_id, scope.employee_id]
    )
    if (!employee.rows[0]?.enabled) throw new AuthorityError('DENIED')
    if (!allowPaused) {
      await client.query("SELECT set_config('app.restore_admission_credential_hash',$1,true)", [
        tokenHash(credential)
      ])
      if (
        (
          await client.query('SELECT autoreply.restore_admission_pending($1,$2) AS pending', [
            scope.tenant_id,
            scope.account_id
          ])
        ).rows[0].pending
      )
        throw new AuthorityError('UNRESOLVED_RESTORE')
    }
  }
}

/** Administrative provisioning helper for trusted CLI/admin context. Not an unauthenticated HTTP route. */
export async function createEnrollment(
  db: Postgres,
  tenantId: string,
  accountId: string,
  employeeId: string
): Promise<string> {
  const code = newCredential()
  // Enrollment writes require the dedicated admin/migration role, not the API service role.
  await db.transaction(tenantId, async (client) => {
    await client.query(
      "INSERT INTO enrollment_codes(code_hash,tenant_id,account_id,employee_id,expires_at) VALUES($1,$2,$3,$4,clock_timestamp()+interval '10 minutes')",
      [tokenHash(code), tenantId, accountId, employeeId]
    )
    await client.query(
      'INSERT INTO audit_events(tenant_id,id,actor_id,kind,account_id) VALUES($1,$2,$3,$4,$5)',
      [tenantId, randomUUID(), 'admin-cli', 'enrollment_created', accountId]
    )
  })
  return code
}
