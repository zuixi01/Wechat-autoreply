import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { AccountAuthority, type Scope } from '../auth/account-authority'
import { hashContext } from '../../../src/core/reply/hashes'
import {
  AccountPauseAckSchema,
  AccountPauseChallengeSchema,
  AccountPauseReportSchema,
  PauseChallengeInputSchema,
  type AccountPauseChallenge,
  type AccountPauseReport,
  type AccountPauseAck
} from '../../../src/shared/contracts/runtime-pause'

export class AccountPauseError extends Error {
  constructor(
    readonly code:
      | 'INVALID_REQUEST'
      | 'PAUSE_OBSOLETE'
      | 'PAUSE_CONFLICT'
      | 'PAUSE_EXPIRED'
      | 'PAUSE_INVALID_HISTORY'
  ) {
    super(code)
    this.name = 'AccountPauseError'
  }
}
export class AccountPauseAuthority {
  constructor(private readonly authority: AccountAuthority) {}
  private async current(db: PoolClient, scope: Scope, requestId: string): Promise<number> {
    await db.query(
      "SELECT set_config('app.pause_account_id',$1,true),set_config('app.pause_agent_id',$2,true)",
      [scope.account_id, scope.agent_id]
    )
    const row = (
      await db.query(
        `SELECT h.request_id,c.paused,floor(extract(epoch FROM clock_timestamp())*1000)::text AS now
      FROM account_pause_heads h JOIN accounts c ON (c.tenant_id,c.id)=(h.tenant_id,h.account_id)
      WHERE h.tenant_id=$1 AND h.account_id=$2`,
        [scope.tenant_id, scope.account_id]
      )
    ).rows[0]
    if (!row?.paused || row.request_id !== requestId) throw new AccountPauseError('PAUSE_OBSOLETE')
    return Number(row.now)
  }
  async challenge(credential: string, input: unknown): Promise<AccountPauseChallenge> {
    const parsed = PauseChallengeInputSchema.safeParse(structuredClone(input))
    if (!parsed.success) throw new AccountPauseError('INVALID_REQUEST')
    const request = parsed.data
    return this.authority.withLockedAccount(
      credential,
      async (db, s) => {
        const now = await this.current(db, s, request.requestId)
        const old = (
          await db.query(
            'SELECT challenge_json,challenge_hash FROM account_pause_challenges WHERE tenant_id=$1 AND account_id=$2 AND request_id=$3 AND agent_id=$4 AND attempt_id=$5',
            [s.tenant_id, s.account_id, request.requestId, s.agent_id, request.attemptId]
          )
        ).rows[0]
        if (old) {
          const previous = AccountPauseChallengeSchema.safeParse(old.challenge_json)
          if (!previous.success || hashContext(previous.data) !== old.challenge_hash)
            throw new AccountPauseError('PAUSE_INVALID_HISTORY')
          const c = previous.data
          if (
            hashContext({
              requestId: c.requestId,
              attemptId: c.attemptId,
              runtime: c.runtime,
              instanceEpoch: c.instanceEpoch
            }) !== hashContext(request) ||
            hashContext(c.scope) !== hashContext(s)
          )
            throw new AccountPauseError('PAUSE_CONFLICT')
          return c
        }
        const c = AccountPauseChallengeSchema.parse({
          ...request,
          purpose: 'account_pause',
          challengeId: randomUUID(),
          scope: s,
          issuedAt: now,
          expiresAt: now + 30000
        })
        await db.query(
          `INSERT INTO account_pause_challenges VALUES($1,$2,$3,$4,$5,$6,$7,$8,to_timestamp($9::numeric/1000),to_timestamp($10::numeric/1000))`,
          [
            s.tenant_id,
            s.account_id,
            c.requestId,
            s.agent_id,
            c.challengeId,
            c.attemptId,
            hashContext(c),
            JSON.stringify(c),
            c.issuedAt,
            c.expiresAt
          ]
        )
        return c
      },
      true
    )
  }
  async report(credential: string, input: unknown): Promise<AccountPauseAck> {
    const parsed = AccountPauseReportSchema.safeParse(structuredClone(input))
    if (!parsed.success) throw new AccountPauseError('INVALID_REQUEST')
    const report: AccountPauseReport = parsed.data,
      c = report.challenge,
      reportHash = hashContext(report)
    return this.authority.withLockedAccount(
      credential,
      async (db, s) => {
        const now = await this.current(db, s, c.requestId)
        if (hashContext(s) !== hashContext(c.scope)) throw new AccountPauseError('PAUSE_CONFLICT')
        const stored = (
          await db.query(
            'SELECT challenge_json,challenge_hash FROM account_pause_challenges WHERE tenant_id=$1 AND account_id=$2 AND id=$3 AND agent_id=$4',
            [s.tenant_id, s.account_id, c.challengeId, s.agent_id]
          )
        ).rows[0]
        if (
          !stored ||
          stored.challenge_hash !== hashContext(c) ||
          hashContext(stored.challenge_json) !== hashContext(c)
        )
          throw new AccountPauseError('PAUSE_CONFLICT')
        const old = (
          await db.query(
            'SELECT report_json,report_hash,floor(extract(epoch FROM received_at)*1000)::text AS received FROM account_pause_reports WHERE tenant_id=$1 AND account_id=$2 AND challenge_id=$3',
            [s.tenant_id, s.account_id, c.challengeId]
          )
        ).rows[0]
        if (
          old &&
          (hashContext(old.report_json) !== old.report_hash ||
            !AccountPauseReportSchema.safeParse(old.report_json).success)
        )
          throw new AccountPauseError('PAUSE_INVALID_HISTORY')
        if (old && old.report_hash !== reportHash) throw new AccountPauseError('PAUSE_CONFLICT')
        let received = old?.received
        if (!old) {
          if (now >= c.expiresAt || now < c.issuedAt) throw new AccountPauseError('PAUSE_EXPIRED')
          received = (
            await db.query(
              `INSERT INTO account_pause_reports(tenant_id,account_id,request_id,agent_id,challenge_id,report_hash,report_json)
          VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING floor(extract(epoch FROM received_at)*1000)::text AS received`,
              [
                s.tenant_id,
                s.account_id,
                c.requestId,
                s.agent_id,
                c.challengeId,
                reportHash,
                JSON.stringify(report)
              ]
            )
          ).rows[0].received
          if (Number(received) >= c.expiresAt || Number(received) < c.issuedAt)
            throw new AccountPauseError('PAUSE_EXPIRED')
        }
        return AccountPauseAckSchema.parse({
          requestId: c.requestId,
          challengeId: c.challengeId,
          reportHash,
          receivedAt: Number(received),
          status: 'runtime_stop_confirmation_recorded',
          physicalStopVerified: false,
          canAuthorizeSend: false
        })
      },
      true
    )
  }
}
