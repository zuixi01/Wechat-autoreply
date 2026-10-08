import { expect, it, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createReleaseSourceSnapshot,
  inventoryReleaseSources,
  verifyReleaseSourceSnapshot
} from '../../src/core/build/release-source-snapshot'
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (!root.startsWith(join(tmpdir(), 'autoreply-source-snapshot-')))
      throw new Error('unsafe_cleanup')
    await rm(root, { recursive: true, force: true })
  }
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'autoreply-source-snapshot-'))
  roots.push(root)
  for (const folder of ['src', 'scripts', 'native', 'resources']) {
    await mkdir(join(root, folder))
    await writeFile(join(root, folder, 'fixture.txt'), folder)
  }
  for (const file of [
    'package.json',
    'package-lock.json',
    'electron.vite.config.ts',
    'electron-builder.yml',
    'tsconfig.node.json',
    'tsconfig.web.json'
  ])
    await writeFile(join(root, file), '{}')
  const id = randomUUID()
  await mkdir(join(root, '.local/release-build', id), { recursive: true })
  return { root, id }
}
it('freezes real input bytes, tolerates subsequent editing of the original, and rejects changes in the snapshot', async () => {
  const { root, id } = await fixture()
  const { sourceRoot, manifest } = await createReleaseSourceSnapshot(root, id)
  await writeFile(join(root, 'src/fixture.txt'), 'new editing version')
  expect(await readFile(join(sourceRoot, 'src/fixture.txt'), 'utf8')).toBe('src')
  await expect(verifyReleaseSourceSnapshot(sourceRoot, manifest)).resolves.toBeUndefined()
  await writeFile(join(sourceRoot, 'src/fixture.txt'), 'different compiled version')
  await expect(verifyReleaseSourceSnapshot(sourceRoot, manifest)).rejects.toThrow(
    'release_source_changed'
  )
})
it('omits generated/native intermediates, personal settings, credentials and database bytes', async () => {
  const { root, id } = await fixture()
  await mkdir(join(root, 'native/bin'))
  await mkdir(join(root, 'native/obj'))
  await mkdir(join(root, 'tests/native/InputFixture/bin'), { recursive: true })
  await mkdir(join(root, 'tests/native/InputFixture/obj'), { recursive: true })
  for (const path of [
    'src/.env',
    'src/.env.local',
    'src/credential.key',
    'src/profile.sqlite',
    'native/bin/old.dll',
    'native/obj/project.assets.json',
    'tests/native/InputFixture/bin/fixture.exe',
    'tests/native/InputFixture/obj/project.assets.json'
  ])
    await writeFile(join(root, path), 'PRIVATE_RUNTIME')
  const { sourceRoot, manifest } = await createReleaseSourceSnapshot(root, id)
  expect(manifest.files).toHaveLength(10)
  for (const file of manifest.files)
    expect(await readFile(join(sourceRoot, file.path), 'utf8')).not.toContain('PRIVATE_RUNTIME')
  await expect(createReleaseSourceSnapshot(root, id)).rejects.toThrow()
})
it('rejects source aliases rather than following them into files outside the input tree', async () => {
  const { root } = await fixture()
  await symlink(
    join(root, 'scripts'),
    join(root, 'src/linked'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  await expect(inventoryReleaseSources(root)).rejects.toThrow('release_source_alias')
})
it('rejects added files and a changed manifest instead of certifying a different source set', async () => {
  const { root, id } = await fixture()
  const { sourceRoot, manifest } = await createReleaseSourceSnapshot(root, id)
  await expect(
    verifyReleaseSourceSnapshot(sourceRoot, { ...manifest, digest: 'a'.repeat(64) })
  ).rejects.toThrow('release_source_changed')
  await writeFile(join(sourceRoot, 'src/new.ts'), 'export const unreviewed = true')
  await expect(verifyReleaseSourceSnapshot(sourceRoot, manifest)).rejects.toThrow(
    'release_source_changed'
  )
})

it('includes real source bin folders while excluding only native compiler intermediates', async () => {
  const { root, id } = await fixture()
  await mkdir(join(root, 'src/bin'))
  await writeFile(join(root, 'src/bin/worker.ts'), 'export const compiledInput = true')
  const { sourceRoot, manifest } = await createReleaseSourceSnapshot(root, id)
  expect(manifest.files.map((file) => file.path)).toContain('src/bin/worker.ts')
  expect(await readFile(join(sourceRoot, 'src/bin/worker.ts'), 'utf8')).toContain('compiledInput')
})
