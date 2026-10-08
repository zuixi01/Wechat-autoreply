import { z } from 'zod'

/** Public names only. Host credentials and endpoints never belong in this response. */
export const LearningModelDirectorySchema = z
  .array(
    z.strictObject({
      id: z.string().trim().min(1).max(128),
      label: z.string().trim().min(1).max(128)
    })
  )
  .max(1000)
  .refine(
    (models) => new Set(models.map((model) => model.id)).size === models.length,
    'duplicate_review_model'
  )
export type LearningModelDirectory = z.infer<typeof LearningModelDirectorySchema>

export function assertLearningReviewSelection(
  modelId: string | undefined,
  directory: LearningModelDirectory
): void {
  if (modelId && !directory.some((entry) => entry.id === modelId))
    throw new Error('review_model_unavailable')
}
