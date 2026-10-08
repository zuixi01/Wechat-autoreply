import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const reportId = randomUUID()
const reportPath = join(root, '.local', 'reports', 'desktop-smoke', reportId, 'result.json')
const environment = { ...process.env }
const feedbackOnly = process.argv.includes('--feedback-only')
const restorationOnly = process.argv.includes('--restoration-only')
const adminOnly = process.argv.includes('--admin-only')
if ([feedbackOnly, restorationOnly, adminOnly].filter(Boolean).length > 1)
  throw new Error('desktop_smoke_mode_invalid')
delete environment.AUTOREPLY_DESKTOP_SMOKE_ADMIN_ONLY
if (adminOnly) environment.AUTOREPLY_DESKTOP_SMOKE_ADMIN_ONLY = '1'
delete environment.AUTOREPLY_DESKTOP_SMOKE_RESTORATION_ONLY
if (restorationOnly) environment.AUTOREPLY_DESKTOP_SMOKE_RESTORATION_ONLY = '1'
delete environment.AUTOREPLY_DESKTOP_SMOKE_FEEDBACK_ONLY
if (feedbackOnly) environment.AUTOREPLY_DESKTOP_SMOKE_FEEDBACK_ONLY = '1'
if (process.argv.includes('--software-rendering'))
  environment.AUTOREPLY_DESKTOP_SMOKE_SOFTWARE_RENDERING = '1'
// An explicit ID also overrides the latest preset supplied by npm scripts.
if (process.argv.includes('--latest-release') && !process.argv.includes('--build-id')) {
  const build = JSON.parse(
    await readFile(join(root, '.local', 'reports', 'windows-dev-build', 'latest.json'), 'utf8')
  )
  if (typeof build.id !== 'string' || !/^[a-f0-9-]{36}$/.test(build.id))
    throw new Error('desktop_smoke_build_id_invalid')
  environment.AUTOREPLY_DESKTOP_SMOKE_BUILD_ID = build.id
}
delete environment.ELECTRON_RUN_AS_NODE
const requestedIndex = process.argv.indexOf('--build-id')
if (requestedIndex >= 0) {
  const buildId = process.argv[requestedIndex + 1]
  if (
    process.argv.lastIndexOf('--build-id') !== requestedIndex ||
    typeof buildId !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(buildId)
  )
    throw new Error('desktop_smoke_build_id_invalid')
  environment.AUTOREPLY_DESKTOP_SMOKE_BUILD_ID = buildId
}
const child = spawn(electronPath, [join(root, 'scripts', 'desktop-smoke.cjs'), reportId], {
  cwd: root,
  env: environment,
  windowsHide: true,
  stdio: 'inherit'
})
const launchedAt = Date.now()
let timedOut = false
let exitSignal = null
const timeout = setTimeout(() => {
  timedOut = true
  child.kill()
}, 40000)
const exitCode = await new Promise((resolve) => {
  child.once('error', () => resolve(1))
  child.once('exit', (code, signal) => {
    exitSignal = signal
    resolve(code ?? 1)
  })
})
clearTimeout(timeout)
await writeFile(
  join(root, '.local', 'reports', 'desktop-smoke', reportId, 'runner-result.json'),
  JSON.stringify(
    {
      exitCode,
      exitSignal,
      timedOut,
      elapsedMs: Date.now() - launchedAt,
      buildId: environment.AUTOREPLY_DESKTOP_SMOKE_BUILD_ID ?? null,
      softwareRendering: environment.AUTOREPLY_DESKTOP_SMOKE_SOFTWARE_RENDERING === '1',
      feedbackOnly,
      restorationOnly
    },
    null,
    2
  ) + '\n'
)
try {
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  if (timedOut || exitCode !== 0 || report.passed !== true) throw new Error('smoke_failed')
  if (restorationOnly && report.mode !== 'restoration') throw new Error('smoke_mode_mismatch')
  if (!restorationOnly && report.mode === 'restoration') throw new Error('smoke_mode_mismatch')
  if (feedbackOnly && report.mode !== 'workbench-feedback') throw new Error('smoke_mode_mismatch')
  if (!feedbackOnly && report.mode === 'workbench-feedback') throw new Error('smoke_mode_mismatch')
  process.stdout.write(
    `${restorationOnly ? 'Verified restoration controls in the production renderer and preload' : feedbackOnly ? 'Verified workbench feedback across actual background polls' : 'Verified desktop startup, private IPC and SQLite'}: ${reportPath}\n`
  )
} catch {
  process.stderr.write(`Desktop startup not verified. Inspect local report: ${reportPath}\n`)
  process.exitCode = 1
}
