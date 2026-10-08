import { randomUUID } from 'node:crypto'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { comparePlatformProbes, type PlatformProbeComparison } from './platform-probe-comparison'
import { createPlatformProbeDirectory, readPlatformProbeEvidence } from './platform-probe-files'
import { verifyPrivatePaths } from '../persistence/private-backup-directory'

export async function comparePrivatePlatformProbes(
  workspace: string,
  controlId: string,
  rawId: string
): Promise<{ directory: string; comparison: PlatformProbeComparison }> {
  const [control, raw] = await Promise.all([
    readPlatformProbeEvidence(workspace, controlId),
    readPlatformProbeEvidence(workspace, rawId)
  ])
  const comparison = comparePlatformProbes(control.evidence, raw.evidence)
  const id = randomUUID()
  const directory = await createPlatformProbeDirectory(workspace, id)
  const file = join(directory, 'comparison.json')
  const handle = await open(file, 'wx', 0o600)
  try {
    await handle.writeFile(
      JSON.stringify(
        {
          formatVersion: 1,
          kind: 'native-platform-aggregate-comparison',
          id,
          createdAt: Date.now(),
          sources: {
            control: { id: controlId, sha256: control.sha256 },
            raw: { id: rawId, sha256: raw.sha256 }
          },
          ...comparison
        },
        null,
        2
      ) + '\n'
    )
    await handle.sync()
  } finally {
    await handle.close()
  }
  await verifyPrivatePaths(directory, [file])
  return { directory, comparison }
}
