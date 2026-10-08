import { createHash } from 'node:crypto'
import { MemoryScopeSchema, type MemoryScope } from '../../shared/contracts/learning-memory'

/** Sorted recursively so hashes do not depend on input property insertion order. */
export function learningHash(value: unknown): string {
  function normalize(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(normalize)
    if (input && typeof input === 'object')
      return Object.fromEntries(
        Object.entries(input)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, v]) => [key, normalize(v)])
      )
    return input
  }
  return createHash('sha256')
    .update(JSON.stringify(normalize(value)))
    .digest('hex')
}
export function memoryScopeKey(scope: MemoryScope): string {
  return learningHash(MemoryScopeSchema.parse(scope))
}
export function accountMemoryScope(scope: MemoryScope): MemoryScope {
  const parsed = MemoryScopeSchema.parse(scope)
  delete parsed.conversationId
  return parsed
}
