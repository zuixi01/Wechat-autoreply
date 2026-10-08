import { afterEach, expect, it } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { comparePrivatePlatformProbes } from '../../src/core/adapters/platform-probe-comparison-files'
import {
  createPlatformProbeDirectory,
  readPlatformProbeEvidence
} from '../../src/core/adapters/platform-probe-files'
import { verifyPrivatePaths } from '../../src/core/persistence/private-backup-directory'
import { probeComparisonPair } from '../helpers/platform-probe-comparison'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (!root.startsWith(join(tmpdir(), 'autoreply-probe-comparison-')))
      throw new Error('unsafe_cleanup')
    await rm(root, { recursive: true, force: true })
  }
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'autoreply-probe-comparison-'))
  roots.push(root)
  return root
}
it('reads actual private files, binds exact source bytes, saves a fresh private aggregate, and leaves originals unchanged', async () => {
  const root = await fixture(),
    { control, raw } = probeComparisonPair()
  const originals = new Map<string, string>()
  for (const source of [control, raw]) {
    const directory = await createPlatformProbeDirectory(root, source.id)
    const bytes = JSON.stringify(source)
    originals.set(join(directory, 'evidence.json'), bytes)
    await writeFile(join(directory, 'evidence.json'), bytes, { flag: 'wx', mode: 0o600 })
  }
  const result = await comparePrivatePlatformProbes(root, control.id, raw.id)
  const file = join(result.directory, 'comparison.json')
  const report = JSON.parse(await readFile(file, 'utf8'))
  expect(report).toMatchObject({
    kind: 'native-platform-aggregate-comparison',
    status: 'aggregate_comparison',
    snapshotsMerged: false,
    messagesSent: 0,
    sources: {
      control: {
        id: control.id,
        sha256: createHash('sha256')
          .update([...originals.values()][0])
          .digest('hex')
      }
    }
  })
  expect(JSON.stringify(report)).not.toContain('PRIVATE_')
  await verifyPrivatePaths(result.directory, [file])
  for (const [path, bytes] of originals) expect(await readFile(path, 'utf8')).toBe(bytes)
})
it('rejects oversized or misbound files instead of constructing a comparison', async () => {
  const root = await fixture(),
    { control } = probeComparisonPair()
  const directory = await createPlatformProbeDirectory(root, control.id)
  const file = join(directory, 'evidence.json')
  await writeFile(file, JSON.stringify({ ...control, id: randomUUID() }), { mode: 0o600 })
  await expect(readPlatformProbeEvidence(root, control.id)).rejects.toThrow(
    'platform_probe_input_invalid'
  )
  await writeFile(file, ' '.repeat(4194305))
  await expect(readPlatformProbeEvidence(root, control.id)).rejects.toThrow()
})

it('rejects a directory alias before accepting private evidence from another run', async () => {
  const root = await fixture(),
    { control } = probeComparisonPair()
  const directory = await createPlatformProbeDirectory(root, control.id)
  await writeFile(join(directory, 'evidence.json'), JSON.stringify(control), { mode: 0o600 })
  const aliasId = randomUUID()
  const alias = join(root, '.local', 'reports', 'platform-probe', aliasId)
  await symlink(directory, alias, process.platform === 'win32' ? 'junction' : 'dir')
  await expect(readPlatformProbeEvidence(root, aliasId)).rejects.toThrow(
    'private_backup_permissions_invalid'
  )
})
