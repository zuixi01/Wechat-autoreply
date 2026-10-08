import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const host = vi.hoisted(() => ({ root: '', packaged: false }))
vi.mock('electron', () => ({
  app: {
    getAppPath: () => host.root,
    getPath: () => join(host.root, 'user-data'),
    getVersion: () => 'test',
    get isPackaged() {
      return host.packaged
    }
  }
}))
import {
  getBuiltinDoubaoInstalledInfo,
  getInstalledProviderManifest,
  installProviderFromUrl,
  loadInstalledProvider,
  loadBuiltinDoubaoProvider
} from '../../src/main/provider-bundle'

const roots: string[] = []
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
beforeEach(() => {
  host.packaged = false
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(async () => {
  vi.unstubAllGlobals()
  for (const root of roots.splice(0)) {
    if (!root.startsWith(join(tmpdir(), 'provider-boundary-')))
      throw new Error('fixture_path_invalid')
    await rm(root, { recursive: true, force: true })
  }
})
async function fixture(): Promise<{
  root: string
  bundle: string
  manifest: string
  source: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'provider-boundary-'))
  roots.push(root)
  host.root = root
  const bundle = join(root, 'resources/providers/volcengine-ark')
  await mkdir(bundle, { recursive: true })
  const manifest = JSON.stringify({
    apiVersion: 1,
    id: 'volcengine-ark',
    name: '测试内置服务',
    version: '1.0.0',
    entry: 'provider.bundle.js',
    moduleType: 'module',
    capabilities: ['chat'],
    configSchema: { type: 'object', properties: {}, required: [] }
  })
  const source = `globalThis.__providerExecuted = (globalThis.__providerExecuted || 0) + 1;
    export function createProvider() { return { async *run() { yield {type:'reply_text',content:'published-fixture'}; } }; }`
  await writeFile(join(bundle, 'manifest.json'), manifest)
  await writeFile(join(bundle, 'provider.bundle.js'), source)
  vi.stubGlobal('__providerExecuted', 0)
  vi.stubGlobal('__BUNDLED_PROVIDER_TRUST__', {
    'volcengine-ark': {
      id: 'volcengine-ark',
      version: '1.0.0',
      entry: 'provider.bundle.js',
      moduleType: 'module',
      manifestSha256: digest(manifest),
      entrySha256: digest(source)
    }
  })
  return { root, bundle, manifest, source }
}
describe('published provider code authority', () => {
  it.each([
    'https://supplier.invalid/manifest.json',
    'http://127.0.0.1/manifest.json',
    'file:///outside/manifest.json'
  ])('rejects external executable installation before reading %s', async (url) => {
    await fixture()
    await expect(installProviderFromUrl(url)).rejects.toThrow('此版本仅支持随应用发布的聊天服务')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('refuses installed user-directory code even when it impersonates the built-in id', async () => {
    const f = await fixture(),
      external = join(f.root, 'user-data/providers/volcengine-ark/1.0.0')
    await mkdir(external, { recursive: true })
    await writeFile(join(external, 'manifest.json'), f.manifest)
    await writeFile(join(external, 'provider.bundle.js'), f.source)
    const installed = {
      id: 'volcengine-ark',
      name: 'forged',
      version: '1.0.0',
      entryFile: join(external, 'provider.bundle.js'),
      installedAt: '0'
    }
    expect(await getInstalledProviderManifest(installed)).toBeNull()
    await expect(loadInstalledProvider(installed, {})).rejects.toThrow('provider_bundle_untrusted')
    expect((globalThis as Record<string, unknown>).__providerExecuted).toBe(0)
  })
  it('loads exact published bytes without network and returns the real provider output', async () => {
    await fixture()
    const installed = await getBuiltinDoubaoInstalledInfo()
    expect(installed?.id).toBe('volcengine-ark')
    const { provider } = await loadBuiltinDoubaoProvider({})
    const events = []
    for await (const event of provider.run({} as never)) events.push(event)
    expect(events).toEqual([{ type: 'reply_text', content: 'published-fixture' }])
    expect((globalThis as Record<string, unknown>).__providerExecuted).toBe(1)
    expect(fetch).not.toHaveBeenCalled()
  })
  it.each(['manifest.json', 'provider.bundle.js'])(
    'rejects a changed published %s before executing anything',
    async (file) => {
      const f = await fixture(),
        installed = await getBuiltinDoubaoInstalledInfo()
      await writeFile(join(f.bundle, file), (await readFile(join(f.bundle, file), 'utf8')) + '\n')
      expect(await getInstalledProviderManifest(installed)).toBeNull()
      await expect(loadInstalledProvider(installed!, {})).rejects.toThrow(
        'provider_bundle_untrusted'
      )
      expect((globalThis as Record<string, unknown>).__providerExecuted).toBe(0)
    }
  )
  it('refuses an unpinned build instead of trusting a local manifest', async () => {
    await fixture()
    vi.stubGlobal('__BUNDLED_PROVIDER_TRUST__', {})
    expect(await getBuiltinDoubaoInstalledInfo()).toBeNull()
  })
  it('rejects an extra local file that could change bundle resolution', async () => {
    const f = await fixture(),
      installed = await getBuiltinDoubaoInstalledInfo()
    await writeFile(join(f.bundle, 'package.json'), '{"type":"commonjs"}')
    await expect(loadInstalledProvider(installed!, {})).rejects.toThrow('provider_bundle_untrusted')
  })
  it('refuses a directory alias to published content', async () => {
    const f = await fixture(),
      installed = await getBuiltinDoubaoInstalledInfo()
    const alias = join(f.root, 'alias')
    await symlink(f.bundle, alias, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(
      loadInstalledProvider({ ...installed!, entryFile: join(alias, 'provider.bundle.js') }, {})
    ).rejects.toThrow('provider_bundle_untrusted')
  })
})
