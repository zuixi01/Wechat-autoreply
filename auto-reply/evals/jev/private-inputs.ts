import { lstat, open, realpath, type FileHandle } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { verifyPrivatePaths } from '../../src/core/persistence/private-backup-directory'
import { MAX_PRIVATE_JSON_BYTES } from '../memory/private-files'

function checkMaximum(maximum: number): void {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_PRIVATE_JSON_BYTES)
    throw new Error('invalid_private_input_budget')
}

async function checkedInput(root: string, path: string): Promise<string> {
  const target = resolve(root, path)
  const inside = (parent: string): boolean => {
    const part = relative(parent, target)
    return Boolean(part) && part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part)
  }
  if (![resolve(root, '.local'), resolve(root, 'evals/private')].some(inside))
    throw new Error('private_input_required')
  const info = await lstat(target),
    actual = await realpath(target)
  const same =
    process.platform === 'win32' ? actual.toLowerCase() === target.toLowerCase() : actual === target
  if (!info.isFile() || info.isSymbolicLink() || !same) throw new Error('private_input_required')
  if (process.platform !== 'win32' && info.mode & 0o077)
    throw new Error('private_backup_permissions_invalid')
  return target
}

async function readOpenedInput(handle: FileHandle, maximum: number): Promise<unknown> {
  const current = await handle.stat()
  if (!current.isFile() || current.size > maximum) throw new Error('input_too_large')
  if (process.platform !== 'win32' && current.mode & 0o077)
    throw new Error('private_backup_permissions_invalid')
  const block = Buffer.allocUnsafe(Math.min(65536, maximum + 1))
  const chunks: Buffer[] = []
  let length = 0
  while (length <= maximum) {
    const read = await handle.read(block, 0, Math.min(block.length, maximum + 1 - length), null)
    if (!read.bytesRead) break
    length += read.bytesRead
    if (length > maximum) throw new Error('input_too_large')
    chunks.push(Buffer.from(block.subarray(0, read.bytesRead)))
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length)))
}

/** Freshly verifies every path and OS permission; only interpreter round trips
 * are batched. No content is read before this batch's ACL checks pass. Open
 * handles are bounded to 64 and always closed, even on an invalid later part. */
export function readPrivateJevInputs(paths: string[], maximum?: number): Promise<unknown[]>
export function readPrivateJevInputs<T>(
  paths: string[],
  maximum: number,
  parse: (value: unknown, index: number) => T
): Promise<T[]>
export async function readPrivateJevInputs<T = unknown>(
  paths: string[],
  maximum = MAX_PRIVATE_JSON_BYTES,
  parse?: (value: unknown, index: number) => T
): Promise<T[]> {
  checkMaximum(maximum)
  if (
    !Array.isArray(paths) ||
    paths.length > 6000 ||
    paths.some((path) => typeof path !== 'string' || !path)
  )
    throw new Error('private_inputs_invalid')
  const root = await realpath(process.cwd())
  const result: T[] = []
  for (let offset = 0; offset < paths.length; offset += 64) {
    const handles: FileHandle[] = []
    const groups = new Map<string, string[]>()
    let failed = false
    let failure: unknown
    try {
      for (const input of paths.slice(offset, offset + 64)) {
        const path = await checkedInput(root, input)
        const handle = await open(path, 'r')
        handles.push(handle)
        const current = await handle.stat()
        if (!current.isFile() || current.size > maximum) throw new Error('input_too_large')
        if (process.platform !== 'win32' && current.mode & 0o077)
          throw new Error('private_backup_permissions_invalid')
        const parent = dirname(path)
        const siblings = groups.get(parent) ?? []
        siblings.push(path)
        groups.set(parent, siblings)
      }
      for (const [parent, siblings] of groups) await verifyPrivatePaths(parent, siblings)
      for (const [index, handle] of handles.entries()) {
        const value = await readOpenedInput(handle, maximum)
        result.push(parse ? parse(value, offset + index) : (value as T))
      }
    } catch (error) {
      failed = true
      failure = error
    } finally {
      const closed = await Promise.allSettled(handles.map((handle) => handle.close()))
      if (!failed && closed.some((item) => item.status === 'rejected')) {
        failed = true
        failure = new Error('private_input_close_failed')
      }
    }
    if (failed) throw failure
  }
  return result
}

export async function readPrivateJevInput(path: string, maximum = 16 * 1048576): Promise<unknown> {
  return (await readPrivateJevInputs([path], maximum))[0]
}
