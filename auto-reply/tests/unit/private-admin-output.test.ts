import { link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, basename, resolve } from 'node:path'
import { verifyPrivatePaths } from '../../src/core/persistence/private-backup-directory'
import { describe, expect, it } from 'vitest'
import { writePrivateAdminOutput } from '../../server/scripts/private-admin-output'

async function removeTestDirectory(root: string, prefix: string): Promise<void> {
  const target = resolve(root)
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith(prefix))
    throw new Error('test_cleanup_target_invalid')
  await rm(target, { recursive: true, force: true })
}

describe('private administrator draft output', () => {
  it('writes a fresh private JSON file and refuses replacement and public output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'learning-admin-output-'))
    try {
      const path = join(root, '.local/prepared/publication.json')
      await writePrivateAdminOutput(path, { privateEvidence: 'synthetic-private' }, root)
      await verifyPrivatePaths(dirname(path), [path])
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
        privateEvidence: 'synthetic-private'
      })
      await expect(writePrivateAdminOutput(path, { changed: true }, root)).rejects.toThrow()
      expect(await readFile(path, 'utf8')).toContain('synthetic-private')
      await expect(writePrivateAdminOutput(join(root, 'public.json'), {}, root)).rejects.toThrow(
        'private_admin_output_required'
      )
      await expect(
        writePrivateAdminOutput(join(root, '.local/../../escaped.json'), {}, root)
      ).rejects.toThrow('private_admin_output_required')
      await expect(
        writePrivateAdminOutput(
          join(root, '.local/large.json'),
          { body: 'x'.repeat(1048576) },
          root
        )
      ).rejects.toThrow('admin_output_too_large')
    } finally {
      await removeTestDirectory(root, 'learning-admin-output-')
    }
  })
  it('rejects a junction into public storage and never replaces a linked target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'learning-admin-link-'))
    try {
      const outside = join(root, 'public')
      await mkdir(outside)
      await mkdir(join(root, '.local'))
      await symlink(outside, join(root, '.local/link'), 'junction')
      await expect(
        writePrivateAdminOutput(join(root, '.local/link/private.json'), {}, root)
      ).rejects.toThrow('private_admin_output_required')
      const target = join(outside, 'target.json')
      await writeFile(target, 'unchanged')
      // A hard link exercises Windows file replacement without symlink privileges.
      await link(target, join(root, '.local/target.json'))
      await expect(
        writePrivateAdminOutput(join(root, '.local/target.json'), {}, root)
      ).rejects.toThrow()
      expect(await readFile(target, 'utf8')).toBe('unchanged')
    } finally {
      await removeTestDirectory(root, 'learning-admin-link-')
    }
  })
})
