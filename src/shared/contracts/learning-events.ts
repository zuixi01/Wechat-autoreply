import { z } from 'zod'
import { Hash, Id, Version } from './identity'
import {
  LearningCorrectionInputSchema,
  LearningResultInputSchema,
  LearningHumanFeedbackInputSchema
} from './learning-memory'

export const LearningTaskReferenceSchema = z.strictObject({
  taskId: Id,
  contextHash: Hash,
  draftHash: Hash,
  draftRevision: Version
})
export const LearningTaskCorrectionSchema = LearningCorrectionInputSchema.extend({
  reference: LearningTaskReferenceSchema
})
export const LearningTaskResultSchema = LearningResultInputSchema.extend({
  reference: LearningTaskReferenceSchema
})
export const LearningTaskFeedbackSchema = LearningHumanFeedbackInputSchema.extend({
  reference: LearningTaskReferenceSchema
})
export type LearningTaskReference = z.infer<typeof LearningTaskReferenceSchema>
export type LearningTaskCorrection = z.infer<typeof LearningTaskCorrectionSchema>
export type LearningTaskResult = z.infer<typeof LearningTaskResultSchema>
export type LearningTaskFeedback = z.infer<typeof LearningTaskFeedbackSchema>
