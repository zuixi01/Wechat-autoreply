import { createHash } from 'node:crypto'

/** Hash exact final text; even a prefix or a whitespace edit invalidates its review. */
export function hashDraft(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function hashContext(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical)
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, item]) => [key, canonical(item)])
      )
    }
    return input
  }
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)), 'utf8')
    .digest('hex')
}
