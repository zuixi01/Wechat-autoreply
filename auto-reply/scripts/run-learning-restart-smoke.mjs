import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import electronPath from 'electron'
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const report = join(root, '.local', 'reports', 'learning-restart', randomUUID())
mkdirSync(report, { recursive: true })
for (const phase of ['prepare', 'recover']) {
  const environment = {
    ...process.env,
    LEARNING_RESTART_REPORT: report,
    LEARNING_RESTART_PHASE: phase
  }
  delete environment.ELECTRON_RUN_AS_NODE
  const child = spawn(
    electronPath,
    [join(root, 'scripts', 'learning-submission-restart-smoke.cjs')],
    { cwd: root, env: environment, windowsHide: true, stdio: 'inherit' }
  )
  const timeout = setTimeout(() => child.kill(), 35000)
  const code = await new Promise((resolve) => {
    child.once('error', () => resolve(1))
    child.once('exit', (code) => resolve(code ?? 1))
  })
  clearTimeout(timeout)
  if (code !== 0) {
    process.exitCode = 1
    break
  }
  const result = JSON.parse(readFileSync(join(report, `${phase}.json`), 'utf8'))
  if (!result.passed) {
    process.exitCode = 1
    break
  }
}
const passed = !process.exitCode
writeFileSync(
  join(report, 'result.json'),
  JSON.stringify(
    {
      passed,
      report,
      scenario: 'pending_manual_recovers_across_actual_Electron_process_restart',
      limitations: ['synthetic-local-engineering-proof']
    },
    null,
    2
  )
)
process.stdout.write(JSON.stringify({ passed, report }) + '\n')
