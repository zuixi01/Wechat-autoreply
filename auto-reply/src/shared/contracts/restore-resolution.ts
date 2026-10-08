import { z } from 'zod'
import { Hash, Id } from './identity'
import { ExecutionPermitSchema } from './execution'
import { RestoreInventoryItemSchema } from './restore-inventory'
import {
  RestoreExecutionReviewInputSchema,
  RestoreExecutionReviewReceiptSchema,
  RestoreExecutionSubjectSchema
} from './restore-execution'
import {
  ReconciliationChallengeSchema,
  DeviceReconciliationReportSchema,
  ReconciliationDecisionSchema,
  parseDeviceReconciliationReport,
  parseReconciliationDecision
} from './reconciliation'
import { RequestSealSchema } from './request-seal'
import { RestoreRecoveryCurrentSchema, type RestoreRecoveryPackage } from './restore-recovery'
import { hashContext } from '../../core/reply/hashes'
import { requestNonDispatchProof } from '../../core/sending/request-seal-proof'

const Millis = z.number().int().nonnegative().safe()
const TerminalFact = z.strictObject({
  permitId: Id,
  status: z.enum(['confirmed', 'not_sent']),
  settlementHash: Hash,
  settledAt: z.iso.datetime({ offset: true }).max(128)
})
const ReconciledFact = z.strictObject({
  permitId: Id,
  caseId: z.uuid(),
  snapshotHash: Hash,
  reportHash: Hash,
  decisionHash: Hash,
  appliedAgent: Id,
  appliedAt: Millis
})
const SealFact = z.strictObject({
  sealId: z.uuid(),
  sealHash: Hash,
  requestHash: Hash,
  executionId: Id,
  appliedAgent: Id,
  appliedAt: Millis
})
export const RestoreResolutionRecordSchema = z.discriminatedUnion('kind', [
  // The legacy server retains only the original terminal receipt hash. Never
  // fabricate its body or call a terminal metadata reference physical evidence.
  z.strictObject({
    kind: z.literal('terminal_reference'),
    fact: TerminalFact,
    permit: ExecutionPermitSchema
  }),
  z.strictObject({
    kind: z.literal('reconciled'),
    fact: ReconciledFact,
    challenge: ReconciliationChallengeSchema,
    report: DeviceReconciliationReportSchema,
    decision: ReconciliationDecisionSchema
  }),
  z.strictObject({ kind: z.literal('request_seal'), fact: SealFact, seal: RequestSealSchema })
])
export const RestoreResolutionLookupSchema = RestoreRecoveryCurrentSchema.extend({
  authorizationId: z.uuid().toLowerCase()
})
export const RestoreResolutionPackageSchema = z.strictObject({
  formatVersion: z.literal(1),
  authorizationId: z.uuid().toLowerCase(),
  authorizationHash: Hash,
  boundaryHash: Hash,
  resolutionBasisHash: Hash,
  review: RestoreExecutionReviewInputSchema,
  reviewReceipt: RestoreExecutionReviewReceiptSchema,
  subjects: z.array(RestoreExecutionSubjectSchema).max(2000000),
  localExecutions: z
    .array(RestoreInventoryItemSchema)
    .max(100000)
    .refine((items) => items.every((item) => item.kind === 'execution')),
  records: z.array(RestoreResolutionRecordSchema).max(2000000),
  automaticStart: z.literal(false),
  canRelease: z.literal(false)
})
export type RestoreResolutionRecord = z.infer<typeof RestoreResolutionRecordSchema>
export type RestoreResolutionPackage = z.infer<typeof RestoreResolutionPackageSchema>
export const RestoreResolutionLocalReceiptSchema = z.strictObject({
  formatVersion: z.literal(1),
  applicationId: z.uuid().toLowerCase(),
  boundaryApplicationId: z.uuid().toLowerCase(),
  authorizationId: z.uuid().toLowerCase(),
  authorizationHash: Hash,
  boundaryHash: Hash,
  resolutionBasisHash: Hash,
  packageHash: Hash,
  restoreId: z.uuid().toLowerCase(),
  contextHash: Hash,
  localExecutions: Millis,
  centralPermits: Millis,
  requestSeals: Millis,
  appliedAt: Millis,
  originalExecutionRecordsPreserved: z.literal(true),
  centralConfirmationRequired: z.literal(true),
  automaticStart: z.literal(false),
  canRelease: z.literal(false)
})
export type RestoreResolutionLocalReceipt = z.infer<typeof RestoreResolutionLocalReceiptSchema>
export function restoreExecutionPrincipalHash(p: {
  agentId: string
  loginEpoch: number | string
  clientInstanceId: string
  taskId: string
  taskHash: string
  draftHash: string
  conversationId: string
}): string {
  return hashContext({ ...p, loginEpoch: String(p.loginEpoch) })
}
function fail(): never {
  throw Error('restore_resolution_package_conflict')
}
/** Authenticated target transport is required by the caller. Hashes are bindings,
 * not signatures or physical verification. Complete independent facts stay separate. */
export function parseRestoreResolutionPackage(
  raw: unknown,
  boundary: RestoreRecoveryPackage
): RestoreResolutionPackage {
  if (Buffer.byteLength(JSON.stringify(raw) ?? '') > 2097152) fail()
  const p = RestoreResolutionPackageSchema.parse(raw),
    a = boundary.authorization,
    review = p.review,
    receipt = p.reviewReceipt
  if (
    p.authorizationId !== a.authorizationId ||
    p.authorizationHash !== hashContext(a) ||
    p.boundaryHash !== a.boundaryHash ||
    p.resolutionBasisHash !== a.resolutionBasisHash ||
    hashContext(receipt) !== a.executionReceiptHash ||
    receipt.requestHash !== hashContext(review) ||
    receipt.subjectsSnapshotHash !== hashContext(p.subjects) ||
    receipt.outcomesHash !==
      hashContext([...review.outcomes].sort((x, y) => (x.subjectKey < y.subjectKey ? -1 : 1))) ||
    review.reviewId !== a.reviewId ||
    review.caseId !== a.caseId ||
    review.uploadId !== a.uploadId ||
    review.tenantId !== a.scope.tenant_id ||
    review.accountId !== a.scope.account_id ||
    review.assessmentBasisHash !== a.assessmentBasisHash ||
    review.historyProofId !== a.historyProofId ||
    receipt.reviewId !== review.reviewId ||
    receipt.caseId !== review.caseId ||
    receipt.uploadId !== review.uploadId ||
    receipt.tenantId !== review.tenantId ||
    receipt.accountId !== review.accountId ||
    receipt.historyProofId !== review.historyProofId ||
    receipt.assessmentBasisHash !== review.assessmentBasisHash ||
    receipt.historyReceiptHash !== a.historyReceiptHash ||
    receipt.recordedAt > a.recordedAt ||
    receipt.subjects !== p.subjects.length ||
    p.subjects.length !== review.outcomes.length ||
    p.localExecutions.length !== boundary.boundary.manifest.summary.executions ||
    p.subjects.some((s, i) => i > 0 && p.subjects[i - 1].subjectKey >= s.subjectKey)
  )
    fail()
  const outcomes = new Map(review.outcomes.map((o) => [o.subjectKey, o]))
  if (outcomes.size !== p.subjects.length) fail()
  const groupOutcomes = new Map<string, (typeof review.outcomes)[number]>(),
    groups = new Map<
      string,
      { principal: string; outcome: string; evidence: string; local: number; central: number }
    >(),
    usedEvidence = new Map<string, string>(),
    anchors = new Map(
      boundary.boundary.history.conversations.map((c) => [
        c.conversationId,
        new Map(c.messages.map((m) => [m.sourceMessageId, m]))
      ])
    )
  for (const s of p.subjects) {
    const o = outcomes.get(s.subjectKey)
    if (
      !o ||
      o.subjectHash !== s.subjectHash ||
      o.conversationId !== s.conversationId ||
      (s.recordedOutcome !== null && s.recordedOutcome !== o.outcome) ||
      o.observedAt < s.earliestSendAt ||
      o.observedAt > boundary.boundary.history.observedThrough ||
      o.observedAt > review.reviewedAt
    )
      fail()
    let evidence: string
    if (o.outcome === 'confirmed') {
      const anchor = anchors.get(s.conversationId)?.get(o.sourceMessageId)
      if (
        !anchor ||
        anchor.direction !== 'automation_outbound' ||
        anchor.contentHash !== o.sourceContentHash ||
        o.draftTextHash !== s.draftHash ||
        anchor.sentAt < s.earliestSendAt ||
        anchor.sentAt > o.observedAt
      )
        fail()
      evidence = `message:${hashContext({ conversationId: s.conversationId, sourceMessageId: o.sourceMessageId })}`
    } else evidence = `journal:${o.dispatchJournalEntrySha256}`
    if (usedEvidence.has(evidence) && usedEvidence.get(evidence) !== s.executionGroup) fail()
    usedEvidence.set(evidence, s.executionGroup)
    const g = groups.get(s.executionGroup) ?? {
      principal: s.principalHash,
      outcome: o.outcome,
      evidence,
      local: 0,
      central: 0
    }
    if (g.principal !== s.principalHash || g.outcome !== o.outcome || g.evidence !== evidence)
      fail()
    g[s.kind === 'local_execution' ? 'local' : 'central']++
    if (g.local > 1 || g.central > 1) fail()
    groups.set(s.executionGroup, g)
    groupOutcomes.set(s.executionGroup, o)
  }
  if (
    receipt.executionGroups !== groups.size ||
    receipt.confirmed !== review.outcomes.filter((o) => o.outcome === 'confirmed').length ||
    receipt.notSent !== review.outcomes.filter((o) => o.outcome === 'not_sent').length
  )
    fail()
  const bySubject = new Map(p.subjects.map((s) => [s.subjectKey, s])),
    permits = new Map<string, RestoreResolutionRecord>(),
    seals = new Map<string, RestoreResolutionRecord>(),
    locals = new Set<string>()
  let inSeals = false,
    previousPermit = '',
    previousSeal = ''
  for (const r of p.records) {
    if (r.kind === 'request_seal') {
      inSeals = true
      const f = r.fact,
        i = r.seal.input
      if (
        f.sealId <= previousSeal ||
        seals.has(i.executionId) ||
        f.sealId !== r.seal.sealId ||
        f.sealHash !== hashContext(r.seal) ||
        f.requestHash !== hashContext(i) ||
        r.seal.requestHash !== f.requestHash ||
        f.executionId !== i.executionId ||
        f.appliedAgent !== i.identity.agentId ||
        f.appliedAt < r.seal.sealedAt ||
        f.appliedAt > a.recordedAt ||
        r.seal.sealedAt < i.stopped.stoppedAt ||
        i.identity.tenantId !== a.scope.tenant_id ||
        i.identity.accountId !== a.scope.account_id ||
        i.identity.employeeId !== a.scope.employee_id ||
        i.identity.platform !== a.scope.platform ||
        i.verificationProofHash !==
          requestNonDispatchProof({
            executionId: i.executionId,
            identity: i.identity,
            request: i.request
          })
      )
        fail()
      previousSeal = f.sealId
      seals.set(i.executionId, r)
    } else {
      const f = r.fact,
        permit = r.kind === 'reconciled' ? r.challenge.permit : r.permit,
        g = groups.get(`permit:${f.permitId}`),
        identity = permit.identity,
        principal = restoreExecutionPrincipalHash({
          agentId: identity.agentId,
          loginEpoch: identity.loginEpoch,
          clientInstanceId: identity.clientInstanceId,
          taskId: permit.taskId,
          taskHash: permit.taskHash,
          draftHash: permit.draftHash,
          conversationId: permit.conversationId
        })
      if (
        inSeals ||
        f.permitId <= previousPermit ||
        permits.has(f.permitId) ||
        !g ||
        g.central !== 1 ||
        g.principal !== principal ||
        permit.permitId !== f.permitId ||
        permit.newlyIssued ||
        identity.tenantId !== a.scope.tenant_id ||
        identity.accountId !== a.scope.account_id ||
        identity.employeeId !== a.scope.employee_id ||
        identity.platform !== a.scope.platform ||
        permit.expiresAt <= permit.issuedAt ||
        permit.expiresAt - permit.issuedAt > 5000
      )
        fail()
      if (r.kind === 'terminal_reference') {
        if (
          permit.status !== r.fact.status ||
          g.outcome !== r.fact.status ||
          Date.parse(r.fact.settledAt) > a.recordedAt
        )
          fail()
      } else {
        const report = parseDeviceReconciliationReport(r.report, r.challenge),
          decision = parseReconciliationDecision(r.decision, report, hashContext(report))
        if (
          r.fact.caseId !== r.challenge.caseId ||
          r.fact.snapshotHash !== r.challenge.snapshotHash ||
          r.fact.reportHash !== hashContext(report) ||
          r.fact.decisionHash !== hashContext(decision) ||
          r.fact.appliedAgent !== identity.agentId ||
          r.fact.appliedAt < decision.decidedAt ||
          r.fact.appliedAt > a.recordedAt ||
          g.outcome !== decision.outcome
        )
          fail()
        const confirmed = groupOutcomes.get(`permit:${f.permitId}`)
        if (
          confirmed?.outcome === 'confirmed' &&
          (report.observation.status !== 'confirmed' ||
            report.observation.sourceMessageId !== confirmed.sourceMessageId ||
            (anchors.get(confirmed.conversationId)?.get(confirmed.sourceMessageId)?.sentAt ??
              Infinity) > report.observation.observedAt)
        )
          fail()
      }
      previousPermit = f.permitId
      permits.set(f.permitId, r)
    }
  }
  for (const l of p.localExecutions) {
    if (l.kind !== 'execution' || locals.has(l.executionId)) fail()
    locals.add(l.executionId)
    const s = bySubject.get(`l:${l.key}`),
      o = s && outcomes.get(s.subjectKey)
    if (
      !s ||
      !o ||
      s.kind !== 'local_execution' ||
      s.conversationId !== l.conversationId ||
      s.draftHash !== l.draftHash ||
      l.key !== `s:${l.executionId}` ||
      s.earliestSendAt !== l.createdAt ||
      s.principalHash !==
        restoreExecutionPrincipalHash({
          agentId: l.identity.agentId,
          loginEpoch: l.identity.loginEpoch,
          clientInstanceId: l.identity.clientInstanceId,
          taskId: l.taskId,
          taskHash: l.taskHash,
          draftHash: l.draftHash,
          conversationId: l.conversationId
        }) ||
      l.identity.tenantId !== a.scope.tenant_id ||
      l.identity.accountId !== a.scope.account_id ||
      l.identity.employeeId !== a.scope.employee_id ||
      l.identity.agentId !== a.scope.agent_id ||
      l.identity.platform !== a.scope.platform
    )
      fail()
    if (s.executionGroup.startsWith('permit:')) {
      const r = permits.get(s.executionGroup.slice(7))
      if (
        !r ||
        r.kind === 'request_seal' ||
        (l.permitId && l.permitId !== r.fact.permitId) ||
        (r.kind === 'reconciled' &&
          (r.report.observation.executionId !== l.executionId ||
            (l.requestHash !== null && hashContext(r.report.request) !== l.requestHash)))
      )
        fail()
    } else {
      if (s.executionGroup !== `local:${l.executionId}` || o.outcome !== 'not_sent') fail()
      if (
        !(
          l.phase === null &&
          l.requestHash === null &&
          ['prepared', 'cancelled', 'rejected'].includes(l.status)
        )
      ) {
        const r = seals.get(l.executionId)
        if (
          !r ||
          r.kind !== 'request_seal' ||
          hashContext(r.seal.input.identity) !== hashContext(l.identity) ||
          hashContext(r.seal.input.request) !== l.requestHash ||
          r.seal.input.request.taskId !== l.taskId ||
          r.seal.input.request.taskHash !== l.taskHash ||
          r.seal.input.request.draftHash !== l.draftHash
        )
          fail()
      }
    }
  }
  if (
    p.subjects.filter((s) => s.kind === 'local_execution').length !== locals.size ||
    p.subjects.filter((s) => s.kind === 'central_permit').length !== permits.size ||
    p.resolutionBasisHash !==
      hashContext({
        formatVersion: 1,
        tenantId: a.scope.tenant_id,
        accountId: a.scope.account_id,
        caseId: a.caseId,
        uploadId: a.uploadId,
        reviewId: a.reviewId,
        assessmentBasisHash: a.assessmentBasisHash,
        subjects: p.subjects,
        facts: p.records.map((r) => r.fact)
      })
  )
    fail()
  return p
}
