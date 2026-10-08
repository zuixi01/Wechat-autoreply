import { z } from 'zod'
import { Id } from './identity'

const Count = z.number().int().nonnegative().safe()
export const LearningPublicationStatusSchema = z
  .strictObject({
    tenantId: Id,
    accountId: Id,
    state: z.enum(['unpublished', 'current', 'outdated', 'unavailable']),
    currentMemoryCorpusVersion: Id,
    currentMethodCount: Count,
    serverPaused: z.boolean(),
    published: z
      .strictObject({
        configVersion: Id,
        memoryCorpusVersion: Id,
        methodCount: Count,
        automaticEnabled: z.boolean()
      })
      .nullable()
  })
  .refine((status) => {
    if (status.state === 'unpublished' || status.state === 'unavailable')
      return status.published === null
    if (!status.published) return false
    const matches = status.published.memoryCorpusVersion === status.currentMemoryCorpusVersion
    return status.state === 'current'
      ? matches && status.published.methodCount === status.currentMethodCount
      : !matches
  }, 'inconsistent_learning_publication_status')
export type LearningPublicationStatus = z.infer<typeof LearningPublicationStatusSchema>
