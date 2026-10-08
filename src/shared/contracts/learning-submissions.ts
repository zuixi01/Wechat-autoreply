import { z } from 'zod'
import {
  MemoryScopeSchema,
  MemoryContentSchema,
  LearningCorrectionInputSchema,
  LearningResultInputSchema,
  LearningHumanFeedbackInputSchema
} from './learning-memory'

export const LearningSubmissionAuthoritySchema = z.string().regex(/^[a-f0-9]{64}$/)
const timestamp = z.number().int().nonnegative().safe()
const source = { scope: MemoryScopeSchema, sourceId: z.uuid() }
const episode = { ...source, episodeId: z.string().trim().min(1).max(128) }
export const LearningSubmissionRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('manual'),
    input: z.strictObject({
      ...source,
      content: MemoryContentSchema,
      reason: z.string().trim().min(1).max(2000)
    })
  }),
  z.strictObject({
    kind: z.literal('correct'),
    input: LearningCorrectionInputSchema.extend(episode)
  }),
  z.strictObject({ kind: z.literal('result'), input: LearningResultInputSchema.extend(episode) }),
  z.strictObject({
    kind: z.literal('feedback'),
    input: LearningHumanFeedbackInputSchema.extend(episode)
  })
])
export type LearningSubmissionRequest = z.infer<typeof LearningSubmissionRequestSchema>

const host = {
  authorityId: LearningSubmissionAuthoritySchema,
  firstSubmittedAt: timestamp,
  evidenceAt: timestamp
}
/** Host-derived authority and age never come from the renderer. */
export const LearningSubmissionIntentSchema = z
  .discriminatedUnion('kind', [
    LearningSubmissionRequestSchema.options[0].extend(host),
    LearningSubmissionRequestSchema.options[1].extend(host),
    LearningSubmissionRequestSchema.options[2].extend(host),
    LearningSubmissionRequestSchema.options[3].extend(host)
  ])
  .refine((value) => value.evidenceAt <= value.firstSubmittedAt, 'invalid_submission_time')
export type LearningSubmissionIntent = z.infer<typeof LearningSubmissionIntentSchema>
export const LearningSubmissionErrorSchema = z.enum([
  'network_unavailable',
  'permission_revoked',
  'source_unavailable',
  'submission_conflict',
  'retention_expired'
])
export type LearningSubmissionError = z.infer<typeof LearningSubmissionErrorSchema>
export const LearningSubmissionReceiptSchema = z.strictObject({
  sourceId: z.uuid(),
  kind: z.enum(['manual', 'correct', 'result', 'feedback']),
  state: z.enum(['pending', 'saved', 'forgotten']),
  firstSubmittedAt: timestamp,
  evidenceAt: timestamp,
  errorCode: LearningSubmissionErrorSchema.optional()
})
export type LearningSubmissionReceipt = z.infer<typeof LearningSubmissionReceiptSchema>
