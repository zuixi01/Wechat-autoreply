import { mkdir, lstat, open, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import { NativeAdapterInfoSchema } from '../../shared/contracts/native-package'
import {
  PlatformProbeEvidenceSchema,
  type PlatformProbeEvidence
} from '../../shared/contracts/platform-probe'
import {
  protectPrivateDirectory,
  verifyPrivatePaths
} from '../persistence/private-backup-directory'

const NativeReleaseSchema = z.strictObject({
  status: z.literal('passed'),
  taskId: z.uuid(),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  files: z.number().int().positive().max(1024),
  bytes: z.number().int().positive().max(500000000),
  info: NativeAdapterInfoSchema,
  commandsExecuted: z.tuple([z.literal('info')]),
  childExitConfirmed: z.literal(true),
  chatWindowsRead: z.literal(false),
  messagesSent: z.literal(0),
  publishedAt: z.iso.datetime()
})
/** Pin comes from the completed publisher record, never from computing the
 * hash of the package about to be executed. No arbitrary executable path. */
export async function readNativeProbeRelease(
  workspace: string,
  id: string
): Promise<{ packageRoot: string; manifestSha256: string }> {
  id = z.uuid().parse(id)
  const root = await realpath(workspace)
  const record = join(root, '.local', 'reports', 'native-publish', id, 'result.json')
  if (
    (await realpath(record)).toLowerCase() !== record.toLowerCase() ||
    (await lstat(record)).isSymbolicLink()
  )
    throw new Error('native_release_record_invalid')
  const bytes = await boundedRead(record, 65536)
  const release = NativeReleaseSchema.parse(JSON.parse(bytes.toString('utf8')))
  if (release.taskId !== id) throw new Error('native_release_record_invalid')
  return {
    packageRoot: join(root, '.local', 'native', 'windows-x64'),
    manifestSha256: release.manifestSha256
  }
}
async function boundedRead(path: string, maximum: number): Promise<Buffer> {
  const handle = await open(path, 'r')
  try {
    if (!(await handle.stat()).isFile()) throw new Error('native_release_record_invalid')
    const bytes = Buffer.alloc(maximum + 1)
    let length = 0
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, null)
      if (!read.bytesRead) break
      length += read.bytesRead
    }
    if (length > maximum) throw new Error('native_release_record_invalid')
    return bytes.subarray(0, length)
  } finally {
    await handle.close()
  }
}
/** Offline reads are restricted to existing private probe runs. No live driver is started. */
export async function readPlatformProbeEvidence(
  workspace: string,
  id: string
): Promise<{ evidence: PlatformProbeEvidence; sha256: string }> {
  id = z.uuid().parse(id)
  const root = await realpath(workspace)
  const directory = join(root, '.local', 'reports', 'platform-probe', id)
  const file = join(directory, 'evidence.json')
  await verifyPrivatePaths(directory, [file])
  const bytes = await boundedRead(file, 4194304)
  const evidence = PlatformProbeEvidenceSchema.parse(JSON.parse(bytes.toString('utf8')))
  if (evidence.id !== id) throw new Error('platform_probe_input_invalid')
  return { evidence, sha256: createHash('sha256').update(bytes).digest('hex') }
}
/** Fresh protected run directory; caller cannot choose a public output path. */
export async function createPlatformProbeDirectory(workspace: string, id: string): Promise<string> {
  id = z.uuid().parse(id)
  const root = await realpath(workspace)
  let cursor = root
  for (const part of ['.local', 'reports', 'platform-probe']) {
    cursor = join(cursor, part)
    try {
      await mkdir(cursor)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const stat = await lstat(cursor)
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (await realpath(cursor)).toLowerCase() !== cursor.toLowerCase()
    )
      throw new Error('platform_probe_output_invalid')
  }
  const directory = join(cursor, id)
  await mkdir(directory, { mode: 0o700 })
  await protectPrivateDirectory(directory)
  return directory
}
export async function writePlatformProbeEvidence(
  directory: string,
  raw: PlatformProbeEvidence
): Promise<void> {
  if (!isAbsolute(directory) || resolve(directory) !== directory)
    throw new Error('platform_probe_output_invalid')
  const evidence = PlatformProbeEvidenceSchema.parse(raw)
  if (basename(directory) !== evidence.id) throw new Error('platform_probe_output_invalid')
  await verifyPrivatePaths(directory, [])
  const bytes = Buffer.from(JSON.stringify(evidence, null, 2) + '\n', 'utf8')
  if (bytes.length > 4194304) throw new Error('platform_probe_output_too_large')
  const target = join(directory, 'evidence.json'),
    handle = await open(target, 'wx', 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await verifyPrivatePaths(directory, [target])
}
