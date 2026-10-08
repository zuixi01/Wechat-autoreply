import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, lstat, rename, realpath, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  nativeFileHash,
  nativeInventory,
  verifyNativePackage
} from '../src/core/adapters/native-package'
import { WindowsBridge, nativeChildEnvironment } from '../src/core/adapters/windows-bridge'
import { NativePackageSchema } from '../src/shared/contracts/native-package'

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const taskId = randomUUID()
const base = join(workspace, '.local', 'native')
const staging = join(base, 'staging', taskId)
const destination = join(base, 'windows-x64')
const report = join(workspace, '.local', 'reports', 'native-publish', taskId)
let phase = 'prepare'

async function run(): Promise<void> {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw new Error('Windows x64 required')
  await mkdir(staging, { recursive: true })
  if (
    (await realpath(base)).toLowerCase() !== base.toLowerCase() ||
    (await realpath(staging)).toLowerCase() !== staging.toLowerCase()
  )
    throw new Error('native_publish_path_invalid')
  let dotnet = join(workspace, '.local', 'toolchain', 'dotnet', 'dotnet.exe')
  try {
    await access(dotnet)
  } catch {
    dotnet = 'dotnet'
  }
  phase = 'dotnet-publish'
  await new Promise<void>((done, reject) => {
    const child = spawn(
      dotnet,
      [
        'publish',
        'native/WindowsAdapter/WindowsAdapter.csproj',
        '--configuration',
        'Release',
        '--runtime',
        'win-x64',
        '--self-contained',
        'true',
        '--output',
        staging,
        '--nologo',
        '-p:DebugType=None',
        '-p:DebugSymbols=false',
        '-p:PublishSingleFile=false',
        '-p:PublishTrimmed=false',
        '-p:RestoreSources=https://api.nuget.org/v3/index.json'
      ],
      {
        cwd: workspace,
        windowsHide: true,
        shell: false,
        stdio: 'inherit',
        env: nativeChildEnvironment(process.env)
      }
    )
    child.once('error', reject)
    child.once('close', (code) =>
      code === 0 ? done() : reject(new Error('native_publish_failed'))
    )
  })
  const files = []
  phase = 'inventory'
  for (const path of await nativeInventory(staging)) {
    const absolute = join(staging, ...path.split('/'))
    files.push({
      path,
      bytes: (await lstat(absolute)).size,
      sha256: await nativeFileHash(absolute)
    })
  }
  const manifest = NativePackageSchema.parse({
    formatVersion: 1,
    adapterVersion: '0.4.0',
    protocolVersion: 1,
    runtime: 'win-x64',
    deployment: 'self-contained',
    entrypoint: 'WindowsAdapter.exe',
    files
  })
  const bytes = JSON.stringify(manifest, null, 2) + '\n'
  const manifestSha256 = createHash('sha256').update(bytes).digest('hex')
  await writeFile(join(staging, 'native-manifest.json'), bytes)
  phase = 'verify'
  await verifyNativePackage(staging, manifestSha256)
  // info does not enumerate windows; all capability claims stay unverified.
  const bridge = await WindowsBridge.fromPackage(staging, manifestSha256)
  let info
  phase = 'info-and-close'
  try {
    info = await bridge.info()
  } finally {
    await bridge.stop()
  }
  phase = 'promote'
  try {
    const current = await lstat(destination)
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      (await realpath(destination)).toLowerCase() !== destination.toLowerCase()
    )
      throw new Error('native_publish_path_invalid')
    await rename(destination, join(base, `previous-${taskId}`))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await rename(staging, destination)
  await verifyNativePackage(destination, manifestSha256)
  await mkdir(report, { recursive: true })
  await writeFile(
    join(report, 'result.json'),
    JSON.stringify(
      {
        status: 'passed',
        taskId,
        manifestSha256,
        files: files.length,
        bytes: files.reduce((sum, file) => sum + file.bytes, 0),
        info,
        commandsExecuted: ['info'],
        childExitConfirmed: true,
        chatWindowsRead: false,
        messagesSent: 0,
        publishedAt: new Date().toISOString()
      },
      null,
      2
    ) + '\n'
  )
  console.log(JSON.stringify({ status: 'passed', report, files: files.length, manifestSha256 }))
}
run().catch(async (error) => {
  const code =
    error instanceof Error && /^native_[a-z_]+$/.test(error.message)
      ? error.message
      : 'native_publish_failed'
  await mkdir(report, { recursive: true })
  await writeFile(
    join(report, 'result.json'),
    JSON.stringify(
      { status: 'failed', taskId, phase, code, messagesSent: 0, chatWindowsRead: false },
      null,
      2
    ) + '\n'
  )
  console.error(`native_publish_failed:${phase}:${code}; staging retained for diagnosis`)
  process.exitCode = 1
})
