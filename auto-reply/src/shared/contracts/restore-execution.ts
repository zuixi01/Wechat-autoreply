import { z } from 'zod'
import { Hash, Id } from './identity'
import { RestoreSubjectKeySchema } from './restore-assessment'

const Millis = z.number().int().nonnegative().safe()
export const RestoreExecutionSubjectSchema = z.strictObject({
  subjectKey: RestoreSubjectKeySchema,
  subjectHash: Hash,
  kind: z.enum(['local_execution', 'central_permit']),
  executionGroup: z
    .string()
    .min(7)
    .max(256)
    .refine((v) => v.startsWith('permit:') || v.startsWith('local:')),
  principalHash: Hash,
  conversationId: Id,
  draftHash: Hash,
  earliestSendAt: Millis,
  recordedOutcome: z.enum(['confirmed', 'not_sent']).nullable()
})
const common = {
  subjectKey: RestoreSubjectKeySchema,
  subjectHash: Hash,
  conversationId: Id,
  evidenceSha256: Hash,
  observedAt: Millis
}
export const RestoreExecutionOutcomeSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    ...common,
    outcome: z.literal('confirmed'),
    sourceMessageId: Id,
    sourceContentHash: Hash,
    draftTextHash: Hash,
    causalAttributionVerified: z.literal(true)
  }),
  z.strictObject({
    ...common,
    outcome: z.literal('not_sent'),
    dispatchStarted: z.literal(false),
    quiescent: z.literal(true),
    dispatchJournalEntrySha256: Hash,
    nonDispatchJournalVerified: z.literal(true)
  })
])
export const RestoreExecutionReviewInputSchema = z.strictObject({
  reviewId: z.uuid().toLowerCase(),
  tenantId: Id,
  accountId: Id,
  caseId: z.uuid().toLowerCase(),
  uploadId: z.uuid().toLowerCase(),
  historyProofId: z.uuid().toLowerCase(),
  assessmentBasisHash: Hash,
  reviewerId: Id,
  reviewedAt: Millis,
  outcomes: z.array(RestoreExecutionOutcomeSchema).max(2000000)
})
export const RestoreExecutionReviewReceiptSchema = z
  .strictObject({
    formatVersion: z.literal(1),
    reviewId: z.uuid().toLowerCase(),
    tenantId: Id,
    accountId: Id,
    caseId: z.uuid().toLowerCase(),
    uploadId: z.uuid().toLowerCase(),
    historyProofId: z.uuid().toLowerCase(),
    assessmentBasisHash: Hash,
    historyReceiptHash: Hash,
    subjectsSnapshotHash: Hash,
    requestHash: Hash,
    outcomesHash: Hash,
    subjects: z.number().int().nonnegative().safe(),
    confirmed: z.number().int().nonnegative().safe(),
    notSent: z.number().int().nonnegative().safe(),
    executionGroups: z.number().int().nonnegative().safe(),
    recordedBy: Id,
    recordedAt: Millis,
    maintenanceReviewRecorded: z.literal(true),
    physicalOutcomeVerifiedByThisCommand: z.literal(false),
    separateReconciliationRequired: z.literal(true),
    automaticStart: z.literal(false),
    canRelease: z.literal(false)
  })
  .refine((r) => r.confirmed + r.notSent === r.subjects && r.executionGroups <= r.subjects)
export type RestoreExecutionSubject = z.infer<typeof RestoreExecutionSubjectSchema>
export type RestoreExecutionReviewInput = z.infer<typeof RestoreExecutionReviewInputSchema>
export type RestoreExecutionReviewReceipt = z.infer<typeof RestoreExecutionReviewReceiptSchema>
