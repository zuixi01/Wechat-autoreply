import { z } from 'zod'
import { Id } from './identity'
import { GenerationInputSchema, GenerationResultSchema } from './generation'

/** Review data only. It is never a confirmation or an execution permit. */
export const EditedContentSchema = z
  .strictObject({
    text: z
      .string()
      .min(1)
      .max(10000)
      .refine((text) => text.trim().length > 0),
    draftRevision: z.number().int().min(2).max(Number.MAX_SAFE_INTEGER),
    evidenceIds: z.array(Id).max(100)
  })
  .refine((edit) => new Set(edit.evidenceIds).size === edit.evidenceIds.length)
export type EditedContent = z.infer<typeof EditedContentSchema>
export const EditedReviewInputSchema = z.strictObject({
  generation: GenerationInputSchema,
  edit: EditedContentSchema
})
export type EditedReviewInput = z.infer<typeof EditedReviewInputSchema>
export const EditedReviewResultSchema = GenerationResultSchema.refine(
  (result) => result.automaticAllowed === false,
  { message: 'An edited review cannot authorize automatic execution' }
)
export type EditedReviewResult = z.infer<typeof EditedReviewResultSchema>
