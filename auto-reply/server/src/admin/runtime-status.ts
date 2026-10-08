import type { PoolClient } from 'pg'
import { z } from 'zod'
import { Id } from '../../../src/shared/contracts/identity'
import {
  RuntimeObservationSchema,
  RuntimeStatusPageInputSchema,
  type RuntimeDeviceRow,
  type RuntimeStatusPage
} from '../../../src/shared/contracts/runtime-monitoring'
import { hashContext } from '../../../src/core/reply/hashes'
import { AccountPauseReportSchema } from '../../../src/shared/contracts/runtime-pause'

const Cursor = z.strictObject({
  version: z.literal(1),
  tenant: Id,
  account: Id.nullable(),
  afterAccount: Id,
  afterAgent: Id
})
export type {
  RuntimeDeviceRow,
  RuntimeStatusPage
} from '../../../src/shared/contracts/runtime-monitoring'

/** A single SQL snapshot covers counts and the bounded page. No chat content is selected. */
export async function readRuntimeStatus(
  db: PoolClient,
  tenantId: string,
  input: unknown
): Promise<RuntimeStatusPage> {
  const options = RuntimeStatusPageInputSchema.parse(input),
    limit = options.limit ?? 50
  let after: z.infer<typeof Cursor> | undefined
  if (options.after) {
    const raw = Buffer.from(options.after, 'base64url')
    if (raw.toString('base64url') !== options.after) throw new Error('invalid_runtime_cursor')
    after = Cursor.parse(JSON.parse(raw.toString('utf8')))
    if (after.tenant !== tenantId || after.account !== (options.accountId ?? null))
      throw new Error('invalid_runtime_cursor')
  }
  const result = (
    await db.query(
      `WITH page AS (
    SELECT a.id AS agent_id,a.account_id,a.employee_id,c.platform,c.enabled AS account_enabled,
      e.enabled AS employee_enabled,c.paused AS server_paused,a.revoked_at IS NOT NULL AS revoked,
      p.config_version,p.automatic_enabled,l.agent_id AS lease_agent_id,
      COALESCE(l.expires_at>statement_timestamp(),false) AS lease_live,
      d.runtime_epoch::text,d.sequence::text,d.report_hash,
      CASE WHEN octet_length(d.report_json::text)<=8192 THEN d.report_json ELSE NULL END AS report_json,
      floor(extract(epoch FROM d.received_at)*1000)::text AS received,
      h.request_id::text AS pause_request_id,t.agent_id AS pause_target,
      q.report_hash AS pause_report_hash,q.report_json AS pause_report_json,
      floor(extract(epoch FROM q.received_at)*1000)::text AS pause_received
    FROM agents a JOIN accounts c ON (c.tenant_id,c.id)=(a.tenant_id,a.account_id)
    JOIN employees e ON (e.tenant_id,e.id)=(a.tenant_id,a.employee_id)
    LEFT JOIN device_runtime_status d ON (d.tenant_id,d.agent_id)=(a.tenant_id,a.id)
    LEFT JOIN published_configurations p ON (p.tenant_id,p.account_id)=(a.tenant_id,a.account_id)
    LEFT JOIN account_leases l ON (l.tenant_id,l.account_id)=(a.tenant_id,a.account_id)
    LEFT JOIN account_pause_heads h ON (h.tenant_id,h.account_id)=(a.tenant_id,a.account_id)
    LEFT JOIN account_pause_targets t ON (t.tenant_id,t.account_id,t.request_id,t.agent_id)=(a.tenant_id,a.account_id,h.request_id,a.id)
    LEFT JOIN LATERAL(SELECT report_hash,report_json,received_at FROM account_pause_reports q
      WHERE (q.tenant_id,q.account_id,q.request_id,q.agent_id)=(a.tenant_id,a.account_id,h.request_id,a.id)
      ORDER BY received_at DESC,challenge_id DESC LIMIT 1) q ON true
    WHERE a.tenant_id=$1 AND ($2::text IS NULL OR a.account_id=$2)
      AND ($3::text IS NULL OR (a.account_id COLLATE "C",a.id COLLATE "C")>($3 COLLATE "C",$4 COLLATE "C"))
    ORDER BY a.account_id COLLATE "C",a.id COLLATE "C" LIMIT $5
  ), totals AS (
    SELECT count(*)::text AS total,count(*) FILTER(WHERE revoked_at IS NOT NULL)::text AS revoked
    FROM agents WHERE tenant_id=$1 AND ($2::text IS NULL OR account_id=$2)
  ) SELECT floor(extract(epoch FROM statement_timestamp())*1000)::text AS now,
    totals.total,totals.revoked,
    COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY account_id COLLATE "C",agent_id COLLATE "C") FROM page),'[]'::jsonb) AS page
    FROM totals`,
      [
        tenantId,
        options.accountId ?? null,
        after?.afterAccount ?? null,
        after?.afterAgent ?? null,
        limit + 1
      ]
    )
  ).rows[0]
  const serverTime = Number(result.now),
    rawRows = result.page as Record<string, unknown>[]
  const visible = rawRows.slice(0, limit)
  const rows: RuntimeDeviceRow[] = visible.map((row) => {
    const receivedAt = row.received === null ? null : Number(row.received)
    const parsed = RuntimeObservationSchema.safeParse(row.report_json)
    const valid =
      parsed.success &&
      hashContext(parsed.data) === row.report_hash &&
      parsed.data.runtimeEpoch === Number(row.runtime_epoch) &&
      parsed.data.sequence === Number(row.sequence) &&
      receivedAt !== null &&
      Number.isSafeInteger(receivedAt) &&
      receivedAt >= 0 &&
      receivedAt <= serverTime
    const freshness = row.revoked
      ? 'revoked'
      : row.runtime_epoch === null
        ? 'missing'
        : !valid
          ? 'invalid'
          : serverTime - receivedAt! <= 30000
            ? 'recent'
            : 'stale'
    const pauseReport = AccountPauseReportSchema.safeParse(row.pause_report_json)
    const pauseReceived = Number(row.pause_received)
    const pauseValid =
      pauseReport.success &&
      hashContext(pauseReport.data) === row.pause_report_hash &&
      pauseReport.data.challenge.requestId === row.pause_request_id &&
      hashContext(pauseReport.data.challenge.scope) ===
        hashContext({
          tenant_id: tenantId,
          employee_id: row.employee_id,
          account_id: row.account_id,
          agent_id: row.agent_id,
          platform: row.platform
        }) &&
      Number.isSafeInteger(pauseReceived) &&
      pauseReceived >= pauseReport.data.challenge.issuedAt &&
      pauseReceived < pauseReport.data.challenge.expiresAt &&
      pauseReceived <= serverTime
    const pauseConfirmation: RuntimeDeviceRow['pauseConfirmation'] =
      !row.server_paused || !row.pause_target
        ? 'not_requested'
        : row.revoked
          ? 'revoked'
          : row.pause_report_json === null
            ? 'pending'
            : !pauseValid
              ? 'invalid'
              : freshness !== 'recent'
                ? 'stale'
                : !valid ||
                    !parsed.data.runtimeContext ||
                    hashContext(parsed.data.runtimeContext) !==
                      hashContext(pauseReport.data.challenge.runtime) ||
                    !parsed.data.status.pauseAcknowledged ||
                    parsed.data.status.lease !== 'stopped'
                  ? 'awaiting_state'
                  : 'confirmed_runtime'
    return {
      accountId: String(row.account_id),
      employeeId: String(row.employee_id),
      agentId: String(row.agent_id),
      platform: row.platform as RuntimeDeviceRow['platform'],
      accountEnabled: row.account_enabled === true,
      employeeEnabled: row.employee_enabled === true,
      serverPaused: row.server_paused === true,
      revoked: row.revoked === true,
      configurationVersion: row.config_version === null ? null : String(row.config_version),
      automaticEnabled: typeof row.automatic_enabled === 'boolean' ? row.automatic_enabled : null,
      leaseLive: row.lease_live === true,
      leaseAgentId: row.lease_agent_id === null ? null : String(row.lease_agent_id),
      freshness,
      receivedAt,
      observation: valid ? parsed.data : null,
      pauseRequestId: row.pause_request_id === null ? null : String(row.pause_request_id),
      pauseConfirmation,
      physicalStopVerified: false,
      canAuthorizeSend: false
    }
  })
  const last = visible.at(-1)
  const nextCursor =
    rawRows.length > limit && last
      ? Buffer.from(
          JSON.stringify({
            version: 1,
            tenant: tenantId,
            account: options.accountId ?? null,
            afterAccount: last.account_id,
            afterAgent: last.agent_id
          })
        ).toString('base64url')
      : null
  return {
    serverTime,
    totalDevices: Number(result.total),
    revokedDevices: Number(result.revoked),
    rows,
    nextCursor
  }
}
