import { it, expect } from 'vitest'
import { mkdir, mkdtemp, writeFile, rm, symlink, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { planArtifacts, pruneArtifacts } from '../../src/core/build/artifact-retention'

it('prunes only generated caches, preserves referenced successful builds and never follows a junction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifact-retention-'))
  const outside = await mkdtemp(join(tmpdir(), 'artifact-outside-'))
  const latest = randomUUID(),
    old = randomUUID(),
    link = randomUUID()
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'autoreply-desktop-agent' }))
    await writeFile(join(outside, 'keep.txt'), 'keep')
    await mkdir(join(root, '.local', 'reports', 'windows-dev-build', latest), { recursive: true })
    await writeFile(
      join(root, '.local', 'reports', 'windows-dev-build', latest, 'result.json'),
      JSON.stringify({ passed: true })
    )
    await writeFile(
      join(root, '.local', 'reports', 'windows-dev-build', 'latest.json'),
      JSON.stringify({ id: latest })
    )
    await mkdir(join(root, 'dist', `windows-dev-${latest}`), { recursive: true })
    await mkdir(join(root, 'dist', `windows-dev-${old}`), { recursive: true })
    await writeFile(join(root, 'dist', `windows-dev-${old}`, 'cache.bin'), 'cache')
    await symlink(
      outside,
      join(root, 'dist', `windows-dev-${link}`),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    await mkdir(join(root, 'user-data'), { recursive: true })
    await writeFile(join(root, 'user-data', 'private.sqlite'), 'private')
    const plan = await planArtifacts(root, 0)
    expect(plan.paths).toEqual([join('dist', `windows-dev-${old}`)])
    expect(plan.bytes).toBe(5)
    await expect(pruneArtifacts({ ...plan, paths: ['user-data'] })).rejects.toThrow(
      'artifact_path_invalid'
    )
    expect((await pruneArtifacts(plan)).removed).toEqual(plan.paths)
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('keep')
    expect(await readFile(join(root, 'user-data', 'private.sqlite'), 'utf8')).toBe('private')
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})
