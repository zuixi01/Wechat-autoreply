import { z } from 'zod'
import type { PoolClient } from 'pg'
import { hashContext } from '../../../src/core/reply/hashes'
import { requestNonDispatchProof } from '../../../src/core/sending/request-seal-proof'
import { RestoreInventoryItemSchema } from '../../../src/shared/contracts/restore-inventory'
import {
  RestoreExecutionReviewInputSchema,
  type RestoreExecutionReviewInput
} from '../../../src/shared/contracts/restore-execution'
import { RequestSealSchema } from '../../../src/shared/contracts/request-seal'
import { ExecutionPermitSchema } from '../../../src/shared/contracts/execution'
import type { RestoreResolutionRecord } from '../../../src/shared/contracts/restore-resolution'
import {
  parseDeviceReconciliationReport,
  parseReconciliationDecision
} from '../../../src/shared/contracts/reconciliation'
import type { RestoreHistoryProof } from '../../../src/shared/contracts/restore-history'
import type { RestoreAssessment } from '../admin/restore-assessment'
import type { RestorePermitAuditItem } from '../admin/restore-permit-audit'
import { ReconciliationSnapshotSchema, ReconciliationNoteSchema } from '../admin/reconciliation'
import { restoreExecutionSubjects } from './restore-execution-proof'

export class RestoreResolutionError extends Error {
  constructor(readonly code: 'RESTORE_RESOLUTION_NOT_READY' | 'RESTORE_RESOLUTION_CONFLICT') {
    super(code)
  }
}
function fail(ready = false): never {
  throw new RestoreResolutionError(
    ready ? 'RESTORE_RESOLUTION_NOT_READY' : 'RESTORE_RESOLUTION_CONFLICT'
  )
}
const millis = (v: unknown): number =>
  z
    .number()
    .int()
    .nonnegative()
    .safe()
    .parse(new Date(v as string | Date).getTime())
type Scope = { tenant_id: string; actor_id: string }
export interface RestoreResolutionBasis {
  formatVersion: 1
  caseId: string
  uploadId: string
  reviewId: string
  assessmentBasisHash: string
  resolutionBasisHash: string
  centralPermits: number
  reconciledPermits: number
  appliedRequestSeals: number
  localExecutions: number
  separateReconciliationComplete: true
  automaticStart: false
  canRelease: false
}
/** Full authenticated assessment and verified source/review supplied by recovery composition.
 * Revalidates original reports, independent decisions and acknowledgements. Does not
 * upgrade unknown receipts or prove the restored device has reapplied its local journal. */
export async function readRestoreResolutionBasis(
  db: PoolClient,
  s: Scope,
  assessment: RestoreAssessment,
  raw: RestoreExecutionReviewInput,
  history: RestoreHistoryProof,
  now: number
): Promise<RestoreResolutionBasis> {
  return (await readRestoreResolutionEvidence(db, s, assessment, raw, history, now)).basis
}
/** Same complete verification, with the original independently applied records for
 * authenticated delivery to the restored host. No replacement physical receipts. */
export async function readRestoreResolutionEvidence(
  db: PoolClient,
  s: Scope,
  assessment: RestoreAssessment,
  raw: RestoreExecutionReviewInput,
  history: RestoreHistoryProof,
  now: number
): Promise<{
  basis: RestoreResolutionBasis
  subjects: ReturnType<typeof restoreExecutionSubjects>
  records: RestoreResolutionRecord[]
  localExecutions: Array<ReturnType<typeof RestoreInventoryItemSchema.parse>>
}> {
  z.number().int().nonnegative().safe().parse(now)
  const input = RestoreExecutionReviewInputSchema.parse(raw)
  if (
    input.tenantId !== s.tenant_id ||
    input.accountId !== history.scope.account_id ||
    history.scope.tenant_id !== s.tenant_id ||
    input.caseId !== assessment.caseId ||
    input.uploadId !== assessment.uploadId ||
    input.assessmentBasisHash !== assessment.basisHash ||
    input.historyProofId !== history.proofId ||
    input.caseId !== history.caseId ||
    input.uploadId !== history.uploadId
  )
    fail()
  const subjects = restoreExecutionSubjects(assessment),
    outcomes = new Map(input.outcomes.map((o) => [o.subjectKey, o]))
  if (outcomes.size !== subjects.length || input.outcomes.length !== subjects.length) fail()
  const bySubject = new Map(subjects.map((v) => [v.subjectKey, v]))
  const localItems = assessment.items
    .filter((i) => i.kind === 'local_execution')
    .map((item) => ({
      item,
      local: RestoreInventoryItemSchema.parse((item.metadata as { local: unknown }).local)
    }))
  const localsByGroup = new Map<string, typeof localItems>()
  for (const entry of localItems) {
    const subject = bySubject.get(entry.item.key)
    if (entry.local.kind !== 'execution' || !subject) fail()
    const entries = localsByGroup.get(subject.executionGroup) ?? []
    entries.push(entry)
    localsByGroup.set(subject.executionGroup, entries)
  }
  const groupOutcomes = new Map<string, (typeof input.outcomes)[number]>()
  for (const subject of subjects) {
    const o = outcomes.get(subject.subjectKey)
    if (!o || o.subjectHash !== subject.subjectHash || o.conversationId !== subject.conversationId)
      fail()
    const old = groupOutcomes.get(subject.executionGroup)
    if (
      old &&
      (old.outcome !== o.outcome ||
        (old.outcome === 'confirmed' &&
          o.outcome === 'confirmed' &&
          old.sourceMessageId !== o.sourceMessageId))
    )
      fail()
    groupOutcomes.set(subject.executionGroup, o)
  }
  const rows = (
    await db.query(
      `SELECT p.id AS permit_id,c.id AS case_id,c.snapshot_hash,
 CASE WHEN octet_length(c.snapshot_json::text)<=16384 THEN c.snapshot_json END AS snapshot_json,c.opened_at,
 r.agent_id AS report_agent,r.snapshot_hash AS report_snapshot_hash,r.report_hash,r.recorded_at AS report_at,
 CASE WHEN octet_length(r.report_json::text)<=16384 THEN r.report_json END AS report_json,
 d.id AS decision_id,d.case_id AS decision_case,d.agent_id AS decision_agent,d.snapshot_hash AS decision_snapshot_hash,
 d.report_hash AS decision_report_hash,d.outcome,d.note_id,d.decided_by,d.decided_at,
 CASE WHEN octet_length(d.decision_json::text)<=16384 THEN d.decision_json END AS decision_json,
 n.case_id AS note_case,n.snapshot_hash AS note_snapshot_hash,n.reference_id,n.evidence_hash,n.request_hash AS note_request_hash,
 n.observed_at AS note_observed_at,n.recorded_by AS note_by,n.recorded_at AS note_at,
 a.agent_id AS applied_agent,a.decision_hash,a.applied_at
 FROM execution_permits p
 LEFT JOIN reconciliation_cases c ON (c.tenant_id,c.account_id,c.permit_id)=(p.tenant_id,p.account_id,p.id)
 LEFT JOIN device_reconciliation_reports r ON (r.tenant_id,r.account_id,r.case_id)=(c.tenant_id,c.account_id,c.id)
 LEFT JOIN reconciliation_decisions d ON (d.tenant_id,d.account_id,d.permit_id)=(p.tenant_id,p.account_id,p.id)
 LEFT JOIN reconciliation_notes n ON (n.tenant_id,n.account_id,n.id)=(d.tenant_id,d.account_id,d.note_id)
 LEFT JOIN reconciliation_applied a ON (a.tenant_id,a.account_id,a.decision_id)=(d.tenant_id,d.account_id,d.id)
 WHERE p.tenant_id=$1 AND p.account_id=$2 ORDER BY p.id COLLATE "C"`,
      [s.tenant_id, input.accountId]
    )
  ).rows
  const byPermit = new Map(rows.map((r) => [r.permit_id, r])),
    facts: unknown[] = [],
    records: RestoreResolutionRecord[] = []
  const central = assessment.items.filter((item) => item.kind === 'central_permit')
  if (byPermit.size !== rows.length || rows.length !== central.length) fail()
  let reconciled = 0
  for (const item of central) {
    const audit = item.metadata as RestorePermitAuditItem,
      p = audit.current,
      r = p && byPermit.get(p.permitId),
      o = p && groupOutcomes.get(`permit:${p.permitId}`)
    if (
      !p ||
      !r ||
      !o ||
      !audit.metadataComplete ||
      p.loginEpoch === null ||
      !p.clientInstanceId ||
      !p.conversationId ||
      !p.taskHash ||
      p.draftRevision === null ||
      !p.expiresAt
    )
      fail()
    if (p.status === 'confirmed' || p.status === 'not_sent') {
      if (!p.settlementHash || !p.settledAt || millis(p.settledAt) > now || o.outcome !== p.status)
        fail()
      const fact = {
        permitId: p.permitId,
        status: p.status,
        settlementHash: p.settlementHash,
        settledAt: p.settledAt
      }
      facts.push(fact)
      records.push({
        kind: 'terminal_reference',
        fact,
        permit: ExecutionPermitSchema.parse({
          permitId: p.permitId,
          identity: {
            tenantId: s.tenant_id,
            accountId: input.accountId,
            employeeId: history.scope.employee_id,
            platform: history.scope.platform,
            agentId: p.agentId,
            loginEpoch: p.loginEpoch,
            clientInstanceId: p.clientInstanceId
          },
          taskId: p.taskId,
          taskHash: p.taskHash,
          draftHash: p.draftHash,
          draftRevision: p.draftRevision,
          conversationId: p.conversationId,
          leaseVersion: p.leaseVersion,
          issuedAt: millis(p.issuedAt),
          expiresAt: millis(p.expiresAt),
          status: p.status,
          newlyIssued: false,
          ...(p.purpose === 'human' ? { purpose: 'human', confirmationId: p.confirmationId } : {})
        })
      })
      continue
    }
    if (
      millis(p.expiresAt) > now ||
      !r.case_id ||
      !r.report_json ||
      !r.decision_json ||
      !r.applied_at
    )
      fail(true)
    const snapshot = ReconciliationSnapshotSchema.parse(r.snapshot_json),
      snapshotHash = hashContext(snapshot)
    if (
      snapshotHash !== r.snapshot_hash ||
      snapshot.tenantId !== s.tenant_id ||
      snapshot.accountId !== input.accountId ||
      snapshot.permitId !== p.permitId ||
      snapshot.agentId !== p.agentId ||
      snapshot.taskId !== p.taskId ||
      snapshot.taskHash !== p.taskHash ||
      snapshot.draftHash !== p.draftHash ||
      snapshot.draftRevision !== p.draftRevision ||
      snapshot.leaseVersion !== p.leaseVersion ||
      snapshot.loginEpoch !== p.loginEpoch ||
      snapshot.clientInstanceId !== p.clientInstanceId ||
      snapshot.conversationId !== p.conversationId ||
      snapshot.purpose !== p.purpose ||
      snapshot.confirmationId !== p.confirmationId ||
      snapshot.issuedAt !== millis(p.issuedAt) ||
      snapshot.expiresAt !== millis(p.expiresAt)
    )
      fail()
    const challenge = {
      caseId: r.case_id,
      snapshotHash,
      openedAt: millis(r.opened_at),
      permit: {
        permitId: p.permitId,
        identity: {
          tenantId: s.tenant_id,
          accountId: input.accountId,
          employeeId: history.scope.employee_id,
          agentId: p.agentId,
          platform: history.scope.platform,
          loginEpoch: p.loginEpoch,
          clientInstanceId: p.clientInstanceId
        },
        taskId: p.taskId,
        taskHash: p.taskHash,
        conversationId: p.conversationId,
        draftHash: p.draftHash,
        draftRevision: p.draftRevision,
        leaseVersion: p.leaseVersion,
        issuedAt: millis(p.issuedAt),
        expiresAt: millis(p.expiresAt),
        status: p.status,
        newlyIssued: false,
        ...(p.purpose === 'human'
          ? { purpose: 'human' as const, confirmationId: p.confirmationId! }
          : {})
      }
    }
    const report = parseDeviceReconciliationReport(r.report_json, challenge)
    const decision = parseReconciliationDecision(r.decision_json, report, hashContext(report)),
      decisionHash = hashContext(decision)
    const note = ReconciliationNoteSchema.parse({
      noteId: r.note_id,
      snapshotHash: r.note_snapshot_hash,
      referenceId: r.reference_id,
      evidenceHash: r.evidence_hash,
      observedAt: millis(r.note_observed_at)
    })
    if (
      r.report_agent !== p.agentId ||
      r.report_snapshot_hash !== snapshotHash ||
      r.report_hash !== hashContext(report) ||
      millis(r.report_at) < report.observation.observedAt ||
      r.decision_id !== decision.decisionId ||
      r.decision_case !== report.caseId ||
      r.decision_agent !== p.agentId ||
      r.decision_snapshot_hash !== snapshotHash ||
      r.decision_report_hash !== r.report_hash ||
      r.outcome !== decision.outcome ||
      r.note_id !== decision.noteId ||
      r.decided_by !== decision.decidedBy ||
      millis(r.decided_at) !== decision.decidedAt ||
      r.note_case !== report.caseId ||
      r.note_snapshot_hash !== snapshotHash ||
      hashContext({ caseId: report.caseId, ...note }) !== r.note_request_hash ||
      r.note_by !== decision.decidedBy ||
      note.observedAt < report.observation.observedAt ||
      note.observedAt > decision.decidedAt ||
      millis(r.note_at) > decision.decidedAt ||
      millis(r.report_at) > decision.decidedAt ||
      r.applied_agent !== p.agentId ||
      r.decision_hash !== decisionHash ||
      millis(r.applied_at) < decision.decidedAt ||
      millis(r.applied_at) > now ||
      decision.outcome !== o.outcome ||
      (o.outcome === 'confirmed' &&
        (report.observation.status !== 'confirmed' ||
          report.observation.sourceMessageId !== o.sourceMessageId))
    )
      fail()
    for (const { local } of localsByGroup.get(`permit:${p.permitId}`) ?? [])
      if (local.kind === 'execution' && local.executionId !== report.observation.executionId) fail()
    const fact = {
      permitId: p.permitId,
      caseId: r.case_id,
      snapshotHash,
      reportHash: r.report_hash,
      decisionHash,
      appliedAgent: r.applied_agent,
      appliedAt: millis(r.applied_at)
    }
    facts.push(fact)
    records.push({ kind: 'reconciled', fact, challenge, report, decision })
    reconciled++
  }
  const seals = (
    await db.query(
      `SELECT s.id,s.agent_id,s.task_id,s.execution_id,s.request_hash,s.seal_hash,s.sealed_at,
 CASE WHEN octet_length(s.seal_json::text)<=16384 THEN s.seal_json END AS seal_json,
 a.agent_id AS applied_agent,a.seal_hash AS applied_hash,a.execution_id AS applied_execution,a.applied_at
 FROM execution_request_seals s LEFT JOIN execution_request_seal_applications a
 ON (a.tenant_id,a.account_id,a.seal_id)=(s.tenant_id,s.account_id,s.id)
 WHERE s.tenant_id=$1 AND s.account_id=$2 ORDER BY s.id COLLATE "C"`,
      [s.tenant_id, input.accountId]
    )
  ).rows
  const sealsByExecution = new Map<string, ReturnType<typeof RequestSealSchema.parse>>()
  const centralTasks = new Set(
    central.map((i) => (i.metadata as RestorePermitAuditItem).current?.taskId)
  )
  for (const r of seals) {
    if (!r.applied_at) fail(true)
    const seal = RequestSealSchema.parse(r.seal_json),
      i = seal.input
    if (
      seal.sealId !== r.id ||
      seal.requestHash !== r.request_hash ||
      seal.requestHash !== hashContext(i) ||
      hashContext(seal) !== r.seal_hash ||
      seal.sealedAt !== millis(r.sealed_at) ||
      i.identity.tenantId !== s.tenant_id ||
      i.identity.accountId !== input.accountId ||
      i.identity.employeeId !== history.scope.employee_id ||
      i.identity.platform !== history.scope.platform ||
      i.identity.agentId !== r.agent_id ||
      i.request.taskId !== r.task_id ||
      i.executionId !== r.execution_id ||
      i.verificationProofHash !==
        requestNonDispatchProof({
          executionId: i.executionId,
          identity: i.identity,
          request: i.request
        }) ||
      r.applied_agent !== r.agent_id ||
      r.applied_hash !== r.seal_hash ||
      r.applied_execution !== r.execution_id ||
      millis(r.applied_at) < seal.sealedAt ||
      millis(r.applied_at) > now ||
      seal.sealedAt < i.stopped.stoppedAt ||
      centralTasks.has(i.request.taskId) ||
      sealsByExecution.has(i.executionId)
    )
      fail()
    sealsByExecution.set(i.executionId, seal)
    const fact = {
      sealId: seal.sealId,
      sealHash: r.seal_hash,
      requestHash: r.request_hash,
      executionId: i.executionId,
      appliedAgent: r.applied_agent,
      appliedAt: millis(r.applied_at)
    }
    facts.push(fact)
    records.push({ kind: 'request_seal', fact, seal })
  }
  let localCount = 0
  for (const { item, local } of localItems) {
    const subject = bySubject.get(item.key),
      o = outcomes.get(item.key)
    if (local.kind !== 'execution' || !subject || !o) fail()
    localCount++
    if (subject.executionGroup.startsWith('permit:')) continue
    if (o.outcome !== 'not_sent') fail(true)
    if (
      local.phase === null &&
      local.requestHash === null &&
      ['prepared', 'cancelled', 'rejected'].includes(local.status)
    )
      continue
    const seal = sealsByExecution.get(local.executionId)
    if (!seal) fail(true)
    if (
      hashContext(seal.input.identity) !== hashContext(local.identity) ||
      seal.input.request.taskId !== local.taskId ||
      seal.input.request.taskHash !== local.taskHash ||
      seal.input.request.draftHash !== local.draftHash
    )
      fail()
  }
  const basis = hashContext({
    formatVersion: 1,
    tenantId: s.tenant_id,
    accountId: input.accountId,
    caseId: input.caseId,
    uploadId: input.uploadId,
    reviewId: input.reviewId,
    assessmentBasisHash: assessment.basisHash,
    subjects,
    facts
  })
  const result: RestoreResolutionBasis = {
    formatVersion: 1,
    caseId: input.caseId,
    uploadId: input.uploadId,
    reviewId: input.reviewId,
    assessmentBasisHash: assessment.basisHash,
    resolutionBasisHash: basis,
    centralPermits: central.length,
    reconciledPermits: reconciled,
    appliedRequestSeals: seals.length,
    localExecutions: localCount,
    separateReconciliationComplete: true,
    automaticStart: false,
    canRelease: false
  }
  return { basis: result, subjects, records, localExecutions: localItems.map(({ local }) => local) }
}
