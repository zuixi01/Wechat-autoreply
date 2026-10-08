import {
  RuntimeObservationSchema,
  RuntimeObservationReceiptSchema,
  type RuntimeObservationReceipt
} from '../../../src/shared/contracts/runtime-monitoring'
import { hashContext } from '../../../src/core/reply/hashes'
import type { AccountAuthority } from '../auth/account-authority'

export class RuntimeMonitoringError extends Error {
  constructor(
    readonly code: 'INVALID_REQUEST' | 'STALE_REPORT' | 'REPORT_CONFLICT' | 'INVALID_HISTORY'
  ) {
    super(code)
    this.name = 'RuntimeMonitoringError'
  }
}

/** Observability only. Reports do not renew leases or certify a physical stop. */
export class RuntimeStatusAuthority {
  constructor(private readonly authority: AccountAuthority) {}

  async report(credential: string, input: unknown): Promise<RuntimeObservationReceipt> {
    const parsed = RuntimeObservationSchema.safeParse(structuredClone(input))
    if (!parsed.success || Buffer.byteLength(JSON.stringify(parsed.data)) > 8192)
      throw new RuntimeMonitoringError('INVALID_REQUEST')
    const observation = parsed.data,
      reportHash = hashContext(observation)
    return this.authority.withLockedAccount(
      credential,
      async (db, scope) => {
        const old = (
          await db.query(
            'SELECT account_id,runtime_epoch,sequence,report_hash,report_json,floor(extract(epoch FROM received_at)*1000)::text AS received FROM device_runtime_status WHERE tenant_id=$1 AND agent_id=$2 FOR UPDATE',
            [scope.tenant_id, scope.agent_id]
          )
        ).rows[0]
        if (old) {
          const previous = RuntimeObservationSchema.safeParse(old.report_json)
          if (
            old.account_id !== scope.account_id ||
            !previous.success ||
            hashContext(previous.data) !== old.report_hash ||
            previous.data.runtimeEpoch !== Number(old.runtime_epoch) ||
            previous.data.sequence !== Number(old.sequence)
          )
            throw new RuntimeMonitoringError('INVALID_HISTORY')
          if (
            observation.runtimeEpoch < previous.data.runtimeEpoch ||
            (observation.runtimeEpoch === previous.data.runtimeEpoch &&
              observation.sequence < previous.data.sequence)
          )
            throw new RuntimeMonitoringError('STALE_REPORT')
          if (
            observation.runtimeEpoch === previous.data.runtimeEpoch &&
            observation.sequence === previous.data.sequence &&
            reportHash !== old.report_hash
          )
            throw new RuntimeMonitoringError('REPORT_CONFLICT')
        }
        let received = old?.received
        if (!old || old.report_hash !== reportHash) {
          received = (
            await db.query(
              `INSERT INTO device_runtime_status(tenant_id,agent_id,account_id,runtime_epoch,sequence,report_hash,report_json)
           VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(tenant_id,agent_id) DO UPDATE SET
           runtime_epoch=excluded.runtime_epoch,sequence=excluded.sequence,report_hash=excluded.report_hash,
           report_json=excluded.report_json,received_at=clock_timestamp()
           RETURNING floor(extract(epoch FROM received_at)*1000)::text AS received`,
              [
                scope.tenant_id,
                scope.agent_id,
                scope.account_id,
                observation.runtimeEpoch,
                observation.sequence,
                reportHash,
                JSON.stringify(observation)
              ]
            )
          ).rows[0].received
        }
        const account = (
          await db.query('SELECT paused FROM accounts WHERE tenant_id=$1 AND id=$2', [
            scope.tenant_id,
            scope.account_id
          ])
        ).rows[0]
        await db.query(
          "SELECT set_config('app.pause_account_id',$1,true),set_config('app.pause_agent_id',$2,true)",
          [scope.account_id, scope.agent_id]
        )
        const pauseHead = account.paused
          ? (
              await db.query(
                'SELECT request_id FROM account_pause_heads WHERE tenant_id=$1 AND account_id=$2',
                [scope.tenant_id, scope.account_id]
              )
            ).rows[0]
          : undefined
        return RuntimeObservationReceiptSchema.parse({
          scope,
          ...{
            runtimeEpoch: observation.runtimeEpoch,
            sequence: observation.sequence,
            reportHash,
            receivedAt: Number(received),
            serverPaused: account.paused,
            ...(pauseHead ? { pauseRequestId: pauseHead.request_id } : {}),
            canAuthorizeSend: false
          }
        })
      },
      true
    )
  }
}
