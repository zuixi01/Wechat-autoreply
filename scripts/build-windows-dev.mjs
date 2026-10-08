/* eslint-disable @typescript-eslint/explicit-function-return-type -- isolated Node build orchestrator. */
import { spawn } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { cp, mkdir, readFile, stat, writeFile, symlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const arguments_ = process.argv.slice(2)
if (
  arguments_.some((argument) => argument !== '--installer') ||
  new Set(arguments_).size !== arguments_.length
)
  throw new Error('windows_dev_build_arguments_invalid')
const installer = arguments_.includes('--installer')
const id = randomUUID()
const buildRoot = join(workspace, '.local', 'release-build', id)
const sourceWorkspace = join(buildRoot, 'source')
const sourceBuildRoot = join(sourceWorkspace, '.local', 'release-build', id)
const output = `dist/windows-dev-${id}`
const reportRoot = join(workspace, '.local', 'reports', 'windows-dev-build')
const env = {
  ...process.env,
  PATH: `${dirname(process.execPath)};${process.env.PATH || ''}`,
  AUTOREPLY_RELEASE_BUILD_ID: id
}
let phase = 'prepare'
async function command(entry, args = [], project = sourceWorkspace) {
  phase = entry
  await new Promise((done, reject) => {
    const child = spawn(process.execPath, [join(project, entry), ...args], {
      cwd: project,
      windowsHide: true,
      shell: false,
      stdio: 'inherit',
      env
    })
    child.once('error', reject)
    child.once('close', (code) =>
      code === 0 ? done() : reject(new Error('windows_dev_build_failed'))
    )
  })
}
async function run() {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw new Error('platform_unsupported')
  await mkdir(buildRoot, { recursive: true })
  await command(
    'node_modules/tsx/dist/cli.mjs',
    ['scripts/release-source-snapshot.ts', 'create', id],
    workspace
  )
  await symlink(join(workspace, 'node_modules'), join(sourceWorkspace, 'node_modules'), 'junction')
  await mkdir(join(sourceWorkspace, '.local'), { recursive: true })
  await symlink(
    join(workspace, '.local', 'toolchain'),
    join(sourceWorkspace, '.local', 'toolchain'),
    'junction'
  )
  await mkdir(sourceBuildRoot, { recursive: true })
  const lockSha256 = createHash('sha256')
    .update(await readFile(join(sourceWorkspace, 'package-lock.json')))
    .digest('hex')
  await command('scripts/audit-dependencies.mjs')
  // Fail before compilation and dependency copying when installer tools cannot be prepared.
  if (installer) await command('scripts/prepare-installer-tools.mjs')
  await command('node_modules/tsx/dist/cli.mjs', ['scripts/publish-native.ts'])
  await command('scripts/publish-foreground.mjs')
  await cp(
    join(sourceWorkspace, '.local', 'foreground-native', 'windows-x64'),
    join(sourceBuildRoot, 'native', 'foreground'),
    { recursive: true, errorOnExist: true, force: false }
  )
  await cp(
    join(sourceWorkspace, '.local', 'native', 'windows-x64'),
    join(sourceBuildRoot, 'native', 'windows-x64'),
    { recursive: true, errorOnExist: true, force: false }
  )
  await command('node_modules/typescript/bin/tsc', [
    '--noEmit',
    '-p',
    'tsconfig.node.json',
    '--composite',
    'false'
  ])
  await command('node_modules/typescript/bin/tsc', [
    '--noEmit',
    '-p',
    'tsconfig.web.json',
    '--composite',
    'false'
  ])
  await command('node_modules/electron-vite/bin/electron-vite.js', ['build'])
  await cp(join(sourceBuildRoot, 'out'), join(buildRoot, 'out'), {
    recursive: true,
    errorOnExist: true,
    force: false
  })
  await cp(join(sourceBuildRoot, 'native'), join(buildRoot, 'native'), {
    recursive: true,
    errorOnExist: true,
    force: false
  })
  const config = yaml.load(await readFile(join(sourceWorkspace, 'electron-builder.yml'), 'utf8'))
  // One private output tree supplies both the compiled app and its exact helper; shared out is excluded.
  config.files.push('!out/**', {
    from: join(buildRoot, 'out'),
    to: 'out',
    filter: ['**/*']
  })
  config.win.extraResources = [
    {
      from: join(buildRoot, 'native/windows-x64'),
      to: 'native/windows-x64',
      filter: ['**/*']
    },
    {
      from: join(buildRoot, 'native/foreground'),
      to: 'native/foreground',
      filter: ['ForegroundWindow.exe']
    }
  ]
  config.win.signAndEditExecutable = false
  if (installer) {
    config.win.signAndEditExecutable = true
    config.win.signExecutable = false
    config.win.requestedExecutionLevel = 'asInvoker'
    config.nsis = {
      ...config.nsis,
      oneClick: true,
      perMachine: false,
      allowElevation: false,
      packElevateHelper: false,
      runAfterFinish: false,
      deleteAppDataOnUninstall: false
    }
  }
  config.electronDist = join(workspace, 'node_modules/electron/dist')
  config.directories.output = join(workspace, output)
  const configPath = join(buildRoot, 'electron-builder.json')
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n')
  await command('node_modules/electron-builder/cli.js', [
    '--win',
    ...(installer ? ['nsis'] : []),
    '--x64',
    ...(installer ? [] : ['--dir']),
    '--publish',
    'never',
    '--config',
    configPath,
    '--projectDir',
    sourceWorkspace
  ])
  const archive = join(workspace, output, 'win-unpacked', 'resources', 'app.asar')
  phase = 'verify_archive'
  if (
    createHash('sha256')
      .update(await readFile(join(sourceWorkspace, 'package-lock.json')))
      .digest('hex') !== lockSha256
  )
    throw new Error('windows_dev_build_dependencies_changed')
  await command(
    'node_modules/tsx/dist/cli.mjs',
    ['scripts/release-source-snapshot.ts', 'verify', id],
    workspace
  )
  const sourceManifest = JSON.parse(await readFile(join(buildRoot, 'source-manifest.json'), 'utf8'))
  const result = {
    passed: true,
    id,
    output,
    signatureVerified: false,
    packageLockSha256: lockSha256,
    sourceSnapshotSha256: sourceManifest.digest,
    sourceSnapshotFiles: sourceManifest.files.length,
    sourceSnapshotVerified: true,
    dependenciesFrozen: false,
    appAsarSha256: createHash('sha256')
      .update(await readFile(archive))
      .digest('hex'),
    builtAt: new Date().toISOString()
  }
  if (installer) {
    const metadata = JSON.parse(await readFile(join(sourceWorkspace, 'package.json'), 'utf8'))
    const installerFile = `${metadata.name}-${metadata.version}-setup.exe`
    const installerPath = join(workspace, output, installerFile)
    const bytes = await readFile(installerPath)
    if (bytes.length < 100000 || bytes.subarray(0, 2).toString() !== 'MZ')
      throw new Error('windows_dev_build_installer_invalid')
    result.installer = {
      file: `${output}/${installerFile}`,
      bytes: (await stat(installerPath)).size,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      signatureVerified: false,
      installationVerified: false,
      configuredCurrentUserOnly: true,
      configuredAutoRunAfterInstall: false,
      configuredDeleteAppDataOnUninstall: false
    }
  }
  await mkdir(join(reportRoot, id), { recursive: true })
  await writeFile(join(reportRoot, id, 'result.json'), JSON.stringify(result, null, 2) + '\n')
  await writeFile(join(reportRoot, 'latest.json'), JSON.stringify({ id }) + '\n')
  console.log(JSON.stringify(result))
  // Retain two successful releases and recent diagnostics. Cleanup failures
  // cannot invalidate a release whose archive/source checks already passed.
  try {
    await command(
      'node_modules/tsx/dist/cli.mjs',
      ['scripts/clean-artifacts.ts', '--apply'],
      workspace
    )
  } catch {
    console.warn(
      'Historical build cleanup incomplete; run npm run clean:artifacts -- --apply later.'
    )
  }
}
run().catch(async (error) => {
  const code =
    error && typeof error.code === 'string' && /^[A-Z_]+$/.test(error.code)
      ? error.code
      : error instanceof Error && /^windows_dev_build_[a-z_]+$/.test(error.message)
        ? error.message
        : 'windows_dev_build_failed'
  await mkdir(join(reportRoot, id), { recursive: true })
  await writeFile(
    join(reportRoot, id, 'result.json'),
    JSON.stringify(
      { passed: false, id, phase, code, failedAt: new Date().toISOString() },
      null,
      2
    ) + '\n'
  )
  console.error(`windows_dev_build_failed (${phase}, ${code}); isolated files retained`)
  process.exitCode = 1
})
