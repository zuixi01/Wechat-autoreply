import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const environment = { ...process.env }
delete environment.ELECTRON_RUN_AS_NODE
const child = spawn(electronPath, [join(root, 'scripts', 'learning-smoke.cjs')], {
  cwd: root,
  env: environment,
  windowsHide: true,
  stdio: 'inherit'
})
const timeout = setTimeout(() => child.kill(), 85000)
process.exitCode = await new Promise((resolve) => {
  child.once('error', () => resolve(1))
  child.once('exit', (code) => resolve(code ?? 1))
})
clearTimeout(timeout)
if (!process.exitCode) await import('./run-learning-restart-smoke.mjs')
if (!process.exitCode) await import('./run-learning-publication-smoke.mjs')
if (!process.exitCode) await import('./run-learning-iteration-smoke.mjs')
