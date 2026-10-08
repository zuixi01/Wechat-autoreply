import { z } from 'zod'
import { Hash, Id } from './identity'

export const RestoreSubjectKeySchema = z
  .string()
  .regex(/^(a:[a-f0-9]{64}|l:(m:[a-f0-9]{64}:[0-9]{16}|s:[a-f0-9-]{36})|p:[a-f0-9]{64})$/)
export const RestoreAssessmentPageSchema = z
  .strictObject({
    after: RestoreSubjectKeySchema.optional(),
    limit: z.number().int().min(1).max(100).default(50),
    expectedBasisHash: Hash.optional()
  })
  .refine((page) => !page.after || !!page.expectedBasisHash)
export const RestoreEvidenceInputSchema = z.strictObject({
  noteId: z.uuid().toLowerCase(),
  basisHash: Hash,
  subjectKey: RestoreSubjectKeySchema,
  subjectHash: Hash,
  kind: z.enum(['device_stop', 'message_history', 'execution_outcome']),
  referenceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  evidenceHash: Hash,
  observedAt: z.number().int().nonnegative().safe()
})
export type RestoreEvidenceInput = z.infer<typeof RestoreEvidenceInputSchema>
export const RestoreEvidenceReceiptSchema = RestoreEvidenceInputSchema.safeExtend({
  caseId: z.uuid().toLowerCase(),
  uploadId: z.uuid().toLowerCase(),
  recordedBy: Id,
  recordedAt: z.number().int().nonnegative().safe(),
  canRelease: z.literal(false)
})
export type RestoreEvidenceReceipt = z.infer<typeof RestoreEvidenceReceiptSchema>
export const RestoreEvidencePageSchema = z.strictObject({
  after: z.uuid().optional(),
  limit: z.number().int().min(1).max(100).default(50)
})
