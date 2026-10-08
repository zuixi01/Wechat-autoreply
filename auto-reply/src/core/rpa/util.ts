import { createRequire } from 'node:module'

export const delay = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))
export const randomDelay = (ms: number): Promise<void> => delay(ms + Math.random() * 20 - 10)
export const randomDelayIn = (min: number, max: number): Promise<void> =>
  delay(min + Math.random() * (max - min))

export function errorMessage(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return typeof error.message === 'string' ? error.message : undefined
  }
  return undefined
}

export function getRobot(): typeof import('@hurdlegroup/robotjs') | null {
  try {
    // We use runtime require to prevent Vite/Webpack from attempting to eagerly bundle
    // native C++ add-ons which can cause build failures or crash the main process on load.
    const nativeRequire = createRequire(
      typeof __filename === 'string' ? __filename : import.meta.url
    )
    return nativeRequire('@hurdlegroup/robotjs') as typeof import('@hurdlegroup/robotjs')
  } catch (err) {
    console.error(
      'Failed to load @hurdlegroup/robotjs. Core RPA functions will not work.',
      errorMessage(err)
    )
    return null
  }
}
