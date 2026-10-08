import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { fixturePackage } from '../helpers/native-package'
import { createPackage } from '@electron/asar'

const requireHook = createRequire(import.meta.url)
const check = requireHook('../../scripts/native-pack-check.cjs') as (
  context: {
    electronPlatformName: string
    arch: number
    packager: { projectDir: string }
    appOutDir?: string
  },
  after: boolean
) => Promise<void>
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const f = await fixturePackage()
  roots.push(f.root)
  const root = await mkdtemp(join(tmpdir(), 'autoreply-native-pack-'))
  roots.push(root)
  const native = join(root, '.local', 'native', 'windows-x64')
  await mkdir(join(root, '.local', 'native'), { recursive: true })
  await rename(f.root, native)
  await mkdir(join(root, 'out', 'main'), { recursive: true })
  const entry = join(root, 'out', 'main', 'native-adapter.js')
  await writeFile(entry, `const nativeAdapterBuildInfo = { manifestSha256: "${f.pin}" };`)
  const providerRoot = join(root, 'resources/providers/volcengine-ark')
  await mkdir(providerRoot, { recursive: true })
  const manifest = '{"id":"volcengine-ark","version":"1.0.0"}',
    source = 'export function createProvider(){}'
  await writeFile(join(providerRoot, 'manifest.json'), manifest)
  await writeFile(join(providerRoot, 'provider.bundle.js'), source)
  const hash = (data: string): string => createHash('sha256').update(data).digest('hex')
  const providerEntry = join(root, 'out/main/provider-package.js')
  await writeFile(
    providerEntry,
    `const table = { "volcengine-ark": { manifestSha256: "${hash(manifest)}", entrySha256: "${hash(source)}" } };`
  )
  return {
    root,
    native,
    entry,
    providerRoot,
    providerEntry,
    context: { electronPlatformName: 'win32', arch: 1, packager: { projectDir: root } }
  }
}
describe('Windows packaging admission', () => {
  it('rejects an altered published provider before packaging', async () => {
    const f = await fixture()
    await writeFile(join(f.providerRoot, 'provider.bundle.js'), 'changed')
    await expect(check(f.context, false)).rejects.toThrow('provider_bundle_untrusted')
  })
  it('rejects a provider build with no fixed executable pins', async () => {
    const f = await fixture()
    await writeFile(f.providerEntry, 'const table = {}')
    await expect(check(f.context, false)).rejects.toThrow('provider_bundle_build_pin_missing')
  })
  it('accepts files pinned by the actual compiled factory', async () => {
    const f = await fixture()
    await expect(check(f.context, false)).resolves.toBeUndefined()
  })
  it('rejects a missing build pin', async () => {
    const f = await fixture()
    await writeFile(f.entry, 'const factory = {}')
    await expect(check(f.context, false)).rejects.toThrow('native_adapter_build_pin_missing')
  })
  it('rejects a modified dependency before packaging', async () => {
    const f = await fixture()
    await writeFile(join(f.native, 'coreclr.dll'), 'changed')
    await expect(check(f.context, false)).rejects.toThrow('native_package_untrusted')
  })
  it('rejects packaging x64 helper for another architecture', async () => {
    const f = await fixture()
    await expect(check({ ...f.context, arch: 3 }, false)).rejects.toThrow(
      'native_adapter_platform_unsupported'
    )
  })
  it('leaves another platform packaging outside the Windows helper policy', async () => {
    await expect(
      check({ electronPlatformName: 'linux', arch: 1, packager: { projectDir: 'unused' } }, false)
    ).resolves.toBeUndefined()
  })
  it('reads the real Windows ASAR path and verifies the copied resources', async () => {
    const f = await fixture()
    const input = join(f.root, 'archive-input')
    await mkdir(join(input, 'out', 'main'), { recursive: true })
    await writeFile(join(input, 'out', 'main', 'native-adapter.js'), await readFile(f.entry))
    await writeFile(join(input, 'out/main/provider-package.js'), await readFile(f.providerEntry))
    const unpackedProvider = join(
      f.root,
      'resources/app.asar.unpacked/resources/providers/volcengine-ark'
    )
    await mkdir(join(f.root, 'resources/app.asar.unpacked/resources/providers'), {
      recursive: true
    })
    await rename(f.providerRoot, unpackedProvider)
    await mkdir(join(f.root, 'resources', 'native'), { recursive: true })
    const native = join(f.root, 'resources', 'native', 'windows-x64')
    await rename(f.native, native)
    await createPackage(input, join(f.root, 'resources', 'app.asar'))
    const context = { ...f.context, appOutDir: f.root }
    await expect(check(context, true)).resolves.toBeUndefined()
    await writeFile(join(native, 'hostpolicy.dll'), 'changed')
    await expect(check(context, true)).rejects.toThrow('native_package_untrusted')
  })
})
