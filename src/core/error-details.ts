/** Read string error metadata without trusting an arbitrary thrown value. */
export function errorStringProperty(
  error: unknown,
  property: 'message' | 'name'
): string | undefined {
  if (error === null || typeof error !== 'object' || !(property in error)) return undefined
  const value: unknown = Reflect.get(error, property)
  return typeof value === 'string' ? value : undefined
}
