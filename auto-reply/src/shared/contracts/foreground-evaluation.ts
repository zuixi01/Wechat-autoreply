import { z } from 'zod'
import { Id } from './identity'
import { DeviceScopeSchema } from './registration'
import { ReplyTaskSchema } from './task'
import { ConversationContextSchema } from './context'
import { LearningEvaluationDatasetSchema } from './learning-evaluation'

/** Host-only rendezvous data. Parsing this data does not authenticate a server batch. */
export const ForegroundEvaluationAssignmentSchema = z.strictObject({
  runId: z.uuid(),
  scope: DeviceScopeSchema,
  assignment: z.strictObject({
    ordinal: z.number().int().nonnegative().safe(),
    assignmentId: z.uuid(),
    caseId: Id,
    arm: z.enum(['none', 'baseline', 'learned'])
  }),
  frozen: LearningEvaluationDatasetSchema.shape.frozen,
  task: ReplyTaskSchema,
  item: z.strictObject({
    caseId: Id,
    conversationId: Id,
    category: z.enum(['inquiry', 'complaint', 'handoff', 'multiple_intents']),
    inbound: z.array(z.string().min(1).max(8000)).min(1).max(30),
    context: ConversationContextSchema.optional()
  })
})
export type ForegroundEvaluationAssignment = z.infer<typeof ForegroundEvaluationAssignmentSchema>
