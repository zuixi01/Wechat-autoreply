import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { AccountAuthority, tokenHash, type Scope } from '../auth/account-authority'
import { readRestoreReview, RestoreReviewError } from '../admin/restore-review'
import { readRestoreDecision } from '../admin/restore-decisions'
import { readCompleteRestoreInventory } from '../admin/restore-inventory'
import { hashContext } from '../../../src/core/reply/hashes'
import {
  RestoreApplicationLookupSchema,
  RestoreApplicationCurrentSchema,
  RestoreApplicationDecisionSchema,
  RestoreLocalApplicationReceiptSchema,
  RestoreApplicationAckSchema,
  type RestoreApplicationAck,
  type RestoreApplicationDecision
} from '../../../src/shared/contracts/restore-application'
export class RestoreApplicationError extends Error {
  constructor(readonly code: 'RESTORE_APPLICATION_CONFLICT' | 'RESTORE_APPLICATION_NOT_READY') {
    super(code)
    this.name = 'RestoreApplicationError'
  }
}
/** Read-only preparation under the existing authenticated account lock; never releases recovery. */
export class RestoreApplicationAuthority {
  constructor(private readonly authority: AccountAuthority) {}
  async latest(credential: string, raw: unknown): Promise<RestoreApplicationDecision> {
    const input = RestoreApplicationCurrentSchema.parse(raw)
    return this.authority.withLockedAccount(
      credential,
      async (db, scope) => {
        await db.query(
          "SELECT set_config('app.restore_read_credential_hash',$1,true),set_config('app.restore_read_case_id',$2,true)",
          [tokenHash(credential), input.caseId]
        )
        await db.query('SET LOCAL ROLE autoreply_restore_reader')
        const row = (
          await db.query(
            'SELECT receipt_json,receipt_hash FROM ledger_restore_decisions WHERE tenant_id=$1 AND account_id=$2 AND case_id=$3 ORDER BY recorded_at DESC,decision_id DESC LIMIT 1',
            [scope.tenant_id, scope.account_id, input.caseId]
          )
        ).rows[0]
        if (!row) throw new RestoreApplicationError('RESTORE_APPLICATION_NOT_READY')
        const lookup = RestoreApplicationLookupSchema.parse({
          ...input,
          uploadId: row.receipt_json.uploadId,
          decisionId: row.receipt_json.decisionId,
          decisionHash: row.receipt_hash
        })
        return this.current(db, scope, credential, lookup)
      },
      true
    )
  }
  async decision(credential: string, raw: unknown): Promise<RestoreApplicationDecision> {
    const input = RestoreApplicationLookupSchema.parse(raw)
    return this.authority.withLockedAccount(
      credential,
      (db, scope) => this.current(db, scope, credential, input),
      true
    )
  }
  private async current(
    db: PoolClient,
    scope: Scope,
    credential: string,
    input: z.infer<typeof RestoreApplicationLookupSchema>
  ): Promise<RestoreApplicationDecision> {
    const ready = (
      await db.query(
        `SELECT paused,
        EXISTS(SELECT 1 FROM account_leases WHERE tenant_id=$1 AND account_id=$2 AND expires_at>clock_timestamp()) AS lease_live,
        EXISTS(SELECT 1 FROM execution_permits WHERE tenant_id=$1 AND account_id=$2 AND status='issued' AND (expires_at IS NULL OR expires_at>clock_timestamp())) AS permit_live
        FROM accounts WHERE tenant_id=$1 AND id=$2`,
        [scope.tenant_id, scope.account_id]
      )
    ).rows[0]
    if (!ready?.paused || ready.lease_live || ready.permit_live)
      throw new RestoreApplicationError('RESTORE_APPLICATION_NOT_READY')
    await db.query(
      "SELECT set_config('app.restore_read_credential_hash',$1,true),set_config('app.restore_read_case_id',$2,true),set_config('app.restore_account_id',$3,true),set_config('app.restore_agent_id',$4,true)",
      [tokenHash(credential), input.caseId, scope.account_id, scope.agent_id]
    )
    await db.query('SET LOCAL ROLE autoreply_restore_reader')
    const s = { tenant_id: scope.tenant_id, actor_id: scope.agent_id }
    try {
      const review = await readRestoreReview(db, s, scope.account_id, input.caseId)
      if (
        review.agentId !== scope.agent_id ||
        review.restoreId !== input.restoreId ||
        review.contextHash !== input.contextHash
      )
        throw new RestoreApplicationError('RESTORE_APPLICATION_CONFLICT')
      const checked = await readRestoreDecision(
        db,
        s,
        scope.account_id,
        input.caseId,
        input.uploadId,
        input.decisionId
      )
      if (!checked.currentBasis || hashContext(checked.decision) !== input.decisionHash)
        throw new RestoreApplicationError('RESTORE_APPLICATION_CONFLICT')
      const inventory = await readCompleteRestoreInventory(
        db,
        s,
        scope.account_id,
        input.caseId,
        input.uploadId
      )
      return RestoreApplicationDecisionSchema.parse({
        scope,
        decision: checked.decision,
        decisionHash: input.decisionHash,
        manifest: inventory.manifest,
        canRelease: false
      })
    } catch (error) {
      if (error instanceof RestoreReviewError || error instanceof z.ZodError)
        throw new RestoreApplicationError('RESTORE_APPLICATION_CONFLICT')
      throw error
    }
  }
  async acknowledge(credential: string, raw: unknown): Promise<RestoreApplicationAck> {
    const application = RestoreLocalApplicationReceiptSchema.parse(raw),
      applicationHash = hashContext(application)
    return this.authority.withLockedAccount(
      credential,
      async (db, scope) => {
        if (hashContext(scope) !== hashContext(application.scope))
          throw new RestoreApplicationError('RESTORE_APPLICATION_CONFLICT')
        const role = String((await db.query('SELECT current_user AS role')).rows[0].role)
        const decision = await this.current(
          db,
          scope,
          credential,
          RestoreApplicationLookupSchema.parse({
            caseId: application.caseId,
            uploadId: application.uploadId,
            decisionId: application.decisionId,
            restoreId: application.restoreId,
            contextHash: application.contextHash,
            decisionHash: application.decisionHash
          })
        )
        const inventory = await readCompleteRestoreInventory(
          db,
          { tenant_id: scope.tenant_id, actor_id: scope.agent_id },
          scope.account_id,
          application.caseId,
          application.uploadId
        )
        const controls = new Set(
          inventory.items.map(({ local }) =>
            hashContext({
              tenantId: local.identity.tenantId,
              accountId: local.identity.accountId,
              platform: local.identity.platform,
              conversationId: local.conversationId
            })
          )
        )
        if (
          application.inventoryBasisHash !== decision.manifest.basisHash ||
          application.quarantinedInboundCount !== decision.manifest.summary.unhandledInbound ||
          application.ownedConversationCount !== controls.size
        )
          throw new RestoreApplicationError('RESTORE_APPLICATION_CONFLICT')
        // Restore only the database-supplied original role, after all protected reads.
        await db.query('SET LOCAL ROLE "' + role.replaceAll('"', '""') + '"')
        const rows = (
          await db.query(
            'SELECT * FROM ledger_restore_application_acks WHERE tenant_id=$1 AND account_id=$2 AND case_id=$3',
            [scope.tenant_id, scope.account_id, application.caseId]
          )
        ).rows
        let existing: RestoreApplicationAck | undefined
        for (const row of rows) {
          const saved = RestoreLocalApplicationReceiptSchema.parse(row.application_json),
            ack = RestoreApplicationAckSchema.parse(row.ack_json)
          if (
            row.application_hash !== hashContext(saved) ||
            row.ack_hash !== hashContext(ack) ||
            saved.applicationId !== row.application_id ||
            saved.decisionId !== row.decision_id ||
            saved.caseId !== row.case_id ||
            saved.scope.agent_id !== row.agent_id ||
            hashContext(saved.scope) !== hashContext(scope) ||
            ack.applicationId !== saved.applicationId ||
            ack.applicationHash !== row.application_hash ||
            ack.caseId !== saved.caseId ||
            ack.decisionId !== saved.decisionId ||
            ack.restoreId !== saved.restoreId ||
            ack.contextHash !== saved.contextHash ||
            hashContext(ack.scope) !== hashContext(saved.scope) ||
            ack.recordedAt !== new Date(row.recorded_at).getTime()
          )
            throw new RestoreApplicationError('RESTORE_APPLICATION_CONFLICT')
          if (
            saved.applicationId === application.applicationId ||
            saved.decisionId === application.decisionId
          ) {
            if (hashContext(saved) !== applicationHash)
              throw new RestoreApplicationError('RESTORE_APPLICATION_CONFLICT')
            existing = ack
          }
        }
        if (existing) return existing
        const now = Number(
          (await db.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now'))
            .rows[0].now
        )
        if (application.appliedAt > now)
          throw new RestoreApplicationError('RESTORE_APPLICATION_CONFLICT')
        const ack = RestoreApplicationAckSchema.parse({
          acknowledgementId: randomUUID(),
          applicationId: application.applicationId,
          applicationHash,
          scope,
          caseId: application.caseId,
          decisionId: application.decisionId,
          restoreId: application.restoreId,
          contextHash: application.contextHash,
          recordedAt: now,
          status: 'quarantine_recorded',
          externalEvidenceRequired: true,
          automaticStart: false,
          canRelease: false
        })
        await db.query(
          `INSERT INTO ledger_restore_application_acks(tenant_id,account_id,case_id,agent_id,application_id,decision_id,application_hash,application_json,ack_hash,ack_json,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb,$11)`,
          [
            scope.tenant_id,
            scope.account_id,
            application.caseId,
            scope.agent_id,
            application.applicationId,
            application.decisionId,
            applicationHash,
            JSON.stringify(application),
            hashContext(ack),
            JSON.stringify(ack),
            new Date(now)
          ]
        )
        await db.query(
          `INSERT INTO audit_events(tenant_id,id,actor_id,kind,account_id,details_json) VALUES($1,$2,$3,'ledger_restore_quarantine_recorded',$4,$5::jsonb)`,
          [
            scope.tenant_id,
            randomUUID(),
            scope.agent_id,
            scope.account_id,
            JSON.stringify({
              applicationId: application.applicationId,
              applicationHash,
              acknowledgementId: ack.acknowledgementId,
              caseId: application.caseId,
              decisionId: application.decisionId
            })
          ]
        )
        return ack
      },
      true
    )
  }
}
