import { z } from 'zod'
import { Hash, Id } from './identity'
import { ReplyIntentSchema } from './assessment-explanation'

/** A read-only reference to an immutable completed assessment, never a send request. */
export const AssessmentEvidenceRequestSchema = z.strictObject({
  taskId: Id,
  contextHash: Hash,
  knowledgeVersion: Id,
  draftHash: Hash,
  draftRevision: z.number().int().nonnegative().safe(),
  offset: z.number().int().min(0).max(100)
})
export type AssessmentEvidenceRequest = z.infer<typeof AssessmentEvidenceRequestSchema>
export const AssessmentEvidencePageSchema = z
  .strictObject({
    ...AssessmentEvidenceRequestSchema.shape,
    assessedAt: z.number().int().nonnegative().safe(),
    totalAvailable: z.number().int().min(0).max(100),
    unavailableReferences: z.number().int().min(0).max(100),
    nextOffset: z.number().int().min(1).max(100).optional(),
    evidence: z
      .array(
        z
          .strictObject({
            evidenceId: Id,
            intent: ReplyIntentSchema,
            kind: z.enum(['approved_faq', 'verified_business_record']),
            source: z.string().min(1).max(2000),
            content: z.string().min(1).max(20000),
            validFrom: z.number().int().nonnegative().safe(),
            expiresAt: z.number().int().positive().safe()
          })
          .refine((e) => e.expiresAt > e.validFrom)
      )
      .max(1)
  })
  .refine(
    (p) =>
      p.offset <= p.totalAvailable &&
      p.totalAvailable + p.unavailableReferences <= 100 &&
      p.evidence.length === (p.offset < p.totalAvailable ? 1 : 0) &&
      p.nextOffset ===
        (p.offset + p.evidence.length < p.totalAvailable ? p.offset + 1 : undefined) &&
      p.evidence.every((e) => p.assessedAt >= e.validFrom && p.assessedAt < e.expiresAt)
  )
export type AssessmentEvidencePage = z.infer<typeof AssessmentEvidencePageSchema>

export function parseAssessmentEvidencePage(
  input: unknown,
  request: AssessmentEvidenceRequest
): AssessmentEvidencePage {
  const page = AssessmentEvidencePageSchema.parse(input)
  for (const key of Object.keys(request) as (keyof AssessmentEvidenceRequest)[])
    if (page[key] !== request[key]) throw new Error('assessment_evidence_changed')
  return page
}
