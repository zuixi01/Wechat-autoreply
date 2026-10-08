import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { reconcileJevSettlements } from '../../evals/jev/settlement-reconciliation'
import { readPrivateJevInput } from '../../evals/jev/private-inputs'
import { MAX_PRIVATE_JSON_BYTES } from '../../evals/memory/private-files'
import { hashContext } from '../../src/core/reply/hashes'
import { closePrivatePermissionWorker } from '../../src/core/persistence/private-backup-directory'
import { writePrivateAdminOutput } from './private-admin-output'

function inside(path: string, parent: string): boolean {
  const part = relative(parent, path)
  return Boolean(part) && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part)
}

/** Offline normalized-claim correlation. The retained input and the pure API
 * reproduce per-attempt details; this bounded file contains their summary/hash.
 * No database, supplier call, authentication or approval is performed. */
export async function runJevSettlementsCommand(
  args: string[],
  write: (message: string) => void = (message) => {
    process.stdout.write(message)
  }
): Promise<number> {
  if (args.length === 1 && args[0] === '--help') {
    write(
      'Usage: jev:settlements INPUT.private.json OUTPUT-summary.private.json\nOffline correlation only; retain the private input. No models called or messages sent.\n'
    )
    return 0
  }
  if (args.length !== 2 || args.some((arg) => !arg || arg.startsWith('--')))
    throw new Error('settlement_command_usage')
  const [input, output] = args.map((arg) => resolve(arg))
  const samePath =
    process.platform === 'win32' ? input.toLowerCase() === output.toLowerCase() : input === output
  if (
    ![resolve('.local'), resolve('evals/private')].some((p) => inside(input, p)) ||
    !inside(output, resolve('.local')) ||
    samePath
  )
    throw new Error('private_paths_required')
  const report = reconcileJevSettlements(await readPrivateJevInput(input, MAX_PRIVATE_JSON_BYTES))
  const { cases, reportHash, ...summary } = report
  const body = {
    ...summary,
    protocol: 'jev-settlement-correlation-summary-v1',
    fullReportHash: reportHash,
    caseArmCount: cases.length,
    details: 'recompute_from_retained_private_input'
  }
  await writePrivateAdminOutput(output, { ...body, summaryHash: hashContext(body) })
  write(
    `Settlement correlation: ${report.status}; attempts=${report.attemptCount}; unresolved=${report.unresolvedAttemptCount}; budget=${report.declaredBudgetAssessment.status}. Supplier authenticity and admission remain unverified. No models called or messages sent.\n`
  )
  // Even complete declared fees do not certify their source or authorize release.
  return 2
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : ''
const modulePath = fileURLToPath(import.meta.url)
const isEntry =
  process.platform === 'win32'
    ? entryPath.toLowerCase() === modulePath.toLowerCase()
    : entryPath === modulePath
if (isEntry)
  void runJevSettlementsCommand(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch(() => {
      process.stderr.write(
        'Settlement correlation failed. Check the private normalized input and a fresh .local output path. No models called or messages sent.\n'
      )
      process.exitCode = 1
    })
    .finally(closePrivatePermissionWorker)
