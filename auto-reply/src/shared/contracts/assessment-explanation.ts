import { z } from 'zod'
import { Hash, Id } from './identity'

export const ReplyIntentSchema = z.enum(['faq', 'price', 'order', 'aftersales', 'other'])
/** Historical, server-authored display data. It never grants permission to send. */
export const AssessmentExplanationSchema = z
  .strictObject({
    taskId: Id,
    contextHash: Hash,
    knowledgeVersion: Id,
    assessedAt: z.number().int().nonnegative().safe().optional(),
    draftHash: Hash.optional(),
    draftRevision: z.number().int().nonnegative().safe().optional(),
    intents: z
      .array(ReplyIntentSchema)
      .max(5)
      .refine((v) => new Set(v).size === v.length),
    recommendation: z.enum(['automatic', 'review', 'handoff']),
    factsVerified: z.boolean(),
    evidence: z
      .array(
        z
          .strictObject({
            evidenceId: Id,
            intent: ReplyIntentSchema,
            kind: z.enum(['approved_faq', 'verified_business_record']),
            source: z.string().min(1).max(2000),
            excerpt: z.string().min(1).max(600),
            excerptTruncated: z.boolean(),
            validFrom: z.number().int().nonnegative().safe(),
            expiresAt: z.number().int().positive().safe()
          })
          .refine((e) => e.expiresAt > e.validFrom)
      )
      .max(8),
    totalReferences: z.number().int().min(0).max(100),
    unavailableReferences: z.number().int().min(0).max(100),
    omittedReferences: z.number().int().min(0).max(100)
  })
  .refine(
    (e) =>
      (e.draftHash === undefined) === (e.draftRevision === undefined) &&
      new Set(e.evidence.map((v) => v.evidenceId)).size === e.evidence.length &&
      e.totalReferences === e.evidence.length + e.unavailableReferences + e.omittedReferences
  )
export type AssessmentExplanation = z.infer<typeof AssessmentExplanationSchema>
