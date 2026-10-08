import type { PoolClient } from 'pg'
import { z } from 'zod'
import {
  RestoreInventoryItemSchema,
  RestoreInventoryCompleteAckSchema,
  type RestoreInventoryManifest,
  type RestoreInventoryCompleteAck,
  type RestoreInventoryItem
} from '../../../src/shared/contracts/restore-inventory'
import { hashContext } from '../../../src/core/reply/hashes'
import {
  validateRestoreInventoryManifest,
  validateRestoreInventoryItem,
  verifyStoredRestoreInventory
} from '../execution/restore-inventory-authority'
import { readRestoreReview, RestoreReviewError } from './restore-review'
import { readRestorePauseDetail } from './restore-pause-reports'

type Scope = { tenant_id: string; actor_id: string }
const Page = z.strictObject({
  after: z.string().min(1).max(256).optional(),
  limit: z.number().int().min(1).max(100).default(50)
})
interface Row {
  id: string
  agent_id: string
  challenge_id: string
  manifest_hash: string
  manifest_json: unknown
  issued_at: Date
  expires_at: Date
  receipt_hash: string | null
  receipt_json: unknown | null
  recorded_at: Date | null
}
const Select = `SELECT u.*,r.receipt_hash,r.receipt_json,r.recorded_at FROM ledger_restore_inventory_uploads u
 LEFT JOIN ledger_restore_inventory_receipts r ON (r.tenant_id,r.account_id,r.upload_id)=(u.tenant_id,u.account_id,u.id)
 WHERE u.tenant_id=$1 AND u.account_id=$2 AND u.case_id=$3`
function conflict(): never {
  throw new RestoreReviewError('RESTORE_REVIEW_CONFLICT')
}
async function validate(
  db: PoolClient,
  s: Scope,
  accountId: string,
  caseId: string,
  row: Row
): Promise<{ manifest: RestoreInventoryManifest; receipt: RestoreInventoryCompleteAck | null }> {
  try {
    const review = await readRestoreReview(db, s, accountId, caseId),
      manifest = validateRestoreInventoryManifest(row.manifest_json)
    const pause = await readRestorePauseDetail(db, s, accountId, caseId, row.challenge_id)
    if (
      row.agent_id !== review.agentId ||
      manifest.scope.tenant_id !== s.tenant_id ||
      manifest.scope.account_id !== accountId ||
      manifest.scope.agent_id !== row.agent_id ||
      hashContext(manifest.scope) !== hashContext(pause.report.challenge.scope) ||
      manifest.context.contextHash !== review.contextHash ||
      manifest.context.restoreId !== review.restoreId ||
      hashContext(manifest) !== row.manifest_hash ||
      pause.contextHash !== manifest.context.contextHash
    )
      conflict()
    const receipt =
      row.receipt_json === null ? null : RestoreInventoryCompleteAckSchema.parse(row.receipt_json)
    if (
      receipt &&
      (hashContext(receipt) !== row.receipt_hash ||
        receipt.uploadId !== row.id ||
        receipt.manifestHash !== row.manifest_hash ||
        receipt.basisHash !== manifest.basisHash ||
        receipt.itemCount !== manifest.summary.messages + manifest.summary.executions)
    )
      conflict()
    if (receipt)
      await verifyStoredRestoreInventory(
        db,
        { tenant_id: s.tenant_id, account_id: accountId },
        row.id,
        manifest,
        receipt.pageCount
      )
    return { manifest, receipt }
  } catch {
    conflict()
  }
}
export async function readRestoreInventories(
  db: PoolClient,
  s: Scope,
  accountId: string,
  caseId: string,
  input: unknown = {}
): Promise<RestoreInventoryListing[]> {
  const page = Page.safeExtend({ after: z.uuid().optional() }).parse(input)
  await readRestoreReview(db, s, accountId, caseId)
  const rows = (
    await db.query<Row>(
      `${Select} AND ($4::uuid IS NULL OR u.id>$4::uuid) ORDER BY u.id LIMIT $5`,
      [s.tenant_id, accountId, caseId, page.after ?? null, page.limit]
    )
  ).rows
  const results: {
    uploadId: string
    state: 'receiving' | 'inventory_received'
    basisHash: string
    manifestHash: string
    itemCount: number
    recordedAt: number | null
    canRelease: false
    externalEvidenceRequired: true
  }[] = []
  for (const row of rows) {
    const { manifest, receipt } = await validate(db, s, accountId, caseId, row)
    results.push({
      uploadId: row.id,
      state: receipt ? 'inventory_received' : 'receiving',
      basisHash: manifest.basisHash,
      manifestHash: row.manifest_hash,
      itemCount: receipt?.itemCount ?? 0,
      recordedAt: row.recorded_at ? new Date(row.recorded_at).getTime() : null,
      canRelease: false,
      externalEvidenceRequired: true
    })
  }
  return results
}
export interface RestoreInventoryListing {
  uploadId: string
  state: 'receiving' | 'inventory_received'
  basisHash: string
  manifestHash: string
  itemCount: number
  recordedAt: number | null
  canRelease: false
  externalEvidenceRequired: true
}
interface Central {
  permitId: string
  agentId: string
  taskId: string
  taskHash: string | null
  draftHash: string
  loginEpoch: number | null
  clientInstanceId: string | null
  conversationId: string | null
  status: string
  settlementHash: string | null
}
export interface RestoreInventoryComparisonItem {
  local: RestoreInventoryItem
  central: Central | null
  differences: string[]
  requiresOutcomeReview: true
}
export interface RestoreInventoryComparison {
  uploadId: string
  basisHash: string
  evidenceKind: 'restored_and_central_metadata'
  items: RestoreInventoryComparisonItem[]
  nextAfter: string | null
  canRelease: false
  externalEvidenceRequired: true
}
export async function readCompleteRestoreInventory(
  db: PoolClient,
  s: Scope,
  accountId: string,
  caseId: string,
  uploadId: string
): Promise<{
  manifest: RestoreInventoryManifest
  receipt: RestoreInventoryCompleteAck
  items: RestoreInventoryComparisonItem[]
}> {
  await readRestoreReview(db, s, accountId, caseId)
  const row = (
    await db.query<Row>(`${Select} AND u.id=$4`, [s.tenant_id, accountId, caseId, uploadId])
  ).rows[0]
  if (!row) throw new RestoreReviewError('RESTORE_REVIEW_NOT_FOUND')
  const { manifest, receipt } = await validate(db, s, accountId, caseId, row)
  if (!receipt) conflict()
  const rows = (
    await db.query(
      `SELECT i.item_key,i.item_hash,i.item_json,
    CASE WHEN p.id IS NULL THEN NULL ELSE jsonb_build_object('permitId',p.id,'agentId',p.agent_id,'taskId',p.task_id,'taskHash',p.task_hash,'draftHash',p.draft_hash,'loginEpoch',p.login_epoch,'clientInstanceId',p.client_instance_id,'conversationId',p.conversation_id,'status',p.status,'settlementHash',p.settlement_hash) END AS central
    FROM ledger_restore_inventory_items i LEFT JOIN execution_permits p ON p.tenant_id=i.tenant_id AND p.account_id=i.account_id AND i.item_json->>'kind'='execution' AND p.id=i.item_json->>'permitId'
    WHERE i.tenant_id=$1 AND i.account_id=$2 AND i.upload_id=$3 ORDER BY i.item_key`,
      [s.tenant_id, accountId, uploadId]
    )
  ).rows
  const items: RestoreInventoryComparisonItem[] = rows.map((saved) => {
    const local = RestoreInventoryItemSchema.parse(saved.item_json)
    validateRestoreInventoryItem(local, manifest)
    if (local.key !== saved.item_key || hashContext(local) !== saved.item_hash) conflict()
    const central = saved.central as Central | null,
      differences: string[] = []
    if (local.kind === 'message') {
      if (!local.sequenceComplete || local.hasGap) differences.push('local_sequence_gap')
      if (!local.identityVerified || !local.messageIdVerified)
        differences.push('local_identity_unverified')
      if (local.humanOwned) differences.push('human_owned')
      if (local.direction === 'inbound' && local.handledBy === null)
        differences.push('unhandled_inbound')
    } else {
      if (!central)
        differences.push(local.permitId ? 'central_permit_missing' : 'local_permit_absent')
      else {
        if (
          central.agentId !== local.identity.agentId ||
          central.loginEpoch !== local.identity.loginEpoch ||
          central.clientInstanceId !== local.identity.clientInstanceId ||
          central.conversationId !== local.conversationId
        )
          differences.push('central_identity_mismatch')
        if (
          central.taskId !== local.taskId ||
          central.taskHash !== local.taskHash ||
          central.draftHash !== local.draftHash
        )
          differences.push('central_task_mismatch')
        if (central.status !== local.permitStatus) differences.push('central_status_changed')
        if (central.settlementHash !== local.receiptHash)
          differences.push('central_receipt_mismatch')
        if (central.status === 'issued' || central.status === 'unknown' || !central.settlementHash)
          differences.push('central_outcome_unresolved')
      }
      if (
        local.status === 'unknown' ||
        local.receiptStatus === 'unknown' ||
        local.permitStatus === 'unknown'
      )
        differences.push('local_unknown')
      if (!local.localRangePresent) differences.push('local_range_missing')
    }
    return { local, central, differences, requiresOutcomeReview: true }
  })
  if (items.length !== receipt.itemCount) conflict()
  return { manifest, receipt, items }
}
export async function readRestoreInventoryItems(
  db: PoolClient,
  s: Scope,
  accountId: string,
  caseId: string,
  uploadId: string,
  input: unknown = {}
): Promise<RestoreInventoryComparison> {
  const page = Page.parse(input)
  const complete = await readCompleteRestoreInventory(db, s, accountId, caseId, uploadId)
  const candidates = complete.items.filter((item) => !page.after || item.local.key > page.after)
  const items = candidates.slice(0, page.limit)
  return {
    uploadId,
    basisHash: complete.manifest.basisHash,
    evidenceKind: 'restored_and_central_metadata',
    items,
    nextAfter: candidates.length > page.limit ? items[items.length - 1].local.key : null,
    canRelease: false,
    externalEvidenceRequired: true
  }
}
