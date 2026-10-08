import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import {
  createReleaseSourceSnapshot,
  verifyReleaseSourceSnapshot,
  type ReleaseSourceManifest
} from '../src/core/build/release-source-snapshot'

async function main(): Promise<void> {
  const workspace = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const [command, id, ...extra] = process.argv.slice(2)
  if (
    extra.length ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id ?? '')
  )
    throw new Error('release_source_arguments_invalid')
  if (command === 'create') {
    const result = await createReleaseSourceSnapshot(workspace, id)
    process.stdout.write(
      JSON.stringify({
        sourceRoot: result.sourceRoot,
        digest: result.manifest.digest,
        files: result.manifest.files.length
      }) + '\n'
    )
  } else if (command === 'verify') {
    const buildRoot = resolve(workspace, '.local/release-build', id)
    const manifest: ReleaseSourceManifest = JSON.parse(
      await readFile(resolve(buildRoot, 'source-manifest.json'), 'utf8')
    )
    if (manifest.id !== id) throw new Error('release_source_manifest_invalid')
    await verifyReleaseSourceSnapshot(resolve(buildRoot, 'source'), manifest)
  } else throw new Error('release_source_arguments_invalid')
}
void main().catch((error: unknown) => {
  const code =
    error instanceof Error && /^release_source_[a-z_]+$/.test(error.message)
      ? error.message
      : 'release_source_unavailable'
  process.stderr.write(`${code}\n`)
  process.exitCode = 1
})
