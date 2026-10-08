import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { AccountAuthority, type Scope } from '../auth/account-authority'
import { RestoreInventoryAuthority } from './restore-inventory-authority'
import { RestoreApplicationAuthority } from './restore-application-authority'
import { RestoreRecoveryAuthority } from './restore-recovery-authority'
import { RestoreRecoveryCompletionAuthority } from './restore-recovery-completion-authority'
import { readRestoreReview, readRestoreFrontier, type RestoreReview } from '../admin/restore-review'
import { hashContext } from '../../../src/core/reply/hashes'
import { DeviceScopeSchema } from '../../../src/shared/contracts/registration'
import {
  RestoreChallengeInputSchema,
  RestoreLookupInputSchema,
  RestoreLookupResultSchema,
  type RestoreLookupResult,
  RestorePauseChallengeSchema,
  RestorePauseReportSchema,
  type RestorePauseChallenge,
  type RestorePauseAck
} from '../../../src/shared/contracts/restoration'

export class RestorePauseError extends Error {
  constructor(
    readonly code: 'RESTORE_PAUSE_CONFLICT' | 'RESTORE_PAUSE_NOT_READY' | 'RESTORE_PAUSE_NOT_FOUND'
  ) {
    super(code)
    this.name = 'RestorePauseError'
  }
}
/** Records target runtime declarations, never resumes an account or settles a permit. */
export class RestorePauseAuthority {
  constructor(private readonly authority: AccountAuthority) {}
  recoveryAcknowledge(
    credential: string,
    input: unknown
  ): ReturnType<RestoreRecoveryCompletionAuthority['acknowledge']> {
    return new RestoreRecoveryCompletionAuthority(this.authority).acknowledge(credential, input)
  }
  recoveryObservationGrant(
    credential: string,
    input: unknown
  ): ReturnType<RestoreRecoveryAuthority['observationGrant']> {
    return new RestoreRecoveryAuthority(this.authority).observationGrant(credential, input)
  }
  recoveryResolutions(
    credential: string,
    input: unknown
  ): ReturnType<RestoreRecoveryAuthority['resolutions']> {
    return new RestoreRecoveryAuthority(this.authority).resolutions(credential, input)
  }
  recoveryLatest(
    credential: string,
    input: unknown
  ): ReturnType<RestoreRecoveryAuthority['latest']> {
    return new RestoreRecoveryAuthority(this.authority).latest(credential, input)
  }
  applicationLatest(
    credential: string,
    input: unknown
  ): ReturnType<RestoreApplicationAuthority['latest']> {
    return new RestoreApplicationAuthority(this.authority).latest(credential, input)
  }
  applicationAcknowledge(
    credential: string,
    input: unknown
  ): ReturnType<RestoreApplicationAuthority['acknowledge']> {
    return new RestoreApplicationAuthority(this.authority).acknowledge(credential, input)
  }
  applicationDecision(
    credential: string,
    input: unknown
  ): ReturnType<RestoreApplicationAuthority['decision']> {
    return new RestoreApplicationAuthority(this.authority).decision(credential, input)
  }
  inventoryStart(
    credential: string,
    input: unknown
  ): ReturnType<RestoreInventoryAuthority['start']> {
    return new RestoreInventoryAuthority(this.authority).start(credential, input)
  }
  inventoryPage(credential: string, input: unknown): ReturnType<RestoreInventoryAuthority['page']> {
    return new RestoreInventoryAuthority(this.authority).page(credential, input)
  }
  inventoryComplete(
    credential: string,
    input: unknown
  ): ReturnType<RestoreInventoryAuthority['complete']> {
    return new RestoreInventoryAuthority(this.authority).complete(credential, input)
  }
  private async scope(db: PoolClient, s: Scope): Promise<void> {
    await db.query(
      "SELECT set_config('app.restore_account_id',$1,true),set_config('app.restore_agent_id',$2,true)",
      [s.account_id, s.agent_id]
    )
  }
  private async review(db: PoolClient, s: Scope, caseId: string): Promise<RestoreReview> {
    try {
      const review = await readRestoreReview(
        db,
        { tenant_id: s.tenant_id, actor_id: s.agent_id },
        s.account_id,
        caseId
      )
      if (review.agentId !== s.agent_id) throw Error('wrong_target')
      return review
    } catch {
      throw new RestorePauseError('RESTORE_PAUSE_CONFLICT')
    }
  }
  private async ready(db: PoolClient, s: Scope): Promise<number> {
    const result = await db.query(
      `SELECT paused,floor(extract(epoch FROM clock_timestamp())*1000)::text AS now,
      EXISTS(SELECT 1 FROM account_leases WHERE tenant_id=$1 AND account_id=$2 AND expires_at>clock_timestamp()) AS lease_live,
      EXISTS(SELECT 1 FROM execution_permits WHERE tenant_id=$1 AND account_id=$2 AND status='issued' AND (expires_at IS NULL OR expires_at>clock_timestamp())) AS permit_live
      FROM accounts WHERE tenant_id=$1 AND id=$2`,
      [s.tenant_id, s.account_id]
    )
    const row = result.rows[0]
    if (!row?.paused || row.lease_live || row.permit_live)
      throw new RestorePauseError('RESTORE_PAUSE_NOT_READY')
    return Number(row.now)
  }
  private async frontier(db: PoolClient, s: Scope, caseId: string): Promise<string> {
    try {
      const frontier = await readRestoreFrontier(
        db,
        { tenant_id: s.tenant_id, actor_id: s.agent_id },
        s.account_id,
        caseId
      )
      if (frontier.review.agentId !== s.agent_id) throw Error('wrong_target')
      return frontier.frontierHash
    } catch {
      throw new RestorePauseError('RESTORE_PAUSE_CONFLICT')
    }
  }
  async lookup(credential: string, input: unknown): Promise<RestoreLookupResult> {
    const request = RestoreLookupInputSchema.parse(input)
    return this.authority.withLockedAccount(
      credential,
      async (db, s) => {
        await this.scope(db, s)
        const row = (
          await db.query(
            'SELECT id FROM ledger_restore_reviews WHERE tenant_id=$1 AND account_id=$2 AND agent_id=$3 AND restore_id=$4',
            [s.tenant_id, s.account_id, s.agent_id, request.restoreId]
          )
        ).rows[0]
        if (!row) throw new RestorePauseError('RESTORE_PAUSE_CONFLICT')
        const review = await this.review(db, s, row.id)
        if (review.contextHash !== request.contextHash)
          throw new RestorePauseError('RESTORE_PAUSE_CONFLICT')
        return RestoreLookupResultSchema.parse({
          ...request,
          caseId: review.caseId,
          scope: DeviceScopeSchema.parse(s)
        })
      },
      true
    )
  }
  async challenge(credential: string, input: unknown): Promise<RestorePauseChallenge> {
    const request = RestoreChallengeInputSchema.parse(input)
    return this.authority.withLockedAccount(
      credential,
      async (db, s) => {
        await this.scope(db, s)
        const review = await this.review(db, s, request.caseId)
        if (review.restoreId !== request.restoreId || review.contextHash !== request.contextHash)
          throw new RestorePauseError('RESTORE_PAUSE_CONFLICT')
        const now = await this.ready(db, s),
          frontierHash = await this.frontier(db, s, request.caseId)
        const old = await db.query(
          'SELECT challenge_json,challenge_hash FROM ledger_restore_challenges WHERE tenant_id=$1 AND account_id=$2 AND case_id=$3 AND request_id=$4',
          [s.tenant_id, s.account_id, request.caseId, request.requestId]
        )
        if (old.rows[0]) {
          const c = RestorePauseChallengeSchema.parse(old.rows[0].challenge_json)
          if (c.frontierHash !== frontierHash || hashContext(c) !== old.rows[0].challenge_hash)
            throw new RestorePauseError('RESTORE_PAUSE_CONFLICT')
          return c
        }
        const row = (
          await db.query(
            'SELECT context_json FROM ledger_restore_reviews WHERE tenant_id=$1 AND account_id=$2 AND id=$3',
            [s.tenant_id, s.account_id, request.caseId]
          )
        ).rows[0]
        const c = RestorePauseChallengeSchema.parse({
          challengeId: randomUUID(),
          caseId: request.caseId,
          requestId: request.requestId,
          scope: DeviceScopeSchema.parse(s),
          context: row.context_json,
          frontierHash,
          issuedAt: now,
          expiresAt: now + 30000
        })
        await db.query(
          `INSERT INTO ledger_restore_challenges(tenant_id,account_id,id,case_id,agent_id,request_id,challenge_hash,challenge_json,issued_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`,
          [
            s.tenant_id,
            s.account_id,
            c.challengeId,
            c.caseId,
            s.agent_id,
            c.requestId,
            hashContext(c),
            JSON.stringify(c),
            new Date(c.issuedAt),
            new Date(c.expiresAt)
          ]
        )
        return c
      },
      true
    )
  }
  async report(credential: string, input: unknown): Promise<RestorePauseAck> {
    const report = RestorePauseReportSchema.parse(input),
      c = report.challenge,
      reportHash = hashContext(report)
    return this.authority.withLockedAccount(
      credential,
      async (db, s) => {
        await this.scope(db, s)
        if (hashContext(DeviceScopeSchema.parse(s)) !== hashContext(c.scope))
          throw new RestorePauseError('RESTORE_PAUSE_CONFLICT')
        const review = await this.review(db, s, c.caseId)
        if (
          review.contextHash !== c.context.contextHash ||
          review.restoreId !== c.context.restoreId ||
          (await this.frontier(db, s, c.caseId)) !== c.frontierHash
        )
          throw new RestorePauseError('RESTORE_PAUSE_CONFLICT')
        const row = (
          await db.query(
            'SELECT challenge_hash,challenge_json FROM ledger_restore_challenges WHERE tenant_id=$1 AND account_id=$2 AND id=$3 AND agent_id=$4',
            [s.tenant_id, s.account_id, c.challengeId, s.agent_id]
          )
        ).rows[0]
        if (
          !row ||
          row.challenge_hash !== hashContext(c) ||
          hashContext(row.challenge_json) !== hashContext(c)
        )
          throw new RestorePauseError('RESTORE_PAUSE_CONFLICT')
        const old = (
          await db.query(
            'SELECT report_hash FROM ledger_restore_pause_reports WHERE tenant_id=$1 AND account_id=$2 AND challenge_id=$3',
            [s.tenant_id, s.account_id, c.challengeId]
          )
        ).rows[0]
        if (old) {
          if (old.report_hash !== reportHash) throw new RestorePauseError('RESTORE_PAUSE_CONFLICT')
        } else {
          const now = await this.ready(db, s)
          if (now >= c.expiresAt || report.observedAt > now || report.stoppedAt < review.openedAt)
            throw new RestorePauseError('RESTORE_PAUSE_NOT_READY')
          await db.query(
            'INSERT INTO ledger_restore_pause_reports(tenant_id,account_id,challenge_id,agent_id,report_hash,report_json) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
            [
              s.tenant_id,
              s.account_id,
              c.challengeId,
              s.agent_id,
              reportHash,
              JSON.stringify(report)
            ]
          )
          await db.query(
            `INSERT INTO audit_events(tenant_id,id,actor_id,kind,account_id,details_json) VALUES($1,$2,$3,'ledger_restore_target_pause_recorded',$4,$5::jsonb)`,
            [
              s.tenant_id,
              randomUUID(),
              s.agent_id,
              s.account_id,
              JSON.stringify({
                caseId: c.caseId,
                challengeId: c.challengeId,
                reportHash,
                restoreId: c.context.restoreId
              })
            ]
          )
        }
        return { challengeId: c.challengeId, reportHash, status: 'target_pause_report_recorded' }
      },
      true
    )
  }
}
