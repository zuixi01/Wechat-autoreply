import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { isAbsolute, join, normalize, resolve } from 'node:path'
import {
  NativePackageSchema,
  NativeRuntimeConfigSchema,
  type NativePackage
} from '../../shared/contracts/native-package'

function equalPath(a: string, b: string): boolean {
  const first = normalize(a),
    second = normalize(b)
  return process.platform === 'win32'
    ? first.toLowerCase() === second.toLowerCase()
    : first === second
}

/** No link/reparse alias or unexpected file can become an executable dependency. */
export async function nativeInventory(root: string): Promise<string[]> {
  if (
    !isAbsolute(root) ||
    !equalPath(await realpath(root), resolve(root)) ||
    (await lstat(root)).isSymbolicLink()
  )
    throw new Error('native_package_path_invalid')
  const files: string[] = []
  async function visit(relative: string, depth: number): Promise<void> {
    if (depth > 4) throw new Error('native_package_too_large')
    for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name
      const absolute = join(root, ...path.split('/'))
      if (entry.isSymbolicLink() || !equalPath(await realpath(absolute), absolute))
        throw new Error('native_package_path_invalid')
      if (entry.isDirectory()) await visit(path, depth + 1)
      else if (entry.isFile()) files.push(path)
      else throw new Error('native_package_path_invalid')
      if (files.length > 1025) throw new Error('native_package_too_large')
    }
  }
  await visit('', 0)
  return files.sort()
}
export async function nativeFileHash(path: string, maximum = 100_000_000): Promise<string> {
  const digest = createHash('sha256')
  let bytes = 0
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length
    if (bytes > maximum) throw new Error('native_package_too_large')
    digest.update(chunk)
  }
  return digest.digest('hex')
}
export async function verifyNativePackage(
  root: string,
  expectedHash: string
): Promise<NativePackage> {
  try {
    if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error('untrusted')
    const paths = await nativeInventory(root)
    const manifestPath = join(root, 'native-manifest.json')
    if ((await lstat(manifestPath)).size > 262144) throw new Error('too_large')
    const bytes = await readFile(manifestPath)
    if (createHash('sha256').update(bytes).digest('hex') !== expectedHash)
      throw new Error('digest_mismatch')
    const manifest = NativePackageSchema.parse(JSON.parse(bytes.toString('utf8')))
    const listed = manifest.files.map((file) => file.path).sort()
    if (
      JSON.stringify(paths.filter((path) => path !== 'native-manifest.json')) !==
      JSON.stringify(listed)
    )
      throw new Error('inventory_mismatch')
    for (const file of manifest.files) {
      const path = join(root, ...file.path.split('/'))
      if ((await lstat(path)).size !== file.bytes || (await nativeFileHash(path)) !== file.sha256)
        throw new Error('file_mismatch')
    }
    NativeRuntimeConfigSchema.parse(
      JSON.parse(await readFile(join(root, 'WindowsAdapter.runtimeconfig.json'), 'utf8'))
    )
    return manifest
  } catch {
    // Paths, arbitrary file contents and OS diagnostics never reach renderer/log errors.
    throw new Error('native_package_untrusted')
  }
}
