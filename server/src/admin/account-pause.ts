import type { PoolClient } from 'pg'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

/** The caller holds the same account row lock as lease/permit admission. */
export async function requestAccountPause(
  db: PoolClient,
  tenant: string,
  account: string,
  actor: string,
  id: string = randomUUID()
): Promise<Record<string, unknown>> {
  id = z.uuid().parse(id)
  const old = (
    await db.query(
      'SELECT id FROM account_pause_requests WHERE tenant_id=$1 AND account_id=$2 AND id=$3',
      [tenant, account, id]
    )
  ).rows[0]
  if (old) {
    const head = (
      await db.query(
        'SELECT h.request_id,c.paused FROM account_pause_heads h JOIN accounts c ON (c.tenant_id,c.id)=(h.tenant_id,h.account_id) WHERE h.tenant_id=$1 AND h.account_id=$2',
        [tenant, account]
      )
    ).rows[0]
    if (!head?.paused || head.request_id !== id) throw new Error('pause_request_obsolete')
    return readAccountPause(db, tenant, account, id)
  }
  await db.query('UPDATE accounts SET paused=true WHERE tenant_id=$1 AND id=$2', [tenant, account])
  await db.query(
    'INSERT INTO account_pause_requests(tenant_id,account_id,id,actor_id) VALUES($1,$2,$3,$4)',
    [tenant, account, id, actor]
  )
  await db.query(
    `INSERT INTO account_pause_targets(tenant_id,account_id,request_id,agent_id)
    SELECT tenant_id,account_id,$3,id FROM agents WHERE tenant_id=$1 AND account_id=$2 AND revoked_at IS NULL`,
    [tenant, account, id]
  )
  await db.query(
    `INSERT INTO account_pause_heads VALUES($1,$2,$3) ON CONFLICT(tenant_id,account_id) DO UPDATE SET request_id=excluded.request_id`,
    [tenant, account, id]
  )
  await db.query(
    `INSERT INTO audit_events(tenant_id,id,actor_id,kind,account_id,details_json) VALUES($1,$2,$3,'account_pause_requested',$4,$5)`,
    [tenant, randomUUID(), actor, account, JSON.stringify({ requestId: id })]
  )
  return readAccountPause(db, tenant, account, id)
}
export async function readAccountPause(
  db: PoolClient,
  tenant: string,
  account: string,
  id?: string
): Promise<Record<string, unknown>> {
  if (id) id = z.uuid().parse(id)
  const row = (
    await db.query(
      `SELECT r.id,r.actor_id,floor(extract(epoch FROM r.issued_at)*1000)::text AS issued,
    c.paused AND h.request_id=r.id AS active,
    (SELECT count(*)::text FROM account_pause_targets t WHERE (t.tenant_id,t.account_id,t.request_id)=(r.tenant_id,r.account_id,r.id)) AS targets,
    (SELECT count(DISTINCT p.agent_id)::text FROM account_pause_reports p WHERE (p.tenant_id,p.account_id,p.request_id)=(r.tenant_id,r.account_id,r.id)) AS reported
    FROM account_pause_requests r JOIN accounts c ON (c.tenant_id,c.id)=(r.tenant_id,r.account_id)
    LEFT JOIN account_pause_heads h ON (h.tenant_id,h.account_id)=(r.tenant_id,r.account_id)
    WHERE r.tenant_id=$1 AND r.account_id=$2 AND r.id=COALESCE($3::uuid,h.request_id)`,
      [tenant, account, id ?? null]
    )
  ).rows[0]
  if (!row) throw new Error('pause_request_not_found')
  return {
    requestId: row.id,
    actorId: row.actor_id,
    issuedAt: Number(row.issued),
    active: row.active,
    targetCount: Number(row.targets),
    reportedTargets: Number(row.reported),
    physicalStopVerified: false,
    canAuthorizeSend: false
  }
}
