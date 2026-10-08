import { z } from 'zod'
import { Id } from './identity'
import { ReplyTaskSchema, ReplyDraftSchema, DraftReviewSchema } from './task'
import { ConversationContextSchema } from './context'
import { AssessmentExplanationSchema, ReplyIntentSchema } from './assessment-explanation'

export const AgentConfigurationSchema = z.strictObject({
  configVersion: Id,
  knowledgeVersion: Id,
  decisionPolicyVersion: Id,
  questionSetVersion: Id,
  modelResolved: Id,
  automaticEnabled: z.boolean(),
  memoryCorpusVersion: Id.optional()
})
export type AgentConfiguration = z.infer<typeof AgentConfigurationSchema>
export const GenerationInputSchema = z
  .strictObject({
    task: ReplyTaskSchema,
    context: ConversationContextSchema,
    inbound: z
      .array(
        z
          .string()
          .min(1)
          .max(8000)
          .refine((text) => text.trim().length > 0)
      )
      .min(1)
      .max(30)
  })
  .superRefine((i, c) => {
    const { from, to } = i.task.inboundRange
    const pending = i.context.filter(
      (m) => m.sequence >= from && m.sequence <= to && m.direction === 'inbound'
    )
    if (
      i.inbound.reduce((n, text) => n + text.length, 0) > 24000 ||
      pending[0]?.sequence !== from ||
      pending.at(-1)?.sequence !== to ||
      pending.some((m) => m.kind !== 'text') ||
      JSON.stringify(pending.map((m) => m.text)) !== JSON.stringify(i.inbound)
    )
      c.addIssue({ code: 'custom', message: 'Context hash or inbound range disagrees with task' })
  })
export const GenerationResultSchema = z
  .strictObject({
    task: ReplyTaskSchema,
    status: z.enum(['candidate', 'handoff', 'invalid', 'cancelled']),
    automaticAllowed: z.boolean(),
    factsVerified: z.boolean(),
    reasons: z.array(Id).max(50),
    intents: z.array(ReplyIntentSchema).max(5),
    explanation: AssessmentExplanationSchema.optional(),
    draft: ReplyDraftSchema.optional(),
    review: DraftReviewSchema.optional(),
    usage: z.strictObject({
      input_tokens: z.number().int().nonnegative(),
      output_tokens: z.number().int().nonnegative()
    })
  })
  .superRefine((r, c) => {
    if (
      (r.status === 'candidate' && (!r.draft || !r.review)) ||
      (r.automaticAllowed &&
        (r.status !== 'candidate' || !r.factsVerified || r.review?.status !== 'passed'))
    )
      c.addIssue({
        code: 'custom',
        message: 'Complete bound review required for candidate/automatic result'
      })
    if (
      (r.draft && r.draft.taskId !== r.task.taskId) ||
      (r.review && r.review.taskId !== r.task.taskId)
    )
      c.addIssue({ code: 'custom', message: 'Reply target task changed' })
  })
export type GenerationInput = z.infer<typeof GenerationInputSchema>
export type GenerationResult = z.infer<typeof GenerationResultSchema>
