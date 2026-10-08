import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Deployment content, independent of Vitest/tsx function transforms. Paths are host constants;
 * missing files fail closed. This consistency fingerprint does not authenticate provenance. */
export function deploymentVersion(from: string, modules: readonly string[]): string {
  const extension = extname(fileURLToPath(from))
  const entries = modules.map((name) => ({
    name,
    hash: createHash('sha256')
      .update(readFileSync(new URL(name + extension, from), 'utf8'))
      .digest('hex')
  }))
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex')
}
