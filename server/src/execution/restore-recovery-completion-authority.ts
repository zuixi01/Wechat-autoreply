import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { AccountAuthority, tokenHash } from '../auth/account-authority'
import { readVerifiedRestoreRecoveryAuthorization } from '../recovery/restore-recovery-authorization'
import { readVerifiedRestoreExecutionReview } from '../recovery/restore-execution-maintenance'
import { readVerifiedRestoreHistoryEvidence } from '../admin/restore-history'
import { readCompleteRestoreAssessment } from '../admin/restore-assessment'
import { readRestoreResolutionEvidence } from '../recovery/restore-resolution-basis'
import {
  RestoreRecoveryPackageSchema,
  RestoreRecoveryAuthorizationReceiptSchema
} from '../../../src/shared/contracts/restore-recovery'
import { parseRestoreResolutionPackage } from '../../../src/shared/contracts/restore-resolution'
import {
  RestoreRecoveryCompletionInputSchema,
  RestoreRecoveryCompletionReceiptSchema,
  parseRestoreRecoveryCompletionInput,
  parseRestoreRecoveryCompletionReceipt,
  type RestoreRecoveryCompletionReceipt
} from '../../../src/shared/contracts/restore-completion'
import { hashContext } from '../../../src/core/reply/hashes'
export class RestoreRecoveryCompletionError extends Error {
  constructor(readonly code: 'RESTORE_COMPLETION_CONFLICT' | 'RESTORE_COMPLETION_NOT_READY') {
    super(code)
  }
}
function conflict(): never {
  throw new RestoreRecoveryCompletionError('RESTORE_COMPLETION_CONFLICT')
}
function notReady(): never {
  throw new RestoreRecoveryCompletionError('RESTORE_COMPLETION_NOT_READY')
}
/** Records an authenticated target's exact durable declaration. Admission is a separate guard. */
export class RestoreRecoveryCompletionAuthority {
  constructor(private readonly authority: AccountAuthority) {}
  async acknowledge(credential: string, raw: unknown): Promise<RestoreRecoveryCompletionReceipt> {
    if (Buffer.byteLength(JSON.stringify(raw) ?? '') > 1048576) conflict()
    const input = RestoreRecoveryCompletionInputSchema.parse(raw),
      b = input.boundaryApplication,
      requestHash = hashContext(input)
    return this.authority.withLockedAccount(
      credential,
      async (db, scope) => {
        if (hashContext(scope) !== hashContext(b.scope)) conflict()
        await db.query(
          "SELECT set_config('app.restore_read_credential_hash',$1,true),set_config('app.restore_read_case_id',$2,true),set_config('app.restore_account_id',$3,true),set_config('app.restore_agent_id',$4,true)",
          [tokenHash(credential), b.caseId, scope.account_id, scope.agent_id]
        )
        const rows = (
          await db.query(
            `SELECT * FROM ledger_restore_recovery_completions WHERE tenant_id=$1 AND account_id=$2 AND (completion_id=$3 OR authorization_id=$4)`,
            [scope.tenant_id, scope.account_id, input.completionId, b.authorizationId]
          )
        ).rows
        if (rows.length > 1) conflict()
        if (rows[0]) {
          const row = rows[0],
            saved = RestoreRecoveryCompletionInputSchema.parse(row.request_json),
            ack = parseRestoreRecoveryCompletionReceipt(row.receipt_json, saved)
          if (
            row.request_hash !== hashContext(saved) ||
            row.receipt_hash !== hashContext(ack) ||
            row.request_hash !== requestHash ||
            row.completion_id !== saved.completionId ||
            row.authorization_id !== saved.boundaryApplication.authorizationId ||
            row.case_id !== b.caseId ||
            row.agent_id !== scope.agent_id ||
            hashContext(saved.boundaryApplication.scope) !== hashContext(scope) ||
            new Date(row.recorded_at).getTime() !== ack.recordedAt
          )
            conflict()
          const original = (
            await db.query(
              'SELECT * FROM autoreply.restore_completion_authorization($1,$2,$3,$4)',
              [scope.tenant_id, scope.account_id, b.caseId, b.authorizationId]
            )
          ).rows[0]
          if (!original) conflict()
          const authorization = RestoreRecoveryAuthorizationReceiptSchema.parse(
            original.receipt_json
          )
          if (
            hashContext(authorization) !== original.receipt_hash ||
            original.receipt_hash !== b.authorizationHash ||
            authorization.authorizationId !== b.authorizationId ||
            authorization.caseId !== b.caseId ||
            hashContext(authorization.scope) !== hashContext(scope)
          )
            conflict()
          // Lost-response retries return the original declaration, not a new freshness/release claim.
          return ack
        }
        const role = String((await db.query('SELECT current_user AS role')).rows[0].role)
        await db.query('SET LOCAL ROLE autoreply_restore_reader')
        let p: ReturnType<typeof RestoreRecoveryPackageSchema.parse>, now: number
        try {
          const s = { tenant_id: scope.tenant_id, actor_id: scope.agent_id },
            verified = await readVerifiedRestoreRecoveryAuthorization(
              db,
              s,
              scope.account_id,
              b.caseId,
              b.authorizationId
            )
          if (verified.record.current.state !== 'current') notReady()
          p = RestoreRecoveryPackageSchema.parse({
            authorization: verified.record.receipt,
            boundary: verified.boundary
          })
          if (hashContext(p.authorization.scope) !== hashContext(scope)) conflict()
          const a = p.authorization,
            execution = await readVerifiedRestoreExecutionReview(
              db,
              s,
              scope.account_id,
              b.caseId,
              a.reviewId
            ),
            history = await readVerifiedRestoreHistoryEvidence(
              db,
              s,
              scope.account_id,
              b.caseId,
              a.historyProofId
            ),
            assessment = await readCompleteRestoreAssessment(
              db,
              s,
              scope.account_id,
              b.caseId,
              a.uploadId
            )
          now = Number(
            (
              await db.query(
                'SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now'
              )
            ).rows[0].now
          )
          const evidence = await readRestoreResolutionEvidence(
              db,
              s,
              assessment,
              execution.input,
              p.boundary.history,
              now
            ),
            resolutions = parseRestoreResolutionPackage(
              {
                formatVersion: 1,
                authorizationId: a.authorizationId,
                authorizationHash: hashContext(a),
                boundaryHash: a.boundaryHash,
                resolutionBasisHash: a.resolutionBasisHash,
                review: execution.input,
                reviewReceipt: execution.record.receipt,
                subjects: evidence.subjects,
                localExecutions: evidence.localExecutions,
                records: evidence.records,
                automaticStart: false,
                canRelease: false
              },
              p
            )
          parseRestoreRecoveryCompletionInput(input, p, resolutions)
          if (
            input.observationGrant.sourceTrustHash !==
              hashContext(history.requirement.sourceTrust) ||
            history.record.current.state !== 'current' ||
            execution.record.current.state !== 'current' ||
            input.preparedAt > now ||
            now >= input.observationGrant.expiresAt
          )
            notReady()
        } catch (error) {
          if (error instanceof RestoreRecoveryCompletionError) throw error
          if (error instanceof Error && error.message === 'restore_completion_conflict') conflict()
          if (error instanceof z.ZodError) conflict()
          notReady()
        }
        await db.query('SET LOCAL ROLE "' + role.replaceAll('"', '""') + '"')
        const ack = RestoreRecoveryCompletionReceiptSchema.parse({
          formatVersion: 1,
          acknowledgementId: randomUUID(),
          completionId: input.completionId,
          requestHash,
          scope,
          caseId: b.caseId,
          authorizationId: b.authorizationId,
          authorizationHash: b.authorizationHash,
          restoreId: b.restoreId,
          contextHash: b.contextHash,
          boundaryApplicationHash: hashContext(b),
          resolutionApplicationHash: hashContext(input.resolutionApplication),
          provenanceHash: hashContext(input.provenance),
          provenanceCount: input.provenance.length,
          recordedAt: now!,
          status: 'durable_recovery_recorded',
          localDurabilityDeclared: true,
          localDurabilityVerifiedByServer: false,
          accountAdmissionRequired: true,
          automaticStart: false,
          canRelease: false
        })
        await db.query(
          `INSERT INTO ledger_restore_recovery_completions(tenant_id,account_id,case_id,agent_id,authorization_id,completion_id,request_hash,request_json,receipt_hash,receipt_json,recorded_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb,$11)`,
          [
            scope.tenant_id,
            scope.account_id,
            b.caseId,
            scope.agent_id,
            b.authorizationId,
            input.completionId,
            requestHash,
            JSON.stringify(input),
            hashContext(ack),
            JSON.stringify(ack),
            new Date(now!)
          ]
        )
        await db.query(
          `INSERT INTO audit_events(tenant_id,id,actor_id,kind,account_id,details_json) VALUES($1,$2,$3,'ledger_restore_durable_recovery_recorded',$4,$5::jsonb)`,
          [
            scope.tenant_id,
            randomUUID(),
            scope.agent_id,
            scope.account_id,
            JSON.stringify({
              completionId: input.completionId,
              requestHash,
              acknowledgementId: ack.acknowledgementId,
              authorizationId: b.authorizationId,
              caseId: b.caseId,
              provenanceHash: ack.provenanceHash,
              canRelease: false
            })
          ]
        )
        return ack
      },
      true
    )
  }
}
