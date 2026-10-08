import {
  EditedReviewInputSchema,
  EditedReviewResultSchema,
  type EditedReviewInput,
  type EditedReviewResult
} from '../../shared/contracts/edited-review'
import { parseGenerationInput, parseGenerationResult } from './generation-validation'
import { hashDraft } from './hashes'

export function parseEditedReviewInput(input: unknown): EditedReviewInput {
  const result = EditedReviewInputSchema.parse(input)
  parseGenerationInput(result.generation)
  return result
}
export function parseEditedReviewResult(
  input: unknown,
  request: EditedReviewInput,
  now = Date.now()
): EditedReviewResult {
  const result = EditedReviewResultSchema.parse(
    parseGenerationResult(input, request.generation.task, now)
  )
  if (
    result.draft &&
    (result.draft.text !== request.edit.text ||
      result.draft.draftRevision !== request.edit.draftRevision ||
      result.draft.draftHash !== hashDraft(request.edit.text) ||
      JSON.stringify(result.draft.evidenceIds) !== JSON.stringify(request.edit.evidenceIds))
  )
    throw new Error('edited_review_content_changed')
  if (
    result.review &&
    (result.review.reviewedAt > now ||
      result.review.expiresAt <= now ||
      request.generation.task.expiresAt <= now)
  )
    throw new Error('edited_review_expired')
  if (
    result.review?.status === 'passed' &&
    (!result.factsVerified || result.reasons.length || result.review.reasons.length)
  )
    throw new Error('edited_review_inconsistent')
  return result
}
