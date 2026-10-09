import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
if (process.platform !== 'win32' || process.arch !== 'x64')
  throw new Error('foreground_input_fixture_requires_windows_x64')
let dotnet = join(root, '.local', 'toolchain', 'dotnet', 'dotnet.exe')
try {
  await access(dotnet)
} catch {
  dotnet = 'dotnet'
}
const child = spawn(
  dotnet,
  [
    'run',
    '--project',
    'tests/native/ForegroundInputFixture/ForegroundInputFixture.csproj',
    '--configuration',
    'Release'
  ],
  {
    cwd: root,
    windowsHide: true,
    shell: false,
    stdio: 'inherit'
  }
)
const timer = setTimeout(() => child.kill(), 60000)
try {
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
  if (code !== 0) throw new Error('foreground_input_fixture_failed')
} finally {
  clearTimeout(timer)
}

// A GDI bitmap can appear valid inside its creating process yet disappear when
// that process exits. Check restoration from a separate, read-only process.
const verifier = spawn(
  dotnet,
  [
    join(
      root,
      'tests/native/ForegroundInputFixture/bin/Release/net10.0-windows/ForegroundInputFixture.dll'
    ),
    '--verify-restored-bitmap'
  ],
  { cwd: root, windowsHide: true, shell: false, stdio: 'inherit' }
)
const verificationTimer = setTimeout(() => verifier.kill(), 10000)
try {
  const code = await new Promise((resolve, reject) => {
    verifier.once('error', reject)
    verifier.once('exit', resolve)
  })
  if (code !== 0) throw new Error('foreground_clipboard_restore_fixture_failed')
} finally {
  clearTimeout(verificationTimer)
}
