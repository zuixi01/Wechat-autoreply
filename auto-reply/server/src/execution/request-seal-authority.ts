import { randomUUID } from 'node:crypto'
import { AccountAuthority, type Scope } from '../auth/account-authority'
import { ReconciliationError } from './reconciliation-authority'
import {
  RequestSealInputSchema,
  RequestSealSchema,
  RequestSealAppliedSchema,
  parseRequestSealResult,
  type RequestSealResult,
  type RequestSealAck
} from '../../../src/shared/contracts/request-seal'
import { hashContext } from '../../../src/core/reply/hashes'
import { requestNonDispatchProof } from '../../../src/core/sending/request-seal-proof'
import { permitFromRow } from './execution-authority'
import type { PoolClient } from 'pg'

/** Negative authority only. No approval, dispatch, receipt rewrite or resume. */
export class RequestSealAuthority {
  constructor(private readonly authority: AccountAuthority) {}
  async seal(credential: string, value: unknown): Promise<RequestSealResult> {
    const input = RequestSealInputSchema.parse(structuredClone(value)),
      requestHash = hashContext(input)
    return this.authority.withLockedAccount(
      credential,
      async (db, s) => {
        const i = input.identity
        if (
          i.tenantId !== s.tenant_id ||
          i.employeeId !== s.employee_id ||
          i.accountId !== s.account_id ||
          i.agentId !== s.agent_id ||
          i.platform !== s.platform ||
          input.verificationProofHash !==
            requestNonDispatchProof({
              executionId: input.executionId,
              identity: i,
              request: input.request
            })
        )
          throw new ReconciliationError('RECONCILIATION_CONFLICT')
        const old = await db.query(
          'SELECT request_hash,seal_hash,seal_json FROM execution_request_seals WHERE tenant_id=$1 AND account_id=$2 AND task_id=$3',
          [s.tenant_id, s.account_id, input.request.taskId]
        )
        if (old.rows[0]) {
          if (old.rows[0].request_hash !== requestHash)
            throw new ReconciliationError('RECONCILIATION_CONFLICT')
          const seal = RequestSealSchema.parse(old.rows[0].seal_json)
          if (
            hashContext(seal) !== old.rows[0].seal_hash ||
            hashContext(seal.input) !== requestHash
          )
            throw new ReconciliationError('RECONCILIATION_INCOMPLETE')
          return parseRequestSealResult({ status: 'request_sealed', seal }, input, requestHash)
        }
        await this.ready(db, s)
        const reviewed = await db.query(
          'SELECT agent_id,task_hash,draft_hash,draft_revision FROM reviewed_replies WHERE tenant_id=$1 AND account_id=$2 AND task_id=$3',
          [s.tenant_id, s.account_id, input.request.taskId]
        )
        if (
          reviewed.rows[0] &&
          (reviewed.rows[0].agent_id !== s.agent_id ||
            reviewed.rows[0].task_hash !== input.request.taskHash ||
            reviewed.rows[0].draft_hash !== input.request.draftHash ||
            Number(reviewed.rows[0].draft_revision) !== input.request.draftRevision)
        )
          throw new ReconciliationError('RECONCILIATION_CONFLICT')
        const now = Number(
          (await db.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now'))
            .rows[0].now
        )
        if (input.stopped.stoppedAt > now) throw new ReconciliationError('RECONCILIATION_CONFLICT')
        const found = await db.query(
          'SELECT * FROM execution_permits WHERE tenant_id=$1 AND account_id=$2 AND task_id=$3',
          [s.tenant_id, s.account_id, input.request.taskId]
        )
        if (found.rows[0]) {
          const p = found.rows[0]
          if (p.agent_id !== s.agent_id || new Date(p.expires_at).getTime() > now)
            throw new ReconciliationError('RECONCILIATION_NOT_READY')
          try {
            return parseRequestSealResult(
              { status: 'existing_permit', permit: permitFromRow(p, s, false) },
              input,
              requestHash
            )
          } catch {
            throw new ReconciliationError('RECONCILIATION_CONFLICT')
          }
        }
        const seal = RequestSealSchema.parse({
          sealId: randomUUID(),
          input,
          requestHash,
          sealedAt: now
        })
        await db.query(
          `INSERT INTO execution_request_seals(tenant_id,account_id,id,agent_id,task_id,request_hash,seal_hash,seal_json,sealed_at,execution_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,to_timestamp($9/1000.0),$10)`,
          [
            s.tenant_id,
            s.account_id,
            seal.sealId,
            s.agent_id,
            input.request.taskId,
            requestHash,
            hashContext(seal),
            JSON.stringify(seal),
            now,
            input.executionId
          ]
        )
        await this.audit(db, s, 'execution_request_sealed', { sealId: seal.sealId, requestHash })
        return { status: 'request_sealed', seal }
      },
      true
    )
  }

  async applied(credential: string, value: unknown): Promise<RequestSealAck> {
    const input = RequestSealAppliedSchema.parse(value)
    return this.authority.withLockedAccount(
      credential,
      async (db, s) => {
        const found = await db.query(
          'SELECT agent_id,request_hash,seal_hash,seal_json FROM execution_request_seals WHERE tenant_id=$1 AND account_id=$2 AND id=$3',
          [s.tenant_id, s.account_id, input.sealId]
        )
        const r = found.rows[0]
        if (!r) throw new ReconciliationError('RECONCILIATION_NOT_FOUND')
        const seal = RequestSealSchema.parse(r.seal_json)
        if (
          r.agent_id !== s.agent_id ||
          r.request_hash !== input.requestHash ||
          r.seal_hash !== input.sealHash ||
          hashContext(seal) !== input.sealHash ||
          hashContext(seal.input) !== input.requestHash ||
          seal.input.executionId !== input.executionId
        )
          throw new ReconciliationError('RECONCILIATION_CONFLICT')
        const old = await db.query(
          'SELECT agent_id,seal_hash,execution_id FROM execution_request_seal_applications WHERE tenant_id=$1 AND account_id=$2 AND seal_id=$3',
          [s.tenant_id, s.account_id, input.sealId]
        )
        if (old.rows[0]) {
          if (
            old.rows[0].agent_id !== s.agent_id ||
            old.rows[0].seal_hash !== input.sealHash ||
            old.rows[0].execution_id !== input.executionId
          )
            throw new ReconciliationError('RECONCILIATION_CONFLICT')
        } else {
          await this.ready(db, s)
          await db.query(
            'INSERT INTO execution_request_seal_applications(tenant_id,account_id,seal_id,agent_id,seal_hash,execution_id) VALUES($1,$2,$3,$4,$5,$6)',
            [s.tenant_id, s.account_id, input.sealId, s.agent_id, input.sealHash, input.executionId]
          )
          await this.audit(db, s, 'execution_request_seal_applied', {
            sealId: input.sealId,
            sealHash: input.sealHash
          })
        }
        return { ...input, status: 'request_seal_applied' }
      },
      true
    )
  }
  private async ready(db: PoolClient, s: Scope): Promise<void> {
    const found = await db.query(
      `SELECT paused,EXISTS(SELECT 1 FROM account_leases WHERE tenant_id=$1 AND account_id=$2 AND expires_at>clock_timestamp()) AS lease_live FROM accounts WHERE tenant_id=$1 AND id=$2`,
      [s.tenant_id, s.account_id]
    )
    if (!found.rows[0]?.paused || found.rows[0].lease_live)
      throw new ReconciliationError('RECONCILIATION_NOT_READY')
  }
  private async audit(db: PoolClient, s: Scope, kind: string, details: unknown): Promise<void> {
    await db.query(
      'INSERT INTO audit_events(tenant_id,id,actor_id,kind,account_id,details_json) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
      [s.tenant_id, randomUUID(), s.agent_id, kind, s.account_id, JSON.stringify(details)]
    )
  }
}
