import { z } from 'zod'
import { Id, Hash } from './identity'

export const EMPTY_ENTERPRISE_MEMORY_VERSION = 'empty-enterprise-memory-v1'
export const LearningTaskBindingSchema = z.strictObject({
  memoryCorpusVersion: Id,
  memorySnapshotHash: Hash,
  learningContextVersion: Hash
})
export type LearningTaskBinding = z.infer<typeof LearningTaskBindingSchema>
export const LearningTaskBindingFields = {
  memoryCorpusVersion: Id.optional(),
  memorySnapshotHash: Hash.optional(),
  learningContextVersion: Hash.optional()
}
type OptionalBinding = Partial<LearningTaskBinding>
export function completeOrAbsentLearningBinding(value: OptionalBinding): boolean {
  const present = [
    value.memoryCorpusVersion,
    value.memorySnapshotHash,
    value.learningContextVersion
  ].filter((item) => item !== undefined).length
  return present === 0 || present === 3
}
export function learningBindingOf(
  value: OptionalBinding
): LearningTaskBinding | Record<string, never> {
  return value.memoryCorpusVersion === undefined
    ? {}
    : LearningTaskBindingSchema.parse({
        memoryCorpusVersion: value.memoryCorpusVersion,
        memorySnapshotHash: value.memorySnapshotHash,
        learningContextVersion: value.learningContextVersion
      })
}
export function sameLearningBinding(a: OptionalBinding, b: OptionalBinding): boolean {
  return (
    a.memoryCorpusVersion === b.memoryCorpusVersion &&
    a.memorySnapshotHash === b.memorySnapshotHash &&
    a.learningContextVersion === b.learningContextVersion
  )
}
export function sameMemoryCorpus(
  a: Pick<OptionalBinding, 'memoryCorpusVersion'>,
  b: Pick<OptionalBinding, 'memoryCorpusVersion'>
): boolean {
  return (
    (a.memoryCorpusVersion ?? EMPTY_ENTERPRISE_MEMORY_VERSION) ===
    (b.memoryCorpusVersion ?? EMPTY_ENTERPRISE_MEMORY_VERSION)
  )
}
export function stripLearningBinding<T extends OptionalBinding>(
  value: T
): Omit<T, keyof LearningTaskBinding> {
  const result = { ...value }
  delete result.memoryCorpusVersion
  delete result.memorySnapshotHash
  delete result.learningContextVersion
  return result
}
