import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { access } from 'node:fs/promises'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
if (process.platform !== 'win32') throw new Error('foreground_native_requires_windows')
let dotnet = join(root, '.local', 'toolchain', 'dotnet', 'dotnet.exe')
try {
  await access(dotnet)
} catch {
  dotnet = 'dotnet'
}
const child = spawn(
  dotnet,
  [
    'publish',
    join(root, 'native', 'ForegroundWindow', 'ForegroundWindow.csproj'),
    '-c',
    'Release',
    '-r',
    'win-x64',
    '--self-contained',
    'true',
    '-o',
    join(root, '.local', 'foreground-native', 'windows-x64')
  ],
  { cwd: root, windowsHide: true, stdio: 'inherit', shell: false }
)
const code = await new Promise((resolve, reject) => {
  child.once('error', reject)
  child.once('exit', resolve)
})
if (code !== 0) throw new Error('foreground_native_build_failed')
