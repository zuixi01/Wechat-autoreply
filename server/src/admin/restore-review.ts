import { createHash, randomUUID } from 'node:crypto'
import type { PoolClient, QueryResult } from 'pg'
import { z } from 'zod'
import { Id } from '../../../src/shared/contracts/identity'
import { LedgerRestoreContextSchema } from '../../../src/shared/contracts/restoration'
import { hashContext } from '../../../src/core/reply/hashes'

const Request = z.strictObject({ agentId: Id, context: LedgerRestoreContextSchema })
const Lease = z.strictObject({
  agentId: Id,
  loginEpoch: z.string().regex(/^(0|[1-9][0-9]*)$/),
  clientInstanceId: Id,
  version: z.string().regex(/^[1-9][0-9]*$/),
  expiresAt: z.iso.datetime()
})
export const RestorePermitPageSchema = z.strictObject({
  after: Id.optional(),
  limit: z.number().int().min(1).max(100).default(50)
})
type Scope = { tenant_id: string; actor_id: string }
export class RestoreReviewError extends Error {
  constructor(readonly code: 'RESTORE_REVIEW_CONFLICT' | 'RESTORE_REVIEW_NOT_FOUND') {
    super(code)
    this.name = 'RestoreReviewError'
  }
}
export interface RestoreReview {
  caseId: string
  restoreId: string
  agentId: string
  contextHash: string
  backupId: string
  sourceSha256: string
  openedBy: string
  openedAt: number
  permitCount: number
  requiresReconciliation: true
  devicePauseAcknowledged: null
  leaseAtOpening: z.infer<typeof Lease> | null
}
function parseRequest(input: unknown): z.infer<typeof Request> {
  try {
    const request = Request.parse(input)
    const { contextHash, ...descriptor } = request.context
    if (hashContext(descriptor) !== contextHash) throw Error('invalid')
    return request
  } catch {
    throw new RestoreReviewError('RESTORE_REVIEW_CONFLICT')
  }
}
export async function readRestoreReview(
  db: PoolClient,
  scope: Scope,
  accountId: string,
  caseId: string
): Promise<RestoreReview> {
  const result = await db.query(
    `SELECT r.*,(SELECT count(*)::text FROM ledger_restore_review_permits p
    WHERE (p.tenant_id,p.account_id,p.case_id)=(r.tenant_id,r.account_id,r.id)) AS permit_count
    FROM ledger_restore_reviews r WHERE tenant_id=$1 AND account_id=$2 AND id=$3`,
    [scope.tenant_id, accountId, caseId]
  )
  const row = result.rows[0]
  if (!row) throw new RestoreReviewError('RESTORE_REVIEW_NOT_FOUND')
  const request = parseRequest({ agentId: row.agent_id, context: row.context_json })
  if (
    request.context.restoreId !== row.restore_id ||
    request.context.contextHash !== row.context_hash ||
    hashContext(request) !== row.request_hash ||
    !Number.isSafeInteger(Number(row.permit_count)) ||
    String(row.captured_permit_count) !== String(row.permit_count)
  )
    throw new RestoreReviewError('RESTORE_REVIEW_CONFLICT')
  const lease = Lease.nullable().safeParse(row.lease_snapshot)
  if (!lease.success) throw new RestoreReviewError('RESTORE_REVIEW_CONFLICT')
  return {
    caseId: row.id,
    restoreId: row.restore_id,
    agentId: row.agent_id,
    contextHash: row.context_hash,
    backupId: request.context.backupId,
    sourceSha256: request.context.sourceSha256,
    openedBy: row.opened_by,
    openedAt: new Date(row.opened_at).getTime(),
    permitCount: Number(row.permit_count),
    requiresReconciliation: true,
    devicePauseAcknowledged: null,
    leaseAtOpening: lease.data
  }
}
/** Caller authenticates the administrator and holds the account row lock. */
export async function openRestoreReview(
  db: PoolClient,
  scope: Scope,
  accountId: string,
  input: unknown
): Promise<RestoreReview> {
  const request = parseRequest(input),
    requestHash = hashContext(request)
  const old = await db.query(
    'SELECT id,request_hash FROM ledger_restore_reviews WHERE tenant_id=$1 AND account_id=$2 AND restore_id=$3',
    [scope.tenant_id, accountId, request.context.restoreId]
  )
  if (old.rows[0]) {
    if (old.rows[0].request_hash !== requestHash)
      throw new RestoreReviewError('RESTORE_REVIEW_CONFLICT')
    return readRestoreReview(db, scope, accountId, old.rows[0].id)
  }
  const agent = await db.query(
    'SELECT id FROM agents WHERE tenant_id=$1 AND account_id=$2 AND id=$3 AND revoked_at IS NULL',
    [scope.tenant_id, accountId, request.agentId]
  )
  if (!agent.rowCount) throw new RestoreReviewError('RESTORE_REVIEW_CONFLICT')
  await db.query('UPDATE accounts SET paused=true WHERE tenant_id=$1 AND id=$2', [
    scope.tenant_id,
    accountId
  ])
  const leases = await db.query(
    'SELECT agent_id,login_epoch::text,client_instance_id,version::text,expires_at FROM account_leases WHERE tenant_id=$1 AND account_id=$2',
    [scope.tenant_id, accountId]
  )
  const lease = leases.rows[0]
  const leaseSnapshot = lease
    ? Lease.parse({
        agentId: lease.agent_id,
        loginEpoch: lease.login_epoch,
        clientInstanceId: lease.client_instance_id,
        version: lease.version,
        expiresAt: new Date(lease.expires_at).toISOString()
      })
    : null
  const count = (
    await db.query(
      'SELECT count(*)::text AS count FROM execution_permits WHERE tenant_id=$1 AND account_id=$2',
      [scope.tenant_id, accountId]
    )
  ).rows[0].count
  const id = randomUUID()
  await db.query(
    `INSERT INTO ledger_restore_reviews(tenant_id,account_id,id,restore_id,agent_id,context_hash,request_hash,context_json,opened_by,captured_permit_count,lease_snapshot)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11::jsonb)`,
    [
      scope.tenant_id,
      accountId,
      id,
      request.context.restoreId,
      request.agentId,
      request.context.contextHash,
      requestHash,
      JSON.stringify(request.context),
      scope.actor_id,
      count,
      leaseSnapshot === null ? null : JSON.stringify(leaseSnapshot)
    ]
  )
  // Capture all existing permits in SQL, never a truncated page or timestamp assumption.
  await db.query(
    `INSERT INTO ledger_restore_review_permits(tenant_id,account_id,case_id,permit_id,status_at_opening,snapshot_json)
    SELECT tenant_id,account_id,$3,id,status,jsonb_build_object('permitId',id,'agentId',agent_id,'taskId',task_id,
      'draftHash',draft_hash,'taskHash',task_hash,'draftRevision',draft_revision,'leaseVersion',lease_version,
      'loginEpoch',login_epoch,'clientInstanceId',client_instance_id,'conversationId',conversation_id,
      'purpose',purpose,'confirmationId',confirmation_id,'status',status,'issuedAt',issued_at,'expiresAt',expires_at,
      'settledAt',settled_at,'settlementHash',settlement_hash)
    FROM execution_permits WHERE tenant_id=$1 AND account_id=$2`,
    [scope.tenant_id, accountId, id]
  )
  const review = await readRestoreReview(db, scope, accountId, id)
  await db.query(
    `INSERT INTO audit_events(tenant_id,id,actor_id,kind,account_id,details_json) VALUES($1,$2,$3,'ledger_restore_review_opened',$4,$5::jsonb)`,
    [
      scope.tenant_id,
      randomUUID(),
      scope.actor_id,
      accountId,
      JSON.stringify({
        caseId: id,
        restoreId: review.restoreId,
        contextHash: review.contextHash,
        agentId: review.agentId,
        permitCount: review.permitCount
      })
    ]
  )
  return review
}
export async function hasRestoreReviews(
  db: PoolClient,
  tenantId: string,
  accountId: string
): Promise<boolean> {
  return Boolean(
    (
      await db.query('SELECT 1 WHERE autoreply.restore_admission_pending($1,$2)', [
        tenantId,
        accountId
      ])
    ).rowCount
  )
}
export async function readRestorePermits(
  db: PoolClient,
  scope: Scope,
  accountId: string,
  caseId: string,
  input: unknown
): Promise<Record<string, unknown>[]> {
  const page = RestorePermitPageSchema.parse(input)
  await readRestoreReview(db, scope, accountId, caseId)
  const result = await db.query(
    `SELECT snapshot_json FROM ledger_restore_review_permits WHERE tenant_id=$1 AND account_id=$2 AND case_id=$3 AND ($4::text IS NULL OR permit_id>$4) ORDER BY permit_id LIMIT $5`,
    [scope.tenant_id, accountId, caseId, page.after ?? null, page.limit]
  )
  return result.rows.map((row) => z.record(z.string(), z.unknown()).parse(row.snapshot_json))
}

/** Complete immutable frontier, shared by target challenges and administrator reads. */
export async function readRestoreFrontier(
  db: PoolClient,
  scope: Scope,
  accountId: string,
  caseId: string
): Promise<{ review: RestoreReview; frontierHash: string }> {
  const review = await readRestoreReview(db, scope, accountId, caseId)
  const digest = createHash('sha256').update(hashContext(review))
  let after: string | null = null,
    count = 0
  for (;;) {
    const rows: QueryResult<{ permit_id: string; snapshot_json: unknown }> = await db.query(
      'SELECT permit_id,snapshot_json FROM ledger_restore_review_permits WHERE tenant_id=$1 AND account_id=$2 AND case_id=$3 AND ($4::text IS NULL OR permit_id>$4) ORDER BY permit_id LIMIT 500',
      [scope.tenant_id, accountId, caseId, after]
    )
    if (!rows.rows.length) break
    for (const row of rows.rows) {
      digest.update(hashContext({ permitId: row.permit_id, snapshot: row.snapshot_json }))
      count++
      after = row.permit_id
    }
    if (rows.rows.length < 500) break
  }
  if (count !== review.permitCount) throw new RestoreReviewError('RESTORE_REVIEW_CONFLICT')
  return { review, frontierHash: digest.digest('hex') }
}
