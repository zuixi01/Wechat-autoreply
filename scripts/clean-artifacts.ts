import { fileURLToPath } from 'node:url'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { planArtifacts, pruneArtifacts } from '../src/core/build/artifact-retention'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.some((arg) => !['--apply', '--include-recent'].includes(arg)))
    throw new Error('artifact_arguments_invalid')
  const plan = await planArtifacts(
    fileURLToPath(new URL('..', import.meta.url)),
    args.includes('--include-recent') ? 0 : 3600000
  )
  const report = join(plan.root, '.local', 'reports', 'artifact-cleanup')
  await mkdir(report, { recursive: true })
  await writeFile(join(report, 'plan.json'), JSON.stringify(plan, null, 2))
  console.log(
    JSON.stringify({
      dryRun: !args.includes('--apply'),
      directories: plan.paths.length,
      bytes: plan.bytes,
      keptBuilds: plan.keptBuilds,
      report
    })
  )
  if (args.includes('--apply')) {
    const result = await pruneArtifacts(plan)
    await writeFile(
      join(report, 'result.json'),
      JSON.stringify(
        { ...result, estimatedBytes: plan.bytes, completedAt: new Date().toISOString() },
        null,
        2
      )
    )
    console.log(
      JSON.stringify({
        removed: result.removed.length,
        failed: result.failed.length,
        estimatedBytes: plan.bytes
      })
    )
    if (result.failed.length) process.exitCode = 1
  }
}
void main().catch(() => {
  console.error('artifact_cleanup_failed')
  process.exitCode = 1
})
