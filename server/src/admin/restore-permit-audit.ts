import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { Id, Hash } from '../../../src/shared/contracts/identity'
import { hashContext } from '../../../src/core/reply/hashes'
import { readRestoreFrontier, RestoreReviewError } from './restore-review'

const Status = z.enum(['issued', 'confirmed', 'not_sent', 'unknown'])
const Positive = z.number().int().positive().safe()
const Version = z.number().int().nonnegative().safe()
const Time = z.iso.datetime({ offset: true }).max(128)
const Snapshot = z
  .strictObject({
    permitId: Id,
    agentId: Id,
    taskId: Id,
    draftHash: Hash,
    taskHash: Hash.nullable(),
    draftRevision: Version.nullable(),
    leaseVersion: Positive,
    loginEpoch: Version.nullable(),
    clientInstanceId: Id.nullable(),
    conversationId: Id.nullable(),
    purpose: z.enum(['automatic', 'human']),
    confirmationId: z.uuid().nullable(),
    status: Status,
    issuedAt: Time,
    expiresAt: Time.nullable(),
    settledAt: Time.nullable(),
    settlementHash: Hash.nullable()
  })
  .refine((value) =>
    value.purpose === 'human' ? value.confirmationId !== null : value.confirmationId === null
  )
type PermitSnapshot = z.infer<typeof Snapshot>
export const RestoreAuditPageSchema = z.strictObject({
  after: Id.optional(),
  limit: z.number().int().min(1).max(100).default(50),
  expectedBasisHash: Hash.optional()
})
export interface RestorePermitAuditItem {
  permitId: string
  comparison: 'match' | 'identity_changed' | 'not_captured' | 'missing_current'
  openingStatus: PermitSnapshot['status'] | null
  currentStatus: PermitSnapshot['status'] | null
  changed: boolean
  expired: boolean
  settlementRecorded: boolean
  metadataComplete: boolean
  outcomeReviewRequired: boolean
  opening: PermitSnapshot | null
  current: PermitSnapshot | null
}
export interface RestorePermitAudit {
  caseId: string
  restoreId: string
  frontierHash: string
  basisHash: string
  checkedAt: number
  evidenceKind: 'central_metadata_comparison'
  localWatermarksRequired: true
  canRelease: false
  summary: {
    capturedCount: number
    currentCount: number
    unresolvedCentralCount: number
    expiredIssuedCount: number
    changedCount: number
    unexpectedCount: number
    identityChangedCount: number
    missingCurrentCount: number
    incompleteMetadataCount: number
  }
  items: RestorePermitAuditItem[]
  nextAfter: string | null
}
const currentJson = `jsonb_build_object('permitId',p.id,'agentId',p.agent_id,'taskId',p.task_id,
  'draftHash',p.draft_hash,'taskHash',p.task_hash,'draftRevision',p.draft_revision,'leaseVersion',p.lease_version,
  'loginEpoch',p.login_epoch,'clientInstanceId',p.client_instance_id,'conversationId',p.conversation_id,
  'purpose',p.purpose,'confirmationId',p.confirmation_id,'status',p.status,'issuedAt',p.issued_at,'expiresAt',p.expires_at,
  'settledAt',p.settled_at,'settlementHash',p.settlement_hash)`
interface Row {
  permit_id: string
  opening: unknown | null
  current: unknown | null
  status_at_opening: unknown
  selected: boolean
}
// Equivalent time-zone spellings retain the same value, including SQL microseconds.
function exactTime(value: string | null): string | null {
  return value === null
    ? null
    : `${Math.floor(Date.parse(value) / 1000)}:${(value.match(/\.(\d+)/)?.[1] ?? '').replace(/0+$/, '').padEnd(9, '0')}`
}
function semantic(snapshot: PermitSnapshot | null): Record<string, unknown> | null {
  return snapshot === null
    ? null
    : {
        ...snapshot,
        issuedAt: exactTime(snapshot.issuedAt),
        expiresAt: exactTime(snapshot.expiresAt),
        settledAt: exactTime(snapshot.settledAt)
      }
}
export function canonicalRestoreAuditItem(value: RestorePermitAuditItem): Record<string, unknown> {
  return { ...value, opening: semantic(value.opening), current: semantic(value.current) }
}
function immutable(snapshot: PermitSnapshot): Record<string, unknown> {
  const { status, settledAt, settlementHash, ...identity } = snapshot
  void status
  void settledAt
  void settlementHash
  return {
    ...identity,
    issuedAt: exactTime(identity.issuedAt),
    expiresAt: exactTime(identity.expiresAt)
  }
}
function item(row: Row, checkedAt: number): RestorePermitAuditItem {
  try {
    const opening = row.opening === null ? null : Snapshot.parse(row.opening),
      current = row.current === null ? null : Snapshot.parse(row.current)
    if (
      (!opening && !current) ||
      (opening &&
        (opening.permitId !== row.permit_id || opening.status !== row.status_at_opening)) ||
      (current && current.permitId !== row.permit_id)
    )
      throw Error('invalid')
    const comparison = !opening
      ? 'not_captured'
      : !current
        ? 'missing_current'
        : hashContext(immutable(opening)) === hashContext(immutable(current))
          ? 'match'
          : 'identity_changed'
    const metadataComplete =
      !!current &&
      current.taskHash !== null &&
      current.draftRevision !== null &&
      current.loginEpoch !== null &&
      current.clientInstanceId !== null &&
      current.conversationId !== null &&
      current.expiresAt !== null
    const settlementRecorded =
      !!current &&
      current.status !== 'issued' &&
      current.settledAt !== null &&
      current.settlementHash !== null
    return {
      permitId: row.permit_id,
      comparison,
      openingStatus: opening?.status ?? null,
      currentStatus: current?.status ?? null,
      changed: hashContext(semantic(opening)) !== hashContext(semantic(current)),
      expired:
        !!current &&
        current.status === 'issued' &&
        current.expiresAt !== null &&
        Date.parse(current.expiresAt) <= checkedAt,
      settlementRecorded,
      metadataComplete,
      outcomeReviewRequired:
        comparison !== 'match' ||
        !metadataComplete ||
        !settlementRecorded ||
        ['issued', 'unknown'].includes(current?.status ?? 'unknown'),
      opening,
      current
    }
  } catch {
    throw new RestoreReviewError('RESTORE_REVIEW_CONFLICT')
  }
}
/** Independent administrator transaction and account lock supplied by caller; no writes or release. */
export async function readRestorePermitAudit(
  db: PoolClient,
  scope: { tenant_id: string; actor_id: string },
  accountId: string,
  caseId: string,
  input: unknown,
  visit?: (item: RestorePermitAuditItem) => void
): Promise<RestorePermitAudit> {
  const page = RestoreAuditPageSchema.parse(input),
    { review, frontierHash } = await readRestoreFrontier(db, scope, accountId, caseId)
  const checkedAt = Number(
    (await db.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now'))
      .rows[0].now
  )
  if (!Number.isSafeInteger(checkedAt) || checkedAt < 0)
    throw new RestoreReviewError('RESTORE_REVIEW_CONFLICT')
  const summary: RestorePermitAudit['summary'] = {
    capturedCount: 0,
    currentCount: 0,
    unresolvedCentralCount: 0,
    expiredIssuedCount: 0,
    changedCount: 0,
    unexpectedCount: 0,
    identityChangedCount: 0,
    missingCurrentCount: 0,
    incompleteMetadataCount: 0
  }
  const digest = createHash('sha256').update(frontierHash),
    items: RestorePermitAuditItem[] = []
  let cursor: string | null = null,
    hasMore = false
  for (;;) {
    const ids = await db.query<{ permit_id: string; selected: boolean }>(
      `WITH all_ids AS (
        SELECT permit_id FROM ledger_restore_review_permits WHERE tenant_id=$1 AND account_id=$2 AND case_id=$3
        UNION SELECT id AS permit_id FROM execution_permits WHERE tenant_id=$1 AND account_id=$2
      )
      SELECT permit_id,($5::text IS NULL OR permit_id>$5) AS selected
      FROM all_ids WHERE ($4::text IS NULL OR permit_id>$4) ORDER BY permit_id LIMIT 500`,
      [scope.tenant_id, accountId, caseId, cursor, page.after ?? null]
    )
    if (!ids.rows.length) break
    const permitIds = ids.rows.map((row) => row.permit_id)
    // Separate bounded reads avoid repeated RLS checks from nested-loop joins.
    // Retain the database's ID order and cursor comparison when combining rows.
    const opening = await db.query<{
      permit_id: string
      opening: unknown
      status_at_opening: unknown
    }>(
      `SELECT permit_id,snapshot_json AS opening,status_at_opening FROM ledger_restore_review_permits
        WHERE tenant_id=$1 AND account_id=$2 AND case_id=$3 AND permit_id=ANY($4::text[])`,
      [scope.tenant_id, accountId, caseId, permitIds]
    )
    const current = await db.query<{ permit_id: string; current: unknown }>(
      `SELECT p.id AS permit_id,${currentJson} AS current FROM execution_permits p
        WHERE p.tenant_id=$1 AND p.account_id=$2 AND p.id=ANY($3::text[])`,
      [scope.tenant_id, accountId, permitIds]
    )
    const openingById = new Map(opening.rows.map((row) => [row.permit_id, row]))
    const currentById = new Map(current.rows.map((row) => [row.permit_id, row.current]))
    for (const id of ids.rows) {
      const captured = openingById.get(id.permit_id)
      const row: Row = {
        ...id,
        opening: captured?.opening ?? null,
        status_at_opening: captured?.status_at_opening ?? null,
        current: currentById.get(id.permit_id) ?? null
      }
      const value = item(row, checkedAt)
      visit?.(value)
      digest.update(hashContext(canonicalRestoreAuditItem(value)))
      if (value.opening) summary.capturedCount++
      if (value.current) summary.currentCount++
      if (value.current && ['issued', 'unknown'].includes(value.current.status))
        summary.unresolvedCentralCount++
      if (value.expired) summary.expiredIssuedCount++
      if (value.changed) summary.changedCount++
      if (value.comparison === 'not_captured') summary.unexpectedCount++
      if (value.comparison === 'identity_changed') summary.identityChangedCount++
      if (value.comparison === 'missing_current') summary.missingCurrentCount++
      if (!value.metadataComplete) summary.incompleteMetadataCount++
      if (row.selected) {
        if (items.length < page.limit) items.push(value)
        else hasMore = true
      }
      cursor = value.permitId
    }
    if (ids.rows.length < 500) break
  }
  if (summary.capturedCount !== review.permitCount)
    throw new RestoreReviewError('RESTORE_REVIEW_CONFLICT')
  const basisHash = digest.update(hashContext(summary)).digest('hex')
  if (page.expectedBasisHash && page.expectedBasisHash !== basisHash)
    throw new RestoreReviewError('RESTORE_REVIEW_CONFLICT')
  return {
    caseId,
    restoreId: review.restoreId,
    frontierHash,
    basisHash,
    checkedAt,
    evidenceKind: 'central_metadata_comparison',
    localWatermarksRequired: true,
    canRelease: false,
    summary,
    items,
    nextAfter: hasMore ? items[items.length - 1].permitId : null
  }
}
