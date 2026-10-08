import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const root = dirname(dirname(fileURLToPath(import.meta.url))),
  report = join(root, '.local/reports/workbench-presentation', randomUUID())
await mkdir(report, { recursive: true })
const fixture = join(report, 'fixture.cjs')
await build({
  entryPoints: [join(root, 'scripts/workbench-presentation-desktop-fixture.ts')],
  outfile: fixture,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  logLevel: 'silent'
})
const environment = { ...process.env, AUTOREPLY_PRESENTATION_FIXTURE: '1' }
delete environment.ELECTRON_RUN_AS_NODE
const child = spawn(electronPath, [fixture, report], {
  cwd: root,
  env: environment,
  // This dedicated fixture verifies a foreground GUI. Other desktop fixtures stay hidden.
  // A hidden process startup must not override the fixture's explicit window.show().
  windowsHide: false,
  stdio: 'inherit'
})
const started = Date.now()
let timedOut = false
const timer = setTimeout(() => {
  timedOut = true
  child.kill()
}, 60000)
const exitCode = await new Promise((done) => {
  child.once('error', () => done(1))
  child.once('exit', (code) => done(code ?? 1))
})
clearTimeout(timer)
await writeFile(
  join(report, 'runner-result.json'),
  JSON.stringify({ exitCode, timedOut, elapsedMs: Date.now() - started }, null, 2) + '\n'
)
try {
  const result = JSON.parse(await readFile(join(report, 'result.json'), 'utf8'))
  if (
    timedOut ||
    exitCode !== 0 ||
    result.passed !== true ||
    result.actualForegroundPresentation !== true ||
    result.businessEffectVerified !== false
  )
    throw new Error('presentation_unconfirmed')
  process.stdout.write(`Verified actual workbench presentation: ${join(report, 'result.json')}\n`)
} catch {
  process.stderr.write(`Workbench presentation not verified: ${join(report, 'result.json')}\n`)
  process.exitCode = 1
}
