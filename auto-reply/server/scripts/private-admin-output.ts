import { lstat, mkdir, open, realpath, readdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  protectPrivateDirectory,
  verifyPrivatePaths
} from '../../src/core/persistence/private-backup-directory'

function inside(path: string, root: string): boolean {
  const part = relative(root, path)
  return part !== '' && !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`)
}

/** Fresh private drafts only; never follow an existing junction or overwrite a file. */
export async function writePrivateAdminOutput(
  path: string,
  publication: unknown,
  workspace = process.cwd()
): Promise<void> {
  const root = await realpath(workspace)
  const target = resolve(root, path)
  if (
    ![join(root, '.local'), join(root, 'evals', 'private')].some((privateRoot) =>
      inside(target, privateRoot)
    )
  )
    throw new Error('private_admin_output_required')
  const json = JSON.stringify(publication, null, 2) + '\n'
  if (Buffer.byteLength(json, 'utf8') > 1048576) throw new Error('admin_output_too_large')
  let cursor = root
  for (const part of relative(root, dirname(target)).split(sep)) {
    cursor = join(cursor, part)
    try {
      await mkdir(cursor, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const info = await lstat(cursor)
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      relative(cursor, await realpath(cursor)) !== ''
    )
      throw new Error('private_admin_output_required')
  }
  // Windows ignores POSIX mode bits; protect the destination before creating the first byte.
  if ((await readdir(dirname(target))).length === 0) await protectPrivateDirectory(dirname(target))
  else await verifyPrivatePaths(dirname(target), [])
  const handle = await open(target, 'wx', 0o600)
  try {
    await handle.writeFile(json, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}
