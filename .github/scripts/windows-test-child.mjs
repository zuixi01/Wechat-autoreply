import { spawn } from 'node:child_process'
import { mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

async function main() {
  const [suite, runId, ...extra] = process.argv.slice(2)
  if (
    !['preflight', 'verify'].includes(suite) ||
    !/^[a-f0-9-]{36}$/.test(runId || '') ||
    extra.length
  )
    throw new Error('ci_test_arguments_invalid')
  const root = await realpath(fileURLToPath(new URL('../../', import.meta.url)))
  if (process.versions.node !== (await readFile(join(root, '.node-version'), 'utf8')).trim())
    throw new Error('ci_test_node_version_mismatch')
  process.chdir(root)

  // CreateProcessWithTokenW may supply the user's profile environment. Establish
  // the required test environment in this child without logging its values.
  const temporary = join(root, '.local', 'ci-temp')
  await mkdir(temporary, { recursive: true })
  process.env.TEMP = process.env.TMP = await realpath(temporary)
  process.env.CI = 'true'
  process.env.PATH = dirname(process.execPath) + delimiter + (process.env.PATH || '')

  const reports = join(root, '.local', 'reports', 'ci-tests')
  await mkdir(reports, { recursive: true })
  const report = join(reports, runId)
  await mkdir(report) // Exclusive run directory; never overwrite another report.
  const log = await open(join(report, 'output.log'), 'wx', 0o600)
  const args =
    suite === 'preflight'
      ? [
          join(root, 'node_modules', 'vitest', 'vitest.mjs'),
          'run',
          'tests/unit/private-backup-directory.test.ts',
          'tests/unit/ledger-backup.test.ts',
          'tests/unit/runtime-timing-vault.test.ts',
          'tests/unit/native-package.test.ts'
        ]
      : [
          join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
          'run',
          'verify'
        ]
  let exitCode = 1
  try {
    exitCode = await new Promise((done, reject) => {
      const child = spawn(process.execPath, args, {
        cwd: root,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', log.fd, log.fd]
      })
      child.once('error', reject)
      child.once('close', (code) => done(code ?? 1))
    })
  } catch {
    await log.write('ci_test_process_start_failed\n')
  } finally {
    await log.close()
    await writeFile(
      join(report, 'result.json'),
      JSON.stringify(
        { suite, runId, nodeVersion: process.versions.node, exitCode, passed: exitCode === 0 },
        null,
        2
      ) + '\n',
      { flag: 'wx', mode: 0o600 }
    )
  }
  process.exitCode = exitCode
}

main().catch((error) => {
  console.error(
    error instanceof Error && /^ci_test_[a-z_]+$/.test(error.message)
      ? error.message
      : 'ci_test_child_failed'
  )
  process.exitCode = 1
})
