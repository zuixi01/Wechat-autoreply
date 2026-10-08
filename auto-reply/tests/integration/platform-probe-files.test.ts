import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createPlatformProbeDirectory,
  readNativeProbeRelease,
  writePlatformProbeEvidence
} from '../../src/core/adapters/platform-probe-files'
import { collectPlatformProbe } from '../../src/core/adapters/platform-probe'
import { verifyPrivatePaths } from '../../src/core/persistence/private-backup-directory'
import { helperInfo } from '../helpers/native-package'
const roots: string[] = []
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'autoreply-platform-probe-'))
  roots.push(root)
  return root
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (!root.startsWith(join(tmpdir(), 'autoreply-platform-probe-')))
      throw new Error('unsafe_fixture_cleanup')
    await rm(root, { recursive: true, force: true })
  }
})
it('uses only a completed native publication record and its independently saved package pin', async () => {
  const root = await fixture(),
    id = randomUUID(),
    dir = join(root, '.local', 'reports', 'native-publish', id)
  await mkdir(dir, { recursive: true })
  const record = {
    status: 'passed',
    taskId: id,
    manifestSha256: 'a'.repeat(64),
    files: 399,
    bytes: 100000,
    info: helperInfo,
    commandsExecuted: ['info'],
    childExitConfirmed: true,
    chatWindowsRead: false,
    messagesSent: 0,
    publishedAt: new Date().toISOString()
  }
  await writeFile(join(dir, 'result.json'), JSON.stringify(record))
  expect(await readNativeProbeRelease(root, id)).toEqual({
    packageRoot: join(root, '.local', 'native', 'windows-x64'),
    manifestSha256: 'a'.repeat(64)
  })
  for (const changed of [
    { ...record, status: 'failed' },
    { ...record, taskId: randomUUID() },
    { ...record, childExitConfirmed: false },
    { ...record, info: { ...helperInfo, backgroundReadVerified: true } }
  ]) {
    await writeFile(join(dir, 'result.json'), JSON.stringify(changed))
    await expect(readNativeProbeRelease(root, id)).rejects.toThrow()
  }
  await writeFile(join(dir, 'result.json'), 'x'.repeat(65537))
  await expect(readNativeProbeRelease(root, id)).rejects.toThrow()
})
it('protects and verifies actual owner-only output, retains failure evidence, and never overwrites', async () => {
  const root = await fixture(),
    id = randomUUID(),
    release = randomUUID(),
    directory = await createPlatformProbeDirectory(root, id)
  const driver = {
    info: async () => helperInfo,
    listWindows: async () => ({ windows: [], identityVerified: false }),
    probe: async () => {
      throw new Error('must not be called')
    },
    stop: async () => {}
  }
  const evidence = await collectPlatformProbe(
    driver as never,
    { platform: 'wework', nativeReleaseId: release },
    'a'.repeat(64)
  )
  evidence.id = id
  await writePlatformProbeEvidence(directory, evidence)
  expect(JSON.parse(await readFile(join(directory, 'evidence.json'), 'utf8'))).toMatchObject({
    status: 'no_client_window',
    helperExitConfirmed: true,
    messagesRead: 0,
    messagesSent: 0,
    modelCalls: 0
  })
  await expect(
    verifyPrivatePaths(directory, [join(directory, 'evidence.json')])
  ).resolves.toBeUndefined()
  await expect(writePlatformProbeEvidence(directory, evidence)).rejects.toThrow()
  await expect(createPlatformProbeDirectory(root, id)).rejects.toThrow()
  await expect(
    writePlatformProbeEvidence(directory, { ...evidence, id: randomUUID() })
  ).rejects.toThrow('platform_probe_output_invalid')
})
it('rejects a previously public output directory without writing evidence', async () => {
  const root = await fixture(),
    id = randomUUID(),
    directory = join(root, id)
  await mkdir(directory, { mode: 0o755 })
  const driver = {
    info: async () => helperInfo,
    listWindows: async () => ({ windows: [], identityVerified: false }),
    probe: async () => {
      throw new Error('unexpected')
    },
    stop: async () => {}
  }
  const evidence = await collectPlatformProbe(
    driver as never,
    { platform: 'wechat', nativeReleaseId: randomUUID() },
    'a'.repeat(64)
  )
  evidence.id = id
  await expect(writePlatformProbeEvidence(directory, evidence)).rejects.toThrow(
    'private_backup_permissions_invalid'
  )
  await expect(readFile(join(directory, 'evidence.json'))).rejects.toThrow()
})
