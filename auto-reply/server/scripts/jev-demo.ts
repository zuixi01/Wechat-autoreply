import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { runOfflineJevDemo } from '../src/generation/offline-jev-demo'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.length > 1) throw new Error('usage')
  const output = args[0] ? resolve(args[0]) : undefined
  if (output) {
    const part = relative(resolve('.local'), output)
    if (!part || part.startsWith('..') || isAbsolute(part) || !output.endsWith('.json'))
      throw new Error('local_report_path_required')
  }
  const report = await runOfflineJevDemo()
  if (output) {
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  }
  process.stdout.write(
    JSON.stringify(
      {
        ...report,
        cases: report.cases.map(({ scenario, platform, calls, result }) => ({
          scenario,
          platform,
          stages: calls.map((call) => call.stage),
          status: result.status,
          automaticAllowed: result.automaticAllowed,
          reasons: result.reasons
        }))
      },
      null,
      2
    ) + '\n'
  )
  if (!report.passed) process.exitCode = 2
}

main().catch(() => {
  process.stderr.write(
    'Offline Jev demo failed. Usage: tsx server/scripts/jev-demo.ts [new .local/*.json report].\n'
  )
  process.exitCode = 1
})
