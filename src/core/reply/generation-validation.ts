import { z } from 'zod'
import {
  GenerationInputSchema,
  GenerationResultSchema,
  type GenerationInput,
  type GenerationResult
} from '../../shared/contracts/generation'
import type { ReplyTask } from '../../shared/contracts/task'
import { hashContext, hashDraft } from './hashes'
import { sameLearningBinding } from '../../shared/contracts/learning-task'

/** Hash validation belongs in Node-side code, keeping shared UI contracts browser-safe. */
export function parseGenerationInput(input: unknown): GenerationInput {
  const parsed = GenerationInputSchema.parse(input)
  if (hashContext(parsed.context) !== parsed.task.contextHash)
    throw new z.ZodError([
      {
        code: 'custom',
        path: ['context'],
        message: 'Context hash or inbound range disagrees with task'
      }
    ])
  return parsed
}
export function parseGenerationResult(
  input: unknown,
  task: ReplyTask,
  now = Date.now()
): GenerationResult {
  const result = GenerationResultSchema.parse(input),
    draft = result.draft,
    review = result.review
  if (hashContext(result.task) !== hashContext(task)) throw new Error('generation_task_changed')
  const explanation = result.explanation
  if (
    explanation &&
    (explanation.taskId !== task.taskId ||
      explanation.contextHash !== task.contextHash ||
      explanation.knowledgeVersion !== task.knowledgeVersion ||
      explanation.draftHash !== draft?.draftHash ||
      explanation.draftRevision !== draft?.draftRevision ||
      hashContext(explanation.intents) !== hashContext(result.intents) ||
      explanation.factsVerified !== result.factsVerified ||
      explanation.recommendation !==
        (result.automaticAllowed ? 'automatic' : draft ? 'review' : 'handoff') ||
      explanation.totalReferences !== (draft?.evidenceIds.length ?? 0) ||
      explanation.evidence.some(
        (e) => !draft?.evidenceIds.includes(e.evidenceId) || !result.intents.includes(e.intent)
      ))
  )
    throw new Error('generation_explanation_changed')
  if (
    draft &&
    (hashDraft(draft.text) !== draft.draftHash ||
      (review &&
        (review.contextHash !== task.contextHash ||
          !sameLearningBinding(review, task) ||
          review.draftHash !== draft.draftHash ||
          review.draftRevision !== draft.draftRevision ||
          review.configVersion !== task.configVersion ||
          review.knowledgeVersion !== task.knowledgeVersion ||
          review.decisionPolicyVersion !== task.decisionPolicyVersion ||
          review.questionSetVersion !== task.questionSetVersion)))
  )
    throw new Error('generation_review_changed')
  if (
    result.automaticAllowed &&
    (!review || review.reviewedAt > now || review.expiresAt <= now || task.expiresAt <= now)
  )
    throw new Error('generation_review_expired')
  return result
}
