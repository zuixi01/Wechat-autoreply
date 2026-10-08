import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { protectPrivateDirectory } from '../persistence/private-backup-directory'

const Directories = ['src', 'server', 'scripts', 'native', 'resources', 'build', 'tests', 'evals']
const Files = [
  'package.json',
  'package-lock.json',
  'electron.vite.config.ts',
  'electron-builder.yml',
  'tsconfig.json',
  'tsconfig.node.json',
  'tsconfig.web.json',
  'tsconfig.services.json',
  'vitest.config.ts',
  'vitest.scenarios.config.ts',
  'vitest.postgres.config.ts',
  'eslint.config.mjs',
  '.node-version',
  '.editorconfig',
  '.prettierrc.yaml',
  'LICENSE',
  'NOTICE',
  'README.md'
]
const Required = [
  'src',
  'scripts',
  'resources',
  'native',
  'package.json',
  'package-lock.json',
  'electron.vite.config.ts',
  'electron-builder.yml',
  'tsconfig.node.json',
  'tsconfig.web.json'
]
interface SourceFile {
  path: string
  bytes: number
  sha256: string
}
export interface ReleaseSourceManifest {
  formatVersion: 1
  kind: 'release-source-snapshot'
  id: string
  files: SourceFile[]
  digest: string
}
const digest = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')
const canonical = (path: string): string =>
  process.platform === 'win32' ? path.toLowerCase() : path

/** Only build source inputs. Generated outputs, personal configuration, databases and keys never enter. */
export async function inventoryReleaseSources(workspace: string): Promise<SourceFile[]> {
  const root = await realpath(workspace)
  const files: SourceFile[] = []
  let total = 0
  async function visit(relative: string): Promise<void> {
    const name = relative.split('/').at(-1)!
    if (
      (relative.startsWith('native/') && ['bin', 'obj'].includes(name)) ||
      ['node_modules', '.local', '.git'].includes(name) ||
      /^\.env(?:\.|$)/i.test(name) ||
      /\.(?:sqlite(?:3)?|db|pem|key|pfx|p12)(?:-wal|-shm)?$/i.test(name)
    )
      return
    const path = join(root, relative)
    let info
    try {
      info = await lstat(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !Required.includes(relative)) return
      throw new Error('release_source_missing')
    }
    if (info.isSymbolicLink() || canonical(await realpath(path)) !== canonical(path))
      throw new Error('release_source_alias')
    if (info.isDirectory()) {
      for (const child of (await readdir(path)).sort()) await visit(`${relative}/${child}`)
    } else if (info.isFile()) {
      if (info.size > 67108864 || files.length >= 20000 || total + info.size > 536870912)
        throw new Error('release_source_limit')
      const bytes = await readFile(path)
      if (bytes.length !== info.size) throw new Error('release_source_changed')
      total += bytes.length
      files.push({ path: relative, bytes: bytes.length, sha256: digest(bytes) })
    } else throw new Error('release_source_type')
  }
  for (const relative of [...Directories, ...Files]) await visit(relative)
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

export async function createReleaseSourceSnapshot(
  workspace: string,
  id: string
): Promise<{ sourceRoot: string; manifest: ReleaseSourceManifest }> {
  id = z.uuid().parse(id)
  const root = await realpath(workspace),
    buildRoot = join(root, '.local', 'release-build', id)
  if (
    canonical(await realpath(buildRoot)) !== canonical(buildRoot) ||
    (await lstat(buildRoot)).isSymbolicLink()
  )
    throw new Error('release_source_output_invalid')
  const sourceRoot = join(buildRoot, 'source')
  await protectPrivateDirectory(buildRoot)
  await mkdir(sourceRoot)
  await protectPrivateDirectory(sourceRoot)
  const files = await inventoryReleaseSources(root)
  for (const file of files) {
    const target = join(sourceRoot, file.path)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(join(root, file.path), target, constants.COPYFILE_EXCL)
    if (digest(await readFile(target)) !== file.sha256) throw new Error('release_source_changed')
  }
  const sourceDigest = digest(JSON.stringify(files))
  if (
    digest(JSON.stringify(await inventoryReleaseSources(root))) !== sourceDigest ||
    digest(JSON.stringify(await inventoryReleaseSources(sourceRoot))) !== sourceDigest
  )
    throw new Error('release_source_changed')
  const manifest: ReleaseSourceManifest = {
    formatVersion: 1,
    kind: 'release-source-snapshot',
    id,
    files,
    digest: sourceDigest
  }
  await writeFile(
    join(buildRoot, 'source-manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 }
  )
  return { sourceRoot, manifest }
}

export async function verifyReleaseSourceSnapshot(
  sourceRoot: string,
  manifest: ReleaseSourceManifest
): Promise<void> {
  if (
    manifest.digest !== digest(JSON.stringify(manifest.files)) ||
    manifest.digest !== digest(JSON.stringify(await inventoryReleaseSources(resolve(sourceRoot))))
  )
    throw new Error('release_source_changed')
}
