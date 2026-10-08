import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { verifyNativePackage } from '../../src/core/adapters/native-package'
import { fixturePackage, sealPackage } from '../helpers/native-package'
import { NativePackageSchema } from '../../src/shared/contracts/native-package'

const roots: string[] = []
async function fixture() {
  const f = await fixturePackage()
  roots.push(f.root)
  return f
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
describe('pinned self-contained native package', () => {
  it('accepts the complete pinned inventory', async () => {
    const f = await fixture()
    expect((await verifyNativePackage(f.root, f.pin)).files).toHaveLength(10)
  })
  it.each(['tamper', 'missing', 'extra', 'wrong-pin'])(
    'rejects %s before executing',
    async (kind) => {
      const f = await fixture()
      if (kind === 'tamper') await writeFile(join(f.root, 'coreclr.dll'), 'changed')
      if (kind === 'missing') await unlink(join(f.root, 'WindowsAdapter.exe'))
      if (kind === 'extra') await writeFile(join(f.root, 'unexpected.dll'), 'injected')
      await expect(
        verifyNativePackage(f.root, kind === 'wrong-pin' ? '0'.repeat(64) : f.pin)
      ).rejects.toThrow('native_package_untrusted')
    }
  )
  it('rejects a repinned manifest that depends on an installed runtime', async () => {
    const f = await fixture()
    await writeFile(
      join(f.root, 'WindowsAdapter.runtimeconfig.json'),
      JSON.stringify({
        runtimeOptions: {
          tfm: 'net10.0',
          framework: { name: 'Microsoft.NETCore.App', version: '10.0.12' }
        }
      })
    )
    await expect(verifyNativePackage(f.root, await sealPackage(f.root))).rejects.toThrow(
      'native_package_untrusted'
    )
  })
  it.each(['../evil.dll', 'A.dll', 'a.dll', 'nested//evil.dll', 'file.dll.', 'C:/evil.dll'])(
    'rejects malformed or duplicate-case inventory %s',
    async (path) => {
      const f = await fixture()
      const data = JSON.parse(await readFile(join(f.root, 'native-manifest.json'), 'utf8'))
      data.files.push({ path, bytes: 0, sha256: '0'.repeat(64) })
      // For otherwise valid case variants, add a duplicate differing only in case.
      if (path === 'A.dll' || path === 'a.dll')
        data.files.push({ ...data.files.at(-1), path: path === 'A.dll' ? 'a.dll' : 'A.dll' })
      expect(NativePackageSchema.safeParse(data).success).toBe(false)
    }
  )
  it('rejects directory junctions even with an otherwise matching pin', async () => {
    const f = await fixture(),
      link = f.root + '-alias'
    roots.push(link)
    await symlink(f.root, link, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(verifyNativePackage(link, f.pin)).rejects.toThrow('native_package_untrusted')
  })
  it('pins the manifest bytes, not only the executable hash', async () => {
    const f = await fixture(),
      path = join(f.root, 'native-manifest.json')
    const changed = (await readFile(path, 'utf8')) + '\n'
    await writeFile(path, changed)
    expect(createHash('sha256').update(changed).digest('hex')).not.toBe(f.pin)
    await expect(verifyNativePackage(f.root, f.pin)).rejects.toThrow('native_package_untrusted')
  })
})
