import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { Id } from '../../../src/shared/contracts/identity'
import {
  BulkPausePageInputSchema,
  BulkPausePageSchema,
  BulkPauseSummarySchema,
  type BulkPausePage,
  type BulkPauseSummary
} from '../../../src/shared/contracts/bulk-pause'

const Cursor = z.strictObject({
  version: z.literal(1),
  tenantId: Id,
  requestId: z.uuid(),
  afterAccount: Id
})
const summarySQL = `SELECT b.id,b.actor_id,floor(extract(epoch FROM b.issued_at)*1000)::text AS issued,
  (SELECT count(*)::text FROM tenant_pause_accounts m WHERE (m.tenant_id,m.batch_id)=(b.tenant_id,b.id)) AS accounts,
  (SELECT count(*)::text FROM tenant_pause_accounts m JOIN accounts c ON(c.tenant_id,c.id)=(m.tenant_id,m.account_id) JOIN account_pause_heads h ON(h.tenant_id,h.account_id,h.request_id)=(m.tenant_id,m.account_id,m.request_id) WHERE(m.tenant_id,m.batch_id)=(b.tenant_id,b.id) AND c.paused) AS active,
  (SELECT count(*)::text FROM accounts c WHERE c.tenant_id=b.tenant_id AND NOT EXISTS(SELECT 1 FROM tenant_pause_accounts m WHERE(m.tenant_id,m.batch_id,m.account_id)=(b.tenant_id,b.id,c.id))) AS outside,
  (SELECT count(*)::text FROM tenant_pause_accounts m JOIN account_pause_targets t ON(t.tenant_id,t.account_id,t.request_id)=(m.tenant_id,m.account_id,m.request_id) WHERE(m.tenant_id,m.batch_id)=(b.tenant_id,b.id)) AS targets,
  (SELECT count(DISTINCT(p.account_id,p.agent_id))::text FROM tenant_pause_accounts m JOIN account_pause_reports p ON(p.tenant_id,p.account_id,p.request_id)=(m.tenant_id,m.account_id,m.request_id) WHERE(m.tenant_id,m.batch_id)=(b.tenant_id,b.id)) AS reported
  FROM tenant_pause_batches b WHERE b.tenant_id=$1 AND b.id=$2`
function summary(row: Record<string, unknown> | undefined): BulkPauseSummary {
  if (!row) throw new Error('bulk_pause_not_found')
  return BulkPauseSummarySchema.parse({
    requestId: row.id,
    actorId: row.actor_id,
    issuedAt: Number(row.issued),
    accountCount: Number(row.accounts),
    activeAccounts: Number(row.active),
    outsideAccounts: Number(row.outside),
    targetCount: Number(row.targets),
    reportedTargets: Number(row.reported),
    physicalStopVerified: false,
    canAuthorizeSend: false
  })
}
export async function readBulkPause(
  db: PoolClient,
  tenant: string,
  id: string
): Promise<BulkPauseSummary> {
  id = z.uuid().parse(id)
  return summary((await db.query(summarySQL, [tenant, id])).rows[0])
}
/** Caller authenticates the admin and owns the transaction. Locks precede all account changes. */
export async function requestBulkPause(
  db: PoolClient,
  tenant: string,
  actor: string,
  id: string = randomUUID()
): Promise<BulkPauseSummary> {
  id = z.uuid().parse(id)
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended('autoreply.bulk-pause:'||$1,0))", [
    tenant
  ])
  if (
    (
      await db.query('SELECT 1 FROM tenant_pause_batches WHERE tenant_id=$1 AND id=$2', [
        tenant,
        id
      ])
    ).rowCount
  )
    return readBulkPause(db, tenant, id)
  await db.query('INSERT INTO tenant_pause_batches(tenant_id,id,actor_id) VALUES($1,$2,$3)', [
    tenant,
    id,
    actor
  ])
  await db.query(
    `WITH locked AS MATERIALIZED(SELECT tenant_id,id FROM accounts WHERE tenant_id=$1 ORDER BY id COLLATE "C" FOR UPDATE),
    created AS(INSERT INTO account_pause_requests(tenant_id,account_id,id,actor_id) SELECT tenant_id,id,gen_random_uuid(),$3 FROM locked RETURNING tenant_id,account_id,id)
    INSERT INTO tenant_pause_accounts(tenant_id,batch_id,account_id,request_id) SELECT tenant_id,$2,account_id,id FROM created`,
    [tenant, id, actor]
  )
  await db.query(
    `UPDATE accounts c SET paused=true FROM tenant_pause_accounts m WHERE (m.tenant_id,m.batch_id)=( $1,$2 ) AND(c.tenant_id,c.id)=(m.tenant_id,m.account_id)`,
    [tenant, id]
  )
  await db.query(
    `INSERT INTO account_pause_targets(tenant_id,account_id,request_id,agent_id) SELECT m.tenant_id,m.account_id,m.request_id,a.id FROM tenant_pause_accounts m JOIN agents a ON(a.tenant_id,a.account_id)=(m.tenant_id,m.account_id) WHERE(m.tenant_id,m.batch_id)=($1,$2) AND a.revoked_at IS NULL`,
    [tenant, id]
  )
  await db.query(
    `INSERT INTO account_pause_heads SELECT tenant_id,account_id,request_id FROM tenant_pause_accounts WHERE tenant_id=$1 AND batch_id=$2 ON CONFLICT(tenant_id,account_id) DO UPDATE SET request_id=excluded.request_id`,
    [tenant, id]
  )
  await db.query(
    `INSERT INTO audit_events(tenant_id,id,actor_id,kind,account_id,details_json) SELECT tenant_id,gen_random_uuid(),$3,'account_pause_requested',account_id,jsonb_build_object('requestId',request_id,'batchId',batch_id) FROM tenant_pause_accounts WHERE tenant_id=$1 AND batch_id=$2`,
    [tenant, id, actor]
  )
  await db.query(
    `INSERT INTO audit_events(tenant_id,id,actor_id,kind,details_json) VALUES($1,$2,$3,'tenant_pause_requested',jsonb_build_object('batchId',$4::uuid))`,
    [tenant, randomUUID(), actor, id]
  )
  return readBulkPause(db, tenant, id)
}
export async function readBulkPauseAccounts(
  db: PoolClient,
  tenant: string,
  id: string,
  input: unknown = {}
): Promise<BulkPausePage> {
  id = z.uuid().parse(id)
  const options = BulkPausePageInputSchema.parse(input),
    limit = options.limit ?? 50
  let after: string | null = null
  if (options.after) {
    try {
      const c = Cursor.parse(JSON.parse(Buffer.from(options.after, 'base64url').toString('utf8')))
      if (c.tenantId !== tenant || c.requestId !== id) throw new Error('scope')
      after = c.afterAccount
    } catch {
      throw new Error('invalid_bulk_pause_cursor')
    }
  }
  const row = (
    await db.query(
      `WITH summary AS(${summarySQL}),page AS(
    SELECT m.account_id,m.request_id,c.employee_id,c.platform,c.enabled,COALESCE(c.paused AND h.request_id=m.request_id,false) AS active,
    (SELECT count(*)::text FROM account_pause_targets t WHERE(t.tenant_id,t.account_id,t.request_id)=(m.tenant_id,m.account_id,m.request_id)) AS targets,
    (SELECT count(DISTINCT agent_id)::text FROM account_pause_reports p WHERE(p.tenant_id,p.account_id,p.request_id)=(m.tenant_id,m.account_id,m.request_id)) AS reported
    FROM tenant_pause_accounts m JOIN accounts c ON(c.tenant_id,c.id)=(m.tenant_id,m.account_id) LEFT JOIN account_pause_heads h ON(h.tenant_id,h.account_id)=(m.tenant_id,m.account_id)
    WHERE m.tenant_id=$1 AND m.batch_id=$2 AND($3::text IS NULL OR m.account_id COLLATE "C">$3 COLLATE "C") ORDER BY m.account_id COLLATE "C" LIMIT $4
  ) SELECT summary.*,COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY account_id COLLATE "C") FROM page),'[]'::jsonb) AS page FROM summary`,
      [tenant, id, after, limit + 1]
    )
  ).rows[0]
  const result = summary(row),
    raw = row.page as Record<string, unknown>[],
    visible = raw.slice(0, limit),
    last = visible.at(-1)
  return BulkPausePageSchema.parse({
    summary: result,
    rows: visible.map((r) => ({
      accountId: r.account_id,
      requestId: r.request_id,
      employeeId: r.employee_id,
      platform: r.platform,
      enabled: r.enabled,
      active: r.active,
      targetCount: Number(r.targets),
      reportedTargets: Number(r.reported)
    })),
    nextCursor:
      raw.length > limit && last
        ? Buffer.from(
            JSON.stringify({
              version: 1,
              tenantId: tenant,
              requestId: id,
              afterAccount: last.account_id
            })
          ).toString('base64url')
        : null
  })
}
