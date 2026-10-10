import { stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform === 'win32') {
  const root = dirname(dirname(fileURLToPath(import.meta.url)))
  const files = [
    'native/ForegroundWindow/Program.cs',
    'native/ForegroundWindow/UnicodeInput.cs',
    'native/ForegroundWindow/ClipboardInput.cs',
    'native/ForegroundWindow/SurfaceProbe.cs',
    'native/ForegroundWindow/ForegroundWindow.csproj'
  ]
  let stale = true
  try {
    const built = (
      await stat(join(root, '.local', 'foreground-native', 'windows-x64', 'ForegroundWindow.exe'))
    ).mtimeMs
    stale = (await Promise.all(files.map((file) => stat(join(root, file))))).some(
      (file) => file.mtimeMs > built
    )
  } catch {
    /* First checkout needs the helper before the compiler pins its hash. */
  }
  if (stale) await import('./publish-foreground.mjs')
}
