import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import {
  RestoreRulingInputSchema,
  RestoreRulingReceiptSchema,
  RestoreRulingsPageSchema,
  RestoreDecisionInputSchema,
  RestoreDecisionReceiptSchema,
  type RestoreRulingReceipt,
  type RestoreDecisionReceipt
} from '../../../src/shared/contracts/restore-decision'
import { hashContext } from '../../../src/core/reply/hashes'
import {
  readCompleteRestoreAssessment,
  readRestoreEvidenceReference,
  readRestoreEvidenceReferences
} from './restore-assessment'
import { readCompleteRestoreInventory } from './restore-inventory'
import { RestoreReviewError } from './restore-review'

type Scope = { tenant_id: string; actor_id: string }
interface Row {
  upload_id: string
  basis_hash: string
  request_hash: string
  request_json: unknown
  receipt_hash: string
  receipt_json: unknown
  recorded_by: string
  recorded_at: Date
}
interface RulingRow extends Row {
  ruling_id: string
  subject_key: string
  revision: string
  previous_ruling_id: string | null
  note_id: string
}
interface DecisionRow extends Row {
  decision_id: string
  rulings_hash: string
}
function conflict(): never {
  throw new RestoreReviewError('RESTORE_REVIEW_CONFLICT')
}
function project(value: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((key) => [key, value[key]]))
}
function verifyCommon(
  row: Row,
  request: unknown,
  value: RestoreRulingReceipt | RestoreDecisionReceipt,
  caseId: string,
  uploadId: string
): void {
  const recordedBy = 'recordedBy' in value ? value.recordedBy : value.decidedBy
  const recordedAt = 'recordedAt' in value ? value.recordedAt : value.decidedAt
  if (
    row.upload_id !== uploadId ||
    value.caseId !== caseId ||
    value.uploadId !== uploadId ||
    row.basis_hash !== value.basisHash ||
    row.request_hash !== hashContext(request) ||
    row.receipt_hash !== hashContext(value) ||
    row.recorded_by !== recordedBy ||
    new Date(row.recorded_at).getTime() !== recordedAt
  )
    conflict()
}
function parseRuling(row: RulingRow, caseId: string, uploadId: string): RestoreRulingReceipt {
  const request = RestoreRulingInputSchema.parse(row.request_json)
  const value = RestoreRulingReceiptSchema.parse(row.receipt_json)
  verifyCommon(row, request, value, caseId, uploadId)
  if (
    hashContext(request) !==
      hashContext(
        RestoreRulingInputSchema.parse(project(value, Object.keys(RestoreRulingInputSchema.shape)))
      ) ||
    value.rulingId !== row.ruling_id ||
    value.subjectKey !== row.subject_key ||
    String(value.revision) !== String(row.revision) ||
    value.expectedPreviousRulingId !== row.previous_ruling_id ||
    value.noteId !== row.note_id
  )
    conflict()
  return value
}
function parseDecision(row: DecisionRow, caseId: string, uploadId: string): RestoreDecisionReceipt {
  const request = RestoreDecisionInputSchema.parse(row.request_json)
  const value = RestoreDecisionReceiptSchema.parse(row.receipt_json)
  verifyCommon(row, request, value, caseId, uploadId)
  if (
    hashContext(request) !==
      hashContext(
        RestoreDecisionInputSchema.parse(
          project(value, Object.keys(RestoreDecisionInputSchema.shape))
        )
      ) ||
    value.decisionId !== row.decision_id ||
    value.rulingsHash !== row.rulings_hash
  )
    conflict()
  return value
}
async function time(db: PoolClient): Promise<number> {
  const now = Number(
    (await db.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now'))
      .rows[0].now
  )
  if (!Number.isSafeInteger(now) || now < 0) conflict()
  return now
}
async function audit(
  db: PoolClient,
  s: Scope,
  accountId: string,
  kind: string,
  details: unknown
): Promise<void> {
  await db.query(
    'INSERT INTO audit_events(tenant_id,id,actor_id,kind,account_id,details_json) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
    [s.tenant_id, randomUUID(), s.actor_id, kind, accountId, JSON.stringify(details)]
  )
}
/** Validate every revision and its immutable evidence, not just the latest displayed row. */
async function latestRulings(
  db: PoolClient,
  s: Scope,
  accountId: string,
  caseId: string,
  uploadId: string,
  basisHash: string
): Promise<Map<string, RestoreRulingReceipt>> {
  const rows = (
    await db.query<RulingRow>(
      'SELECT * FROM ledger_restore_rulings WHERE tenant_id=$1 AND account_id=$2 AND case_id=$3 AND upload_id=$4 ORDER BY basis_hash COLLATE "C",subject_key COLLATE "C",revision',
      [s.tenant_id, accountId, caseId, uploadId]
    )
  ).rows
  const evidence = await readRestoreEvidenceReferences(
    db,
    s,
    accountId,
    caseId,
    uploadId,
    rows.map((row) => row.note_id)
  )
  const result = new Map<string, RestoreRulingReceipt>()
  for (const row of rows) {
    const value = parseRuling(row, caseId, uploadId),
      previous = result.get(`${value.basisHash}:${value.subjectKey}`),
      note = evidence.get(value.noteId)
    if (
      value.revision !== (previous?.revision ?? 0) + 1 ||
      value.expectedPreviousRulingId !== (previous?.rulingId ?? null) ||
      (previous &&
        (value.subjectHash !== previous.subjectHash || value.recordedAt < previous.recordedAt)) ||
      !note ||
      hashContext(note) !== value.noteReceiptHash ||
      note.basisHash !== value.basisHash ||
      note.subjectKey !== value.subjectKey ||
      note.subjectHash !== value.subjectHash ||
      note.recordedAt > value.recordedAt
    )
      conflict()
    result.set(`${value.basisHash}:${value.subjectKey}`, value)
  }
  return new Map(
    [...result.values()]
      .filter((value) => value.basisHash === basisHash)
      .map((value) => [value.subjectKey, value])
  )
}
interface CoverageItem {
  subjectKey: string
  subjectHash: string
  latestRuling: RestoreRulingReceipt | null
}
interface Coverage {
  basisHash: string
  rulingsHash: string
  summary: { subjects: number; accepted: number; held: number; missing: number }
  items: CoverageItem[]
  nextAfter: string | null
  canRelease: false
}
function summarize(basisHash: string, items: CoverageItem[]): Coverage {
  const summary = { subjects: items.length, accepted: 0, held: 0, missing: 0 }
  for (const item of items) {
    if (!item.latestRuling) summary.missing++
    else if (item.latestRuling.outcome === 'hold') summary.held++
    else summary.accepted++
  }
  return {
    basisHash,
    summary,
    items,
    nextAfter: null,
    canRelease: false,
    rulingsHash: hashContext({
      formatVersion: 1,
      basisHash,
      summary,
      subjects: items.map((item) => ({
        key: item.subjectKey,
        subjectHash: item.subjectHash,
        rulingHash: item.latestRuling ? hashContext(item.latestRuling) : null
      }))
    })
  }
}
async function coverage(
  db: PoolClient,
  s: Scope,
  accountId: string,
  caseId: string,
  uploadId: string
): Promise<Coverage> {
  const assessment = await readCompleteRestoreAssessment(db, s, accountId, caseId, uploadId)
  const latest = await latestRulings(db, s, accountId, caseId, uploadId, assessment.basisHash)
  const subjects = new Map(assessment.items.map((item) => [item.key, item]))
  for (const ruling of latest.values()) {
    const bound = subjects.get(ruling.subjectKey)
    if (!bound || ruling.subjectHash !== bound.subjectHash) conflict()
  }
  return summarize(
    assessment.basisHash,
    assessment.items.map((subject) => ({
      subjectKey: subject.key,
      subjectHash: subject.subjectHash,
      latestRuling: latest.get(subject.key) ?? null
    }))
  )
}
/** Administration supplies independent authentication and the shared account row lock. */
export async function readRestoreRulings(
  db: PoolClient,
  s: Scope,
  accountId: string,
  caseId: string,
  uploadId: string,
  raw: unknown = {}
): Promise<Coverage> {
  const page = RestoreRulingsPageSchema.parse(raw),
    complete = await coverage(db, s, accountId, caseId, uploadId)
  if (
    (page.expectedBasisHash && page.expectedBasisHash !== complete.basisHash) ||
    (page.expectedRulingsHash && page.expectedRulingsHash !== complete.rulingsHash) ||
    (page.after && !complete.items.some((item) => item.subjectKey === page.after))
  )
    conflict()
  const candidates = complete.items.filter((item) => !page.after || item.subjectKey > page.after),
    items = candidates.slice(0, page.limit)
  return {
    ...complete,
    items,
    nextAfter: candidates.length > page.limit ? items[items.length - 1].subjectKey : null
  }
}
export async function recordRestoreRuling(
  db: PoolClient,
  s: Scope,
  accountId: string,
  caseId: string,
  uploadId: string,
  raw: unknown
): Promise<RestoreRulingReceipt> {
  const input = RestoreRulingInputSchema.parse(raw)
  const complete = await coverage(db, s, accountId, caseId, uploadId)
  const old = (
    await db.query<RulingRow>(
      'SELECT * FROM ledger_restore_rulings WHERE tenant_id=$1 AND account_id=$2 AND case_id=$3 AND ruling_id=$4',
      [s.tenant_id, accountId, caseId, input.rulingId]
    )
  ).rows[0]
  if (old) {
    if (old.request_hash !== hashContext(input)) conflict()
    // Historical retry does not re-certify the current assessment.
    await latestRulings(db, s, accountId, caseId, uploadId, input.basisHash)
    return parseRuling(old, caseId, uploadId)
  }
  const bound = complete.items.find((item) => item.subjectKey === input.subjectKey)
  if (
    complete.basisHash !== input.basisHash ||
    !bound ||
    bound.subjectHash !== input.subjectHash ||
    input.expectedPreviousRulingId !== (bound.latestRuling?.rulingId ?? null)
  )
    conflict()
  const sealed = (
    await db.query<DecisionRow>(
      'SELECT * FROM ledger_restore_decisions WHERE tenant_id=$1 AND account_id=$2 AND case_id=$3 AND upload_id=$4',
      [s.tenant_id, accountId, caseId, uploadId]
    )
  ).rows.map((row) => parseDecision(row, caseId, uploadId))
  // A damaged lookup column cannot hide an immutable decision from the freeze check.
  if (sealed.some((decision) => decision.basisHash === input.basisHash)) conflict()
  const evidence = await readRestoreEvidenceReference(
    db,
    s,
    accountId,
    caseId,
    uploadId,
    input.noteId
  )
  const assessment = await readCompleteRestoreAssessment(db, s, accountId, caseId, uploadId)
  const subject = assessment.items.find((item) => item.key === input.subjectKey)
  const now = await time(db)
  if (
    assessment.basisHash !== input.basisHash ||
    !subject ||
    evidence.kind !== subject.requiredEvidence ||
    hashContext(evidence) !== input.noteReceiptHash ||
    evidence.basisHash !== input.basisHash ||
    evidence.subjectKey !== input.subjectKey ||
    evidence.subjectHash !== input.subjectHash ||
    evidence.recordedAt > now
  )
    conflict()
  const value = RestoreRulingReceiptSchema.parse({
    ...input,
    caseId,
    uploadId,
    revision: (bound.latestRuling?.revision ?? 0) + 1,
    recordedBy: s.actor_id,
    recordedAt: now,
    canRelease: false
  })
  await db.query(
    `INSERT INTO ledger_restore_rulings(tenant_id,account_id,case_id,upload_id,ruling_id,basis_hash,subject_key,revision,previous_ruling_id,note_id,request_hash,request_json,receipt_hash,receipt_json,recorded_by,recorded_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14::jsonb,$15,$16)`,
    [
      s.tenant_id,
      accountId,
      caseId,
      uploadId,
      input.rulingId,
      input.basisHash,
      input.subjectKey,
      value.revision,
      input.expectedPreviousRulingId,
      input.noteId,
      hashContext(input),
      JSON.stringify(input),
      hashContext(value),
      JSON.stringify(value),
      s.actor_id,
      new Date(now).toISOString()
    ]
  )
  await audit(db, s, accountId, 'ledger_restore_ruling_recorded', {
    caseId,
    uploadId,
    rulingId: value.rulingId,
    basisHash: value.basisHash,
    subjectKey: value.subjectKey,
    revision: value.revision,
    outcome: value.outcome
  })
  return value
}
async function verifyDecision(
  db: PoolClient,
  s: Scope,
  accountId: string,
  caseId: string,
  uploadId: string,
  row: DecisionRow
): Promise<RestoreDecisionReceipt> {
  const value = parseDecision(row, caseId, uploadId)
  const inventory = await readCompleteRestoreInventory(db, s, accountId, caseId, uploadId)
  if (
    value.restoreId !== inventory.manifest.context.restoreId.toLowerCase() ||
    value.targetAgentId !== inventory.manifest.scope.agent_id ||
    value.contextHash !== inventory.manifest.context.contextHash ||
    value.inventoryBasisHash !== inventory.manifest.basisHash
  )
    conflict()
  const latest = await latestRulings(db, s, accountId, caseId, uploadId, value.basisHash)
  const items = [...latest.values()]
    .sort((a, b) => (a.subjectKey < b.subjectKey ? -1 : a.subjectKey > b.subjectKey ? 1 : 0))
    .map((ruling) => ({
      subjectKey: ruling.subjectKey,
      subjectHash: ruling.subjectHash,
      latestRuling: ruling
    }))
  const saved = summarize(value.basisHash, items)
  if (
    saved.rulingsHash !== value.rulingsHash ||
    saved.summary.subjects !== value.subjectCount ||
    saved.summary.held ||
    saved.summary.missing ||
    items.some((item) => item.latestRuling.recordedAt > value.decidedAt)
  )
    conflict()
  return value
}
export async function sealRestoreDecision(
  db: PoolClient,
  s: Scope,
  accountId: string,
  caseId: string,
  uploadId: string,
  raw: unknown
): Promise<RestoreDecisionReceipt> {
  const input = RestoreDecisionInputSchema.parse(raw)
  const complete = await coverage(db, s, accountId, caseId, uploadId)
  const old = (
    await db.query<DecisionRow>(
      'SELECT * FROM ledger_restore_decisions WHERE tenant_id=$1 AND account_id=$2 AND case_id=$3 AND decision_id=$4',
      [s.tenant_id, accountId, caseId, input.decisionId]
    )
  ).rows[0]
  if (old) {
    if (old.request_hash !== hashContext(input)) conflict()
    return verifyDecision(db, s, accountId, caseId, uploadId, old)
  }
  if (
    complete.basisHash !== input.basisHash ||
    complete.rulingsHash !== input.rulingsHash ||
    complete.summary.held ||
    complete.summary.missing ||
    complete.summary.subjects < 1
  )
    conflict()
  const sealed = (
    await db.query<DecisionRow>(
      'SELECT * FROM ledger_restore_decisions WHERE tenant_id=$1 AND account_id=$2 AND case_id=$3 AND upload_id=$4',
      [s.tenant_id, accountId, caseId, uploadId]
    )
  ).rows.map((row) => parseDecision(row, caseId, uploadId))
  if (sealed.some((decision) => decision.basisHash === input.basisHash)) conflict()
  const inventory = await readCompleteRestoreInventory(db, s, accountId, caseId, uploadId)
  const now = await time(db)
  if (complete.items.some((item) => item.latestRuling!.recordedAt > now)) conflict()
  const value = RestoreDecisionReceiptSchema.parse({
    ...input,
    caseId,
    uploadId,
    restoreId: inventory.manifest.context.restoreId,
    targetAgentId: inventory.manifest.scope.agent_id,
    contextHash: inventory.manifest.context.contextHash,
    inventoryBasisHash: inventory.manifest.basisHash,
    subjectCount: complete.summary.subjects,
    decidedBy: s.actor_id,
    decidedAt: now,
    applicationRequired: true,
    automaticStart: false,
    canRelease: false
  })
  await db.query(
    `INSERT INTO ledger_restore_decisions(tenant_id,account_id,case_id,upload_id,decision_id,basis_hash,rulings_hash,request_hash,request_json,receipt_hash,receipt_json,recorded_by,recorded_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb,$12,$13)`,
    [
      s.tenant_id,
      accountId,
      caseId,
      uploadId,
      input.decisionId,
      input.basisHash,
      input.rulingsHash,
      hashContext(input),
      JSON.stringify(input),
      hashContext(value),
      JSON.stringify(value),
      s.actor_id,
      new Date(now).toISOString()
    ]
  )
  await audit(db, s, accountId, 'ledger_restore_decision_sealed', {
    caseId,
    uploadId,
    decisionId: value.decisionId,
    basisHash: value.basisHash,
    rulingsHash: value.rulingsHash,
    subjectCount: value.subjectCount
  })
  return value
}
export async function readRestoreDecision(
  db: PoolClient,
  s: Scope,
  accountId: string,
  caseId: string,
  uploadId: string,
  decisionId: string
): Promise<{ decision: RestoreDecisionReceipt; currentBasis: boolean; canRelease: false }> {
  const complete = await coverage(db, s, accountId, caseId, uploadId)
  const row = (
    await db.query<DecisionRow>(
      'SELECT * FROM ledger_restore_decisions WHERE tenant_id=$1 AND account_id=$2 AND case_id=$3 AND upload_id=$4 AND decision_id=$5',
      [s.tenant_id, accountId, caseId, uploadId, decisionId]
    )
  ).rows[0]
  if (!row) throw new RestoreReviewError('RESTORE_REVIEW_NOT_FOUND')
  const decision = await verifyDecision(db, s, accountId, caseId, uploadId, row)
  return {
    decision,
    currentBasis:
      decision.basisHash === complete.basisHash && decision.rulingsHash === complete.rulingsHash,
    canRelease: false
  }
}
