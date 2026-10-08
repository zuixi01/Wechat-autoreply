import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import type { ArtifactDownloadOptions } from 'app-builder-lib/out/util/electronGet'

// Exercise the builder's actual CommonJS -> ESM dependency boundary on Node 24.
const require = createRequire(import.meta.url)
const { downloadElectronArtifactZip } =
  require('app-builder-lib/out/util/electronGet') as typeof import('app-builder-lib/out/util/electronGet')
const roots: string[] = []
const filename = 'electron-v44.5.1-win32-x64.zip'
const payload = Buffer.from('isolated downloader compatibility fixture')
const digest = createHash('sha256').update(payload).digest('hex')

afterEach(async () => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep + 'build-downloader-')) {
      throw new Error('unexpected_fixture_root')
    }
    await rm(root, { recursive: true, force: true })
  }
})

async function withFixture(
  run: (options: ArtifactDownloadOptions, requests: string[]) => Promise<void>
) {
  const root = await mkdtemp(join(tmpdir(), 'build-downloader-'))
  roots.push(root)
  vi.stubEnv('ELECTRON_DOWNLOAD_CACHE_MODE', '0')
  const requests: string[] = []
  const server = createServer((request, response) => {
    requests.push(request.url ?? '')
    response.writeHead(200, { 'Content-Length': payload.length })
    response.end(payload)
  })
  await new Promise<void>((done, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', done)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture_bind_failed')
  const options: ArtifactDownloadOptions = {
    version: '44.5.1',
    platformName: 'win32',
    arch: 'x64',
    artifactName: 'electron',
    cacheDir: join(root, 'cache'),
    electronDownload: {
      checksums: { [filename]: digest },
      // This resolver takes precedence over inherited mirror environment settings.
      mirrorOptions: { resolveAssetURL: async () => `http://127.0.0.1:${address.port}/${filename}` }
    }
  }
  try {
    await run(options, requests)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done()))
    )
  }
}

describe('fixed builder downloader dependency compatibility', () => {
  it('loads through the actual CJS builder, validates a local download and reuses its cache', async () => {
    await withFixture(async (options, requests) => {
      const first = await downloadElectronArtifactZip(options)
      expect(await readFile(first)).toEqual(payload)
      expect(resolve(first).startsWith(resolve(options.cacheDir!) + sep)).toBe(true)
      expect(await downloadElectronArtifactZip(options)).toBe(first)
      expect(requests).toEqual([`/${filename}`])
    })
  })

  it('rejects a checksum mismatch and does not poison the next validated download', async () => {
    await withFixture(async (options, requests) => {
      const bad = {
        ...options,
        electronDownload: {
          ...options.electronDownload,
          checksums: { [filename]: '0'.repeat(64) }
        }
      }
      await expect(downloadElectronArtifactZip(bad)).rejects.toThrow()
      expect(await readFile(await downloadElectronArtifactZip(options))).toEqual(payload)
      expect(requests).toEqual([`/${filename}`, `/${filename}`])
    })
  })
})
