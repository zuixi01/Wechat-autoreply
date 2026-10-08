import { z } from 'zod'
import { Hash, Id, IdentitySchema, Version } from './identity'
import { LearningTaskBindingFields, completeOrAbsentLearningBinding } from './learning-task'

export const ReplyTaskSchema = z
  .strictObject({
    taskId: Id,
    identity: IdentitySchema,
    conversationId: Id,
    bindingVersion: Version,
    conversationRevision: Version,
    runEpoch: Version,
    inboundRange: z
      .strictObject({ from: z.number().int().positive(), to: z.number().int().positive() })
      .refine((range) => range.from <= range.to),
    contextHash: Hash,
    configVersion: Id,
    knowledgeVersion: Id,
    decisionPolicyVersion: Id,
    questionSetVersion: Id,
    ...LearningTaskBindingFields,
    createdAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive()
  })
  .refine((task) => task.expiresAt > task.createdAt)
  .refine(completeOrAbsentLearningBinding, 'incomplete_learning_binding')

export const ReplyDraftSchema = z
  .strictObject({
    taskId: Id,
    draftRevision: Version,
    draftHash: Hash,
    action: z.enum(['reply', 'clarify', 'handoff', 'skip']),
    text: z.string().max(10000),
    evidenceIds: z.array(Id)
  })
  .refine((draft) => !['reply', 'clarify'].includes(draft.action) || draft.text.trim().length > 0)

export const DraftReviewSchema = z
  .strictObject({
    reviewId: Id,
    taskId: Id,
    contextHash: Hash,
    draftRevision: Version,
    draftHash: Hash,
    configVersion: Id,
    knowledgeVersion: Id,
    decisionPolicyVersion: Id,
    questionSetVersion: Id,
    ...LearningTaskBindingFields,
    modelResolved: Id,
    status: z.enum(['passed', 'needs_human', 'invalid']),
    reasons: z.array(Id),
    reviewedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive()
  })
  .refine((review) => review.expiresAt > review.reviewedAt)
  .refine(completeOrAbsentLearningBinding, 'incomplete_learning_binding')

export type ReplyTask = z.infer<typeof ReplyTaskSchema>
export type ReplyDraft = z.infer<typeof ReplyDraftSchema>
export type DraftReview = z.infer<typeof DraftReviewSchema>
