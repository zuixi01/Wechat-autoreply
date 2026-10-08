import { readFile, stat, realpath, mkdir, open } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import {
  protectPrivateDirectory,
  verifyPrivatePaths
} from '../../src/core/persistence/private-backup-directory'

export const MAX_PRIVATE_JSON_BYTES = 64 * 1024 * 1024

function inside(path: string, root: string): boolean {
  const part = relative(root, path)
  return part !== '' && part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part)
}
export async function readPrivateJson(path: string): Promise<unknown> {
  const root = await realpath(process.cwd()),
    input = await realpath(resolve(path))
  if (![resolve(root, '.local'), resolve(root, 'evals/private')].some((p) => inside(input, p)))
    throw new Error('private_input_required')
  const info = await stat(input)
  if (!info.isFile() || info.size > MAX_PRIVATE_JSON_BYTES) throw new Error('invalid_input_file')
  return JSON.parse(await readFile(input, 'utf8'))
}
/** Never emit a successful packet that the same workflow cannot read again. */
export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const root = await realpath(process.cwd()),
    output = resolve(path)
  const parent = await realpath(dirname(output))
  if (!inside(output, resolve(root, '.local')) || !inside(parent, resolve(root, '.local')))
    throw new Error('local_output_required')
  const encoded = JSON.stringify(value, null, 2)
  if (encoded === undefined) throw new Error('invalid_output_json')
  const body = encoded + '\n'
  if (Buffer.byteLength(body, 'utf8') > MAX_PRIVATE_JSON_BYTES)
    throw new Error('private_output_too_large')
  await verifyPrivatePaths(parent, [])
  const handle = await open(output, 'wx', 0o600)
  try {
    await handle.writeFile(body, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await verifyPrivatePaths(parent, [output])
}
export async function createPrivateOutput(path: string): Promise<string> {
  const root = await realpath(process.cwd()),
    local = resolve(root, '.local'),
    output = resolve(path)
  if (!inside(output, local)) throw new Error('local_output_required')
  let cursor = dirname(output)
  while (true) {
    try {
      const actual = await realpath(cursor)
      if (actual !== root && actual !== local && !inside(actual, local))
        throw new Error('linked_output_forbidden')
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(cursor)
      if (parent === cursor) throw error
      cursor = parent
    }
  }
  await mkdir(dirname(output), { recursive: true })
  const parent = await realpath(dirname(output))
  if (parent !== local && !inside(parent, local)) throw new Error('linked_output_forbidden')
  await mkdir(output)
  const actual = await realpath(output)
  if (!inside(actual, local)) throw new Error('linked_output_forbidden')
  await protectPrivateDirectory(actual)
  return actual
}
