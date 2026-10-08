import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, relative, isAbsolute, dirname } from 'node:path'
import { evaluateDataset } from '../../evals/jev/metrics'

async function main(): Promise<void> {
  const [inputArg, outputArg] = process.argv.slice(2)
  if (!inputArg || !outputArg) throw new Error('usage')
  const root = process.cwd(),
    input = resolve(inputArg),
    output = resolve(outputArg)
  const inside = (path: string, parent: string): boolean => {
    const part = relative(parent, path)
    return part !== '' && !part.startsWith('..') && !isAbsolute(part)
  }
  // Do not accidentally write private annotations into tracked source files.
  if (
    ![resolve(root, '.local'), resolve(root, 'evals/private')].some((p) => inside(input, p)) ||
    !inside(output, resolve(root, '.local')) ||
    input === output
  )
    throw new Error('private_paths_required')
  const report = evaluateDataset(JSON.parse(await readFile(input, 'utf8')))
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  process.stdout.write(
    `Evaluation: ${report.assessment.status}; calibration=${report.sample.calibration}, holdout=${report.sample.holdout}\n`
  )
  if (report.assessment.status !== 'observed_targets_met') process.exitCode = 2
}
main().catch(() => {
  process.stderr.write(
    'Evaluation failed. Use adjudicated paired A/B/C input in .local or evals/private and a new .local output path.\n'
  )
  process.exitCode = 1
})
