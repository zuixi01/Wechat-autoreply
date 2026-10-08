import { isAbsolute, relative, resolve, sep } from 'node:path'
import { calibratePolicies } from '../../evals/jev/calibration'
import { readPrivateJevInput } from '../../evals/jev/private-inputs'
import { writePrivateAdminOutput } from './private-admin-output'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.length !== 2) throw new Error('usage')
  const [input, output] = args.map((arg) => resolve(arg))
  const inside = (path: string, parent: string): boolean => {
    const part = relative(parent, path)
    return Boolean(part) && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part)
  }
  if (
    ![resolve('.local'), resolve('evals/private')].some((p) => inside(input, p)) ||
    !inside(output, resolve('.local')) ||
    input === output
  )
    throw new Error('private_paths_required')
  const report = calibratePolicies(await readPrivateJevInput(input))
  await writePrivateAdminOutput(output, report)
  process.stdout.write(
    `Calibration: ${report.status}; cases=${report.sampleCount}; conversations=${report.independentConversations}; holdout still required.\n`
  )
  if (report.status !== 'recommended_for_frozen_holdout') process.exitCode = 2
}
main().catch(() => {
  process.stderr.write(
    'Calibration failed. Use calibration-only independently annotated observations in .local or evals/private and a new .local output path.\n'
  )
  process.exitCode = 1
})
