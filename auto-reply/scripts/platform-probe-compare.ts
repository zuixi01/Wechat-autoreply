import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseProbeComparisonArgs } from '../src/core/adapters/platform-probe-comparison'
import { comparePrivatePlatformProbes } from '../src/core/adapters/platform-probe-comparison-files'

async function main(): Promise<void> {
  const options = parseProbeComparisonArgs(process.argv.slice(2))
  if ('help' in options) {
    process.stdout.write(
      'Offline comparison of private platform metadata evidence\n--control PROBE_UUID --raw PROBE_UUID\nReads existing owner-only .local probe reports; never starts helpers, reads chat windows, calls models or sends messages. Compares counts from separate snapshots, never reconstructs a message tree or grants capabilities. Matching text/value patterns are metadata only.\n'
    )
    return
  }
  const workspace = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const { directory, comparison } = await comparePrivatePlatformProbes(
    workspace,
    options.controlId,
    options.rawId
  )
  process.stdout.write(JSON.stringify({ directory, ...comparison }) + '\n')
  if (comparison.status !== 'aggregate_comparison') process.exitCode = 2
}
void main().catch(() => {
  process.stderr.write(
    'Offline comparison unavailable. Check two probe UUIDs, evidence validity and private file permissions.\n'
  )
  process.exitCode = 1
})
