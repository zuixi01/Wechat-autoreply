import { z } from 'zod'
import { Hash, Id, IdentitySchema, Version, sameIdentity, type Identity } from './identity'
import { ExecutionPermitSchema, PermitRequestSchema, type PermitRequest } from './execution'

const Millis = z.number().int().nonnegative().safe()
export const ReconciliationChallengeSchema = z.strictObject({
  caseId: z.string().uuid(),
  snapshotHash: Hash,
  openedAt: Millis,
  permit: ExecutionPermitSchema.refine(
    (p) => !p.newlyIssued && ['issued', 'unknown'].includes(p.status)
  )
})
export type ReconciliationChallenge = z.infer<typeof ReconciliationChallengeSchema>

const Observation = {
  executionId: Id,
  identity: IdentitySchema,
  conversationId: Id,
  permitId: Id,
  taskHash: Hash,
  draftHash: Hash,
  draftRevision: Version,
  leaseVersion: z.number().int().positive().safe(),
  observedAt: Millis,
  verificationProofHash: Hash
}
// Only a trusted platform implementation can attest journal non-dispatch or a
// bound new outbound echo. "No visible message" is not negative evidence.
export const ReconciliationObservationSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...Observation, status: z.literal('confirmed'), sourceMessageId: Id }),
  z.strictObject({
    ...Observation,
    status: z.literal('not_sent'),
    dispatchStarted: z.literal(false),
    quiescent: z.literal(true)
  })
])
export type ReconciliationObservation = z.infer<typeof ReconciliationObservationSchema>
export const DeviceReconciliationReportSchema = z.strictObject({
  caseId: z.string().uuid(),
  snapshotHash: Hash,
  request: PermitRequestSchema,
  stopped: z.strictObject({
    stoppedAt: Millis,
    observerStopped: z.literal(true),
    senderQuiescent: z.literal(true),
    settlementQuiescent: z.literal(true),
    leaseStopped: z.literal(true),
    verifiedDriverStopped: z.literal(true)
  }),
  observation: ReconciliationObservationSchema
})
export type DeviceReconciliationReport = z.infer<typeof DeviceReconciliationReportSchema>
export const ReconciliationAcknowledgmentSchema = z.strictObject({
  caseId: z.string().uuid(),
  reportHash: Hash,
  status: z.literal('evidence_recorded')
})
export type ReconciliationAcknowledgment = z.infer<typeof ReconciliationAcknowledgmentSchema>

export const ReconciliationDecisionInputSchema = z.strictObject({
  decisionId: z.string().uuid(),
  snapshotHash: Hash,
  reportHash: Hash,
  noteId: z.string().uuid(),
  outcome: z.enum(['confirmed', 'not_sent'])
})
export const ReconciliationDecisionSchema = ReconciliationDecisionInputSchema.extend({
  caseId: z.string().uuid(),
  decidedBy: Id,
  decidedAt: Millis
})
export type ReconciliationDecision = z.infer<typeof ReconciliationDecisionSchema>
export const ReconciliationLookupSchema = z.strictObject({
  caseId: z.string().uuid(),
  snapshotHash: Hash,
  reportHash: Hash,
  request: PermitRequestSchema
})
export const ReconciliationAppliedSchema = ReconciliationLookupSchema.extend({
  decisionId: z.string().uuid(),
  decisionHash: Hash
})
export const ReconciliationAppliedAckSchema = z.strictObject({
  decisionId: z.string().uuid(),
  decisionHash: Hash,
  status: z.literal('resolution_applied')
})
export type ReconciliationAppliedAck = z.infer<typeof ReconciliationAppliedAckSchema>

export function parseReconciliationDecision(
  value: unknown,
  report: DeviceReconciliationReport,
  reportHash: string
): ReconciliationDecision {
  const decision = ReconciliationDecisionSchema.parse(value)
  if (
    decision.caseId !== report.caseId ||
    decision.snapshotHash !== report.snapshotHash ||
    decision.reportHash !== reportHash ||
    decision.outcome !== report.observation.status ||
    decision.decidedAt < report.observation.observedAt
  )
    throw new Error('reconciliation_decision_mismatch')
  return decision
}

export function parseReconciliationChallenge(
  value: unknown,
  request: PermitRequest,
  identity: Identity
): ReconciliationChallenge {
  const challenge = ReconciliationChallengeSchema.parse(value),
    p = challenge.permit
  if (
    !sameIdentity(p.identity, identity) ||
    p.taskId !== request.taskId ||
    p.taskHash !== request.taskHash ||
    p.draftHash !== request.draftHash ||
    p.draftRevision !== request.draftRevision ||
    p.leaseVersion !== request.leaseVersion ||
    p.identity.loginEpoch !== request.loginEpoch ||
    p.identity.clientInstanceId !== request.clientInstanceId ||
    (p.purpose ?? 'automatic') !== (request.purpose ?? 'automatic') ||
    p.confirmationId !== request.confirmationId ||
    p.expiresAt <= p.issuedAt ||
    p.expiresAt - p.issuedAt > 5000
  )
    throw new Error('reconciliation_binding_mismatch')
  return challenge
}
export function parseDeviceReconciliationReport(
  value: unknown,
  challenge: ReconciliationChallenge
): DeviceReconciliationReport {
  const report = DeviceReconciliationReportSchema.parse(value),
    o = report.observation,
    p = challenge.permit
  parseReconciliationChallenge(challenge, report.request, o.identity)
  if (
    report.caseId !== challenge.caseId ||
    report.snapshotHash !== challenge.snapshotHash ||
    o.permitId !== p.permitId ||
    o.conversationId !== p.conversationId ||
    o.taskHash !== p.taskHash ||
    o.draftHash !== p.draftHash ||
    o.draftRevision !== p.draftRevision ||
    o.leaseVersion !== p.leaseVersion ||
    report.stopped.stoppedAt < Math.max(challenge.openedAt, p.expiresAt) ||
    o.observedAt < report.stopped.stoppedAt
  )
    throw new Error('reconciliation_proof_mismatch')
  return report
}
