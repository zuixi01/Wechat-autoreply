import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { readVerifiedRestoreHistoryEvidence } from '../admin/restore-history'
import {
  parseRestoreObservationGrant,
  type RestoreObservationGrant
} from '../../../src/shared/contracts/restore-observation'
import type { PoolClient } from 'pg'
import type { Scope } from '../auth/account-authority'
import { AccountAuthority, tokenHash } from '../auth/account-authority'
import { readRestoreReview } from '../admin/restore-review'
import { readVerifiedRestoreRecoveryAuthorization } from '../recovery/restore-recovery-authorization'
import { hashContext } from '../../../src/core/reply/hashes'
import {
  RestoreResolutionLookupSchema,
  parseRestoreResolutionPackage,
  type RestoreResolutionPackage
} from '../../../src/shared/contracts/restore-resolution'
import { readCompleteRestoreAssessment } from '../admin/restore-assessment'
import { readVerifiedRestoreExecutionReview } from '../recovery/restore-execution-maintenance'
import { readRestoreResolutionEvidence } from '../recovery/restore-resolution-basis'
import {
  RestoreRecoveryCurrentSchema,
  RestoreRecoveryPackageSchema,
  type RestoreRecoveryPackage
} from '../../../src/shared/contracts/restore-recovery'

export class RestoreRecoveryTargetError extends Error {
  constructor(
    readonly code: 'RESTORE_RECOVERY_TARGET_CONFLICT' | 'RESTORE_RECOVERY_TARGET_NOT_READY'
  ) {
    super(code)
  }
}
/** Read-only exact-target preparation. No completion or permit is issued here. */
export class RestoreRecoveryAuthority {
  constructor(private readonly authority: AccountAuthority) {}
  async latest(credential: string, raw: unknown): Promise<RestoreRecoveryPackage> {
    const input = RestoreRecoveryCurrentSchema.parse(raw)
    return this.withPackage(credential, input, async (_db, _scope, p) => p)
  }
  async resolutions(credential: string, raw: unknown): Promise<RestoreResolutionPackage> {
    const input = RestoreResolutionLookupSchema.parse(raw)
    return this.withPackage(
      credential,
      { caseId: input.caseId, restoreId: input.restoreId, contextHash: input.contextHash },
      async (db, scope, p) => {
        const a = p.authorization,
          s = { tenant_id: scope.tenant_id, actor_id: scope.agent_id }
        if (a.authorizationId !== input.authorizationId)
          throw new RestoreRecoveryTargetError('RESTORE_RECOVERY_TARGET_CONFLICT')
        const review = await readVerifiedRestoreExecutionReview(
            db,
            s,
            scope.account_id,
            input.caseId,
            a.reviewId
          ),
          assessment = await readCompleteRestoreAssessment(
            db,
            s,
            scope.account_id,
            input.caseId,
            a.uploadId
          ),
          now = Number(
            (
              await db.query(
                'SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now'
              )
            ).rows[0].now
          ),
          evidence = await readRestoreResolutionEvidence(
            db,
            s,
            assessment,
            review.input,
            p.boundary.history,
            now
          )
        if (
          review.record.current.state !== 'current' ||
          evidence.basis.resolutionBasisHash !== a.resolutionBasisHash
        )
          throw new RestoreRecoveryTargetError('RESTORE_RECOVERY_TARGET_NOT_READY')
        return parseRestoreResolutionPackage(
          {
            formatVersion: 1,
            authorizationId: a.authorizationId,
            authorizationHash: hashContext(a),
            boundaryHash: a.boundaryHash,
            resolutionBasisHash: a.resolutionBasisHash,
            review: review.input,
            reviewReceipt: review.record.receipt,
            subjects: evidence.subjects,
            localExecutions: evidence.localExecutions,
            records: evidence.records,
            automaticStart: false,
            canRelease: false
          },
          p
        )
      }
    )
  }
  async observationGrant(credential: string, raw: unknown): Promise<RestoreObservationGrant> {
    const input = RestoreResolutionLookupSchema.parse(raw)
    return this.withPackage(credential, input, async (db, scope, p) => {
      const a = p.authorization
      if (a.authorizationId !== input.authorizationId)
        throw new RestoreRecoveryTargetError('RESTORE_RECOVERY_TARGET_CONFLICT')
      const history = await readVerifiedRestoreHistoryEvidence(
        db,
        { tenant_id: scope.tenant_id, actor_id: scope.agent_id },
        scope.account_id,
        input.caseId,
        a.historyProofId
      )
      const sourceTrust = history.requirement.sourceTrust
      if (
        history.record.current.state !== 'current' ||
        sourceTrust.stableSourceOrderVerified !== true
      )
        throw new RestoreRecoveryTargetError('RESTORE_RECOVERY_TARGET_NOT_READY')
      const issuedAt = Number(
        (await db.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now'))
          .rows[0].now
      )
      return parseRestoreObservationGrant(
        {
          formatVersion: 1,
          grantId: randomUUID(),
          authorizationId: a.authorizationId,
          authorizationHash: hashContext(a),
          boundaryHash: a.boundaryHash,
          restoreId: a.restoreId,
          contextHash: a.contextHash,
          sourceTrust,
          sourceTrustHash: hashContext(sourceTrust),
          issuedAt,
          expiresAt: Math.min(issuedAt + 300000, a.expiresAt, sourceTrust.notAfter),
          automaticStart: false,
          canRelease: false
        },
        p
      )
    })
  }
  private async withPackage<T>(
    credential: string,
    input: z.infer<typeof RestoreRecoveryCurrentSchema>,
    read: (db: PoolClient, scope: Scope, p: RestoreRecoveryPackage) => Promise<T>
  ): Promise<T> {
    return this.authority.withLockedAccount(
      credential,
      async (db, scope) => {
        const account = (
          await db.query('SELECT paused FROM accounts WHERE tenant_id=$1 AND id=$2', [
            scope.tenant_id,
            scope.account_id
          ])
        ).rows[0]
        if (!account?.paused)
          throw new RestoreRecoveryTargetError('RESTORE_RECOVERY_TARGET_NOT_READY')
        await db.query(
          "SELECT set_config('app.restore_read_credential_hash',$1,true),set_config('app.restore_read_case_id',$2,true),set_config('app.restore_account_id',$3,true),set_config('app.restore_agent_id',$4,true)",
          [tokenHash(credential), input.caseId, scope.account_id, scope.agent_id]
        )
        await db.query('SET LOCAL ROLE autoreply_restore_reader')
        try {
          const s = { tenant_id: scope.tenant_id, actor_id: scope.agent_id },
            review = await readRestoreReview(db, s, scope.account_id, input.caseId)
          if (
            review.agentId !== scope.agent_id ||
            review.restoreId !== input.restoreId ||
            review.contextHash !== input.contextHash
          )
            throw new RestoreRecoveryTargetError('RESTORE_RECOVERY_TARGET_CONFLICT')
          const row = (
            await db.query(
              'SELECT authorization_id FROM ledger_restore_recovery_authorizations WHERE tenant_id=$1 AND account_id=$2 AND case_id=$3 ORDER BY recorded_at DESC,authorization_id DESC LIMIT 1',
              [scope.tenant_id, scope.account_id, input.caseId]
            )
          ).rows[0]
          if (!row) throw new RestoreRecoveryTargetError('RESTORE_RECOVERY_TARGET_NOT_READY')
          const verified = await readVerifiedRestoreRecoveryAuthorization(
            db,
            s,
            scope.account_id,
            input.caseId,
            row.authorization_id
          )
          if (verified.record.current.state !== 'current')
            throw new RestoreRecoveryTargetError('RESTORE_RECOVERY_TARGET_NOT_READY')
          const result = RestoreRecoveryPackageSchema.parse({
            authorization: verified.record.receipt,
            boundary: verified.boundary
          })
          if (
            hashContext(result.authorization.scope) !== hashContext(scope) ||
            result.authorization.restoreId !== input.restoreId ||
            result.authorization.contextHash !== input.contextHash
          )
            throw new RestoreRecoveryTargetError('RESTORE_RECOVERY_TARGET_CONFLICT')
          if (Buffer.byteLength(JSON.stringify(result)) > 2097152)
            throw new RestoreRecoveryTargetError('RESTORE_RECOVERY_TARGET_NOT_READY')
          return await read(db, scope, result)
        } catch (error) {
          if (error instanceof RestoreRecoveryTargetError) throw error
          if (error instanceof z.ZodError)
            throw new RestoreRecoveryTargetError('RESTORE_RECOVERY_TARGET_CONFLICT')
          // No upstream metadata/error payload or maintenance credentials cross the API.
          throw new RestoreRecoveryTargetError('RESTORE_RECOVERY_TARGET_NOT_READY')
        }
      },
      true
    )
  }
}
