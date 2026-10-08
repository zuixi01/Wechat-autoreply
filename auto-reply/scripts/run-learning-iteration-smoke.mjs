import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const report = join(root, '.local/reports/learning-iteration', randomUUID())
await mkdir(report, { recursive: true })
const fixture = join(report, 'fixture.cjs')
await build({
  entryPoints: [join(root, 'scripts/learning-iteration-desktop-fixture.ts')],
  outfile: fixture,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  logLevel: 'silent'
})
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electronPath, [fixture, report], {
  cwd: root,
  env,
  windowsHide: true,
  stdio: 'inherit'
})
const timer = setTimeout(() => child.kill(), 85000)
process.exitCode = await new Promise((done) => {
  child.once('error', () => done(1))
  child.once('exit', (code) => done(code ?? 1))
})
clearTimeout(timer)
