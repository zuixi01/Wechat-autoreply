import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import {
  RestoreAssessmentPageSchema,
  RestoreEvidenceInputSchema,
  RestoreEvidencePageSchema,
  RestoreEvidenceReceiptSchema,
  type RestoreEvidenceReceipt
} from '../../../src/shared/contracts/restore-assessment'
import { hashContext } from '../../../src/core/reply/hashes'
import { readCompleteRestoreInventory } from './restore-inventory'
import {
  readRestorePermitAudit,
  canonicalRestoreAuditItem,
  type RestorePermitAuditItem
} from './restore-permit-audit'
import { readRestoreReview, RestoreReviewError } from './restore-review'

type Scope = { tenant_id: string; actor_id: string }
export interface RestoreAssessmentSubject {
  key: string
  subjectHash: string
  kind: 'account' | 'local_message' | 'local_execution' | 'central_permit'
  requiredEvidence: 'device_stop' | 'message_history' | 'execution_outcome'
  reasons: string[]
  metadata: unknown
  canRelease: false
}
export interface RestoreAssessment {
  caseId: string
  uploadId: string
  basisHash: string
  evidenceKind: 'complete_metadata_assessment'
  summary: {
    localItems: number
    centralPermits: number
    centralAbsentLocally: number
    unresolvedCentral: number
    subjects: number
  }
  items: RestoreAssessmentSubject[]
  nextAfter: string | null
  canRelease: false
  externalEvidenceRequired: true
}
function conflict(): never {
  throw new RestoreReviewError('RESTORE_REVIEW_CONFLICT')
}
function subject(
  value: Omit<RestoreAssessmentSubject, 'subjectHash' | 'canRelease'>,
  canonicalMetadata: unknown = value.metadata
): RestoreAssessmentSubject {
  return {
    ...value,
    subjectHash: hashContext({ ...value, metadata: canonicalMetadata }),
    canRelease: false
  }
}
/** Independent administrator identity and the account lock are supplied by Administration. */
export async function readCompleteRestoreAssessment(
  db: PoolClient,
  s: Scope,
  accountId: string,
  caseId: string,
  uploadId: string
): Promise<RestoreAssessment> {
  const restored = await readCompleteRestoreInventory(db, s, accountId, caseId, uploadId)
  const central: RestorePermitAuditItem[] = []
  const audit = await readRestorePermitAudit(db, s, accountId, caseId, { limit: 1 }, (item) =>
    central.push(item)
  )
  const account = (
    await db.query(
      `SELECT a.id,a.employee_id,a.platform,a.enabled,a.paused,e.enabled AS employee_enabled
     FROM accounts a JOIN employees e ON (e.tenant_id,e.id)=(a.tenant_id,a.employee_id) WHERE a.tenant_id=$1 AND a.id=$2`,
      [s.tenant_id, accountId]
    )
  ).rows[0]
  if (!account || !account.paused) conflict()
  const agents = (
    await db.query(
      `SELECT id,employee_id,extract(epoch FROM revoked_at)::text AS revoked_at_epoch FROM agents WHERE tenant_id=$1 AND account_id=$2 ORDER BY id COLLATE "C"`,
      [s.tenant_id, accountId]
    )
  ).rows
  const leases = (
    await db.query(
      `SELECT agent_id,login_epoch::text,client_instance_id,version::text,extract(epoch FROM expires_at)::text AS expires_at_epoch,expires_at>clock_timestamp() AS active FROM account_leases WHERE tenant_id=$1 AND account_id=$2`,
      [s.tenant_id, accountId]
    )
  ).rows
  const items = [
    subject({
      key: `a:${hashContext({ tenantId: s.tenant_id, accountId, caseId })}`,
      kind: 'account',
      requiredEvidence: 'device_stop',
      reasons: [
        'all_devices_stop_evidence_required',
        ...(leases.some((lease) => lease.active) ? ['central_lease_active'] : [])
      ],
      metadata: {
        account,
        agents,
        leases,
        targetAgentId: restored.manifest.scope.agent_id,
        contextHash: restored.manifest.context.contextHash
      }
    })
  ]
  const localPermitIds = new Set<string>()
  for (const entry of restored.items) {
    if (entry.local.kind === 'execution' && entry.local.permitId)
      localPermitIds.add(entry.local.permitId)
    items.push(
      subject({
        key: `l:${entry.local.key}`,
        kind: entry.local.kind === 'message' ? 'local_message' : 'local_execution',
        requiredEvidence: entry.local.kind === 'message' ? 'message_history' : 'execution_outcome',
        reasons: [
          ...entry.differences,
          entry.local.kind === 'message'
            ? 'backup_after_history_required'
            : 'physical_outcome_required'
        ],
        metadata: entry
      })
    )
  }
  let centralAbsentLocally = 0
  for (const entry of central) {
    const absent = !localPermitIds.has(entry.permitId)
    if (absent) centralAbsentLocally++
    items.push(
      subject(
        {
          key: `p:${hashContext({ permitId: entry.permitId })}`,
          kind: 'central_permit',
          requiredEvidence: 'execution_outcome',
          reasons: [
            'physical_outcome_required',
            ...(absent ? ['absent_from_restored_ledger'] : []),
            ...(entry.outcomeReviewRequired ? ['central_outcome_unresolved'] : []),
            ...(entry.comparison === 'identity_changed' ? ['central_identity_changed'] : []),
            ...(entry.comparison === 'missing_current' ? ['central_permit_missing'] : [])
          ],
          metadata: entry
        },
        canonicalRestoreAuditItem(entry)
      )
    )
  }
  items.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  if (new Set(items.map((item) => item.key)).size !== items.length) conflict()
  const summary = {
    localItems: restored.items.length,
    centralPermits: central.length,
    centralAbsentLocally,
    unresolvedCentral: audit.summary.unresolvedCentralCount,
    subjects: items.length
  }
  const basisHash = hashContext({
    formatVersion: 1,
    caseId,
    uploadId,
    scope: restored.manifest.scope,
    context: restored.manifest.context,
    receipt: restored.receipt,
    centralBasisHash: audit.basisHash,
    subjects: items.map((item) => ({ key: item.key, subjectHash: item.subjectHash })),
    summary
  })
  return {
    caseId,
    uploadId,
    basisHash,
    evidenceKind: 'complete_metadata_assessment',
    summary,
    items,
    nextAfter: null,
    canRelease: false,
    externalEvidenceRequired: true
  }
}
export async function readRestoreAssessment(
  db: PoolClient,
  s: Scope,
  accountId: string,
  caseId: string,
  uploadId: string,
  input: unknown = {}
): Promise<RestoreAssessment> {
  const page = RestoreAssessmentPageSchema.parse(input),
    complete = await readCompleteRestoreAssessment(db, s, accountId, caseId, uploadId)
  if (page.expectedBasisHash && page.expectedBasisHash !== complete.basisHash) conflict()
  if (page.after && !complete.items.some((item) => item.key === page.after)) conflict()
  const candidates = complete.items.filter((item) => !page.after || item.key > page.after),
    items = candidates.slice(0, page.limit)
  return {
    ...complete,
    items,
    nextAfter: candidates.length > page.limit ? items[items.length - 1].key : null
  }
}
interface EvidenceRow {
  note_id: string
  upload_id: string
  basis_hash: string
  subject_key: string
  subject_hash: string
  request_hash: string
  request_json: unknown
  receipt_hash: string
  receipt_json: unknown
  recorded_by: string
  recorded_at: Date
}
function receipt(row: EvidenceRow, caseId: string, uploadId: string): RestoreEvidenceReceipt {
  const input = RestoreEvidenceInputSchema.parse(row.request_json),
    value = RestoreEvidenceReceiptSchema.parse(row.receipt_json)
  if (
    row.upload_id !== uploadId ||
    row.note_id !== input.noteId ||
    row.request_hash !== hashContext(input) ||
    row.basis_hash !== input.basisHash ||
    row.subject_key !== input.subjectKey ||
    row.subject_hash !== input.subjectHash ||
    row.receipt_hash !== hashContext(value) ||
    value.caseId !== caseId ||
    value.uploadId !== uploadId ||
    value.recordedBy !== row.recorded_by ||
    value.recordedAt !== new Date(row.recorded_at).getTime() ||
    hashContext(input) !==
      hashContext(
        RestoreEvidenceInputSchema.parse(
          Object.fromEntries(
            Object.keys(RestoreEvidenceInputSchema.shape).map((key) => [
              key,
              value[key as keyof typeof value]
            ])
          )
        )
      )
  )
    conflict()
  return value
}
export async function readRestoreEvidenceReference(
  db: PoolClient,
  s: Scope,
  accountId: string,
  caseId: string,
  uploadId: string,
  noteId: string
): Promise<RestoreEvidenceReceipt> {
  const row = (
    await db.query<EvidenceRow>(
      'SELECT * FROM ledger_restore_evidence WHERE tenant_id=$1 AND account_id=$2 AND case_id=$3 AND upload_id=$4 AND note_id=$5',
      [s.tenant_id, accountId, caseId, uploadId, noteId]
    )
  ).rows[0]
  if (!row) conflict()
  return receipt(row, caseId, uploadId)
}
export async function readRestoreEvidenceReferences(
  db: PoolClient,
  s: Scope,
  accountId: string,
  caseId: string,
  uploadId: string,
  noteIds: string[]
): Promise<Map<string, RestoreEvidenceReceipt>> {
  const rows = (
    await db.query<EvidenceRow>(
      'SELECT * FROM ledger_restore_evidence WHERE tenant_id=$1 AND account_id=$2 AND case_id=$3 AND upload_id=$4 AND note_id=ANY($5::uuid[])',
      [s.tenant_id, accountId, caseId, uploadId, [...new Set(noteIds)]]
    )
  ).rows
  return new Map(rows.map((row) => [row.note_id, receipt(row, caseId, uploadId)]))
}
export async function recordRestoreEvidence(
  db: PoolClient,
  s: Scope,
  accountId: string,
  caseId: string,
  uploadId: string,
  raw: unknown
): Promise<RestoreEvidenceReceipt> {
  const input = RestoreEvidenceInputSchema.parse(raw),
    complete = await readCompleteRestoreAssessment(db, s, accountId, caseId, uploadId)
  const old = (
    await db.query<EvidenceRow>(
      'SELECT * FROM ledger_restore_evidence WHERE tenant_id=$1 AND account_id=$2 AND case_id=$3 AND note_id=$4',
      [s.tenant_id, accountId, caseId, input.noteId]
    )
  ).rows[0]
  if (old) {
    if (old.request_hash !== hashContext(input)) conflict()
    // An idempotent retry returns historical metadata; it never re-certifies the current basis.
    return receipt(old, caseId, uploadId)
  }
  const bound = complete.items.find((item) => item.key === input.subjectKey)
  if (
    complete.basisHash !== input.basisHash ||
    !bound ||
    bound.subjectHash !== input.subjectHash ||
    bound.requiredEvidence !== input.kind
  )
    conflict()
  const review = await readRestoreReview(db, s, accountId, caseId)
  const now = Number(
    (await db.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now'))
      .rows[0].now
  )
  if (!Number.isSafeInteger(now) || input.observedAt < review.openedAt || input.observedAt > now)
    conflict()
  const value = RestoreEvidenceReceiptSchema.parse({
    ...input,
    caseId,
    uploadId,
    recordedBy: s.actor_id,
    recordedAt: now,
    canRelease: false
  })
  await db.query(
    `INSERT INTO ledger_restore_evidence(tenant_id,account_id,case_id,upload_id,note_id,request_hash,basis_hash,subject_key,subject_hash,request_json,receipt_hash,receipt_json,recorded_by,recorded_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12::jsonb,$13,$14)`,
    [
      s.tenant_id,
      accountId,
      caseId,
      uploadId,
      input.noteId,
      hashContext(input),
      input.basisHash,
      input.subjectKey,
      input.subjectHash,
      JSON.stringify(input),
      hashContext(value),
      JSON.stringify(value),
      s.actor_id,
      new Date(now).toISOString()
    ]
  )
  await db.query(
    `INSERT INTO audit_events(tenant_id,id,actor_id,kind,account_id,details_json) VALUES($1,$2,$3,'ledger_restore_evidence_recorded',$4,$5::jsonb)`,
    [
      s.tenant_id,
      randomUUID(),
      s.actor_id,
      accountId,
      JSON.stringify({
        caseId,
        uploadId,
        noteId: input.noteId,
        basisHash: input.basisHash,
        subjectKey: input.subjectKey,
        evidenceHash: input.evidenceHash
      })
    ]
  )
  return value
}
export async function readRestoreEvidence(
  db: PoolClient,
  s: Scope,
  accountId: string,
  caseId: string,
  uploadId: string,
  input: unknown = {}
): Promise<{
  items: { receipt: RestoreEvidenceReceipt; currentBasis: boolean }[]
  nextAfter: string | null
  canRelease: false
}> {
  const page = RestoreEvidencePageSchema.parse(input),
    complete = await readCompleteRestoreAssessment(db, s, accountId, caseId, uploadId)
  const rows = (
    await db.query<EvidenceRow>(
      `SELECT * FROM ledger_restore_evidence WHERE tenant_id=$1 AND account_id=$2 AND case_id=$3 AND upload_id=$4 AND ($5::uuid IS NULL OR note_id>$5::uuid) ORDER BY note_id LIMIT $6`,
      [s.tenant_id, accountId, caseId, uploadId, page.after ?? null, page.limit + 1]
    )
  ).rows
  const items = rows.slice(0, page.limit).map((row) => {
    const value = receipt(row, caseId, uploadId),
      bound = complete.items.find((item) => item.key === value.subjectKey)
    return {
      receipt: value,
      currentBasis:
        complete.basisHash === value.basisHash && bound?.subjectHash === value.subjectHash
    }
  })
  return {
    items,
    nextAfter: rows.length > page.limit ? items[items.length - 1].receipt.noteId : null,
    canRelease: false
  }
}
