import { z } from 'zod'
import { Hash, Id } from './identity'
import { RestoreSubjectKeySchema } from './restore-assessment'

const Uuid = z.uuid().toLowerCase()
const Millis = z.number().int().nonnegative().safe()
export const RestoreRulingInputSchema = z.strictObject({
  rulingId: Uuid,
  basisHash: Hash,
  subjectKey: RestoreSubjectKeySchema,
  subjectHash: Hash,
  noteId: Uuid,
  noteReceiptHash: Hash,
  expectedPreviousRulingId: Uuid.nullable(),
  outcome: z.enum(['accept_for_quarantine', 'hold']),
  evidenceReviewed: z.literal(true)
})
export const RestoreRulingReceiptSchema = RestoreRulingInputSchema.safeExtend({
  caseId: Uuid,
  uploadId: Uuid,
  revision: z.number().int().positive().safe(),
  recordedBy: Id,
  recordedAt: Millis,
  canRelease: z.literal(false)
})
export type RestoreRulingReceipt = z.infer<typeof RestoreRulingReceiptSchema>
export const RestoreRulingsPageSchema = z
  .strictObject({
    after: RestoreSubjectKeySchema.optional(),
    limit: z.number().int().min(1).max(100).default(50),
    expectedBasisHash: Hash.optional(),
    expectedRulingsHash: Hash.optional()
  })
  .refine((page) => !page.after || (!!page.expectedBasisHash && !!page.expectedRulingsHash))
export const RestoreDecisionInputSchema = z.strictObject({
  decisionId: Uuid,
  basisHash: Hash,
  rulingsHash: Hash,
  historyPolicy: z.literal('quarantine'),
  reviewedAllSubjects: z.literal(true)
})
export const RestoreDecisionReceiptSchema = RestoreDecisionInputSchema.safeExtend({
  caseId: Uuid,
  uploadId: Uuid,
  restoreId: Uuid,
  targetAgentId: Id,
  contextHash: Hash,
  inventoryBasisHash: Hash,
  subjectCount: z.number().int().nonnegative().safe(),
  decidedBy: Id,
  decidedAt: Millis,
  applicationRequired: z.literal(true),
  automaticStart: z.literal(false),
  canRelease: z.literal(false)
})
export type RestoreDecisionReceipt = z.infer<typeof RestoreDecisionReceiptSchema>
