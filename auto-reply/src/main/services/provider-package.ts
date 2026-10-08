import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { nativeInventory } from '../../core/adapters/native-package'

export interface PublishedProvider {
  id: string
  version: string
  entry: string
  moduleType: 'module'
  manifestSha256: string
  entrySha256: string
}
declare const __BUNDLED_PROVIDER_TRUST__: Readonly<Record<string, PublishedProvider>>

/** Only the application build supplies executable authority; no settings/IPC trust list. */
export function publishedProvider(id: string): PublishedProvider {
  const table = typeof __BUNDLED_PROVIDER_TRUST__ === 'undefined' ? {} : __BUNDLED_PROVIDER_TRUST__
  const item = Object.hasOwn(table, id) ? table[id] : undefined
  if (
    !item ||
    item.id !== id ||
    item.moduleType !== 'module' ||
    item.entry !== 'provider.bundle.js' ||
    !/^[a-f0-9]{64}$/.test(item.manifestSha256) ||
    !/^[a-f0-9]{64}$/.test(item.entrySha256)
  )
    throw new Error('provider_bundle_untrusted')
  return { ...item }
}

export async function verifyProviderContents(
  root: string,
  published: PublishedProvider
): Promise<{
  published: PublishedProvider
  manifestBytes: Buffer
  sourceBytes: Buffer
}> {
  try {
    if (
      JSON.stringify(await nativeInventory(root)) !==
      JSON.stringify(['manifest.json', published.entry].sort())
    )
      throw new Error('inventory_mismatch')
    const read = async (file: string, maximum: number, expected: string): Promise<Buffer> => {
      const filePath = join(root, file)
      if ((await lstat(filePath)).size > maximum) throw new Error('too_large')
      const bytes = await readFile(filePath)
      if (bytes.length > maximum || createHash('sha256').update(bytes).digest('hex') !== expected)
        throw new Error('digest_mismatch')
      return bytes
    }
    const manifestBytes = await read('manifest.json', 262144, published.manifestSha256)
    const sourceBytes = await read(published.entry, 1048576, published.entrySha256)
    return { published, manifestBytes, sourceBytes }
  } catch {
    throw new Error('provider_bundle_untrusted')
  }
}

export async function verifyPublishedProvider(
  root: string,
  id: string
): ReturnType<typeof verifyProviderContents> {
  return verifyProviderContents(root, publishedProvider(id))
}
