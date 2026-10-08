import { build, stop } from 'esbuild'
import electronPath from 'electron'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const assert = (value) => {
  if (!value) throw new Error('device_credential_check_failed')
}
const deadlineMs = 15000
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) =>
    /^(SystemRoot|WINDIR|SystemDrive|ComSpec|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|HOMEDRIVE|HOMEPATH|PATH|PATHEXT)$/i.test(
      key
    )
  )
)
// esbuild's own subprocess and the inherited ACL worker must receive the same
// minimal environment as the explicit children. This runner owns its process.
for (const key of Object.keys(process.env))
  if (!Object.hasOwn(environment, key)) delete process.env[key]
const children = new Set()
const stages = []
let reportDirectory
let phase = 'arguments'
let factorySourceHash
let factoryBundleHash
let dependencySourceHashes
let permissionSourceHash
let fixtureSourceHash
let expectedElectronVersion
let permissionsProtected = false
let passed = false
let failureCode = null

const permissionProgram = `
let permissions
try {
  let encoded = ''
  for await (const chunk of process.stdin) {
    encoded += chunk.toString('utf8')
    if (Buffer.byteLength(encoded) > 1048576) throw new Error('permissions_input_invalid')
  }
  const input = JSON.parse(encoded)
  permissions = await import('data:text/javascript;base64,' + input.module)
  if (input.protect) await permissions.protectPrivateDirectory(input.root)
  else await permissions.verifyPrivatePaths(input.root, input.paths)
  process.stdout.write(JSON.stringify({code:'device_credential_permissions_verified',passed:true,
    pid:process.pid,runtime:{electron:null,node:process.versions.node,arch:process.arch,platform:process.platform}})+'\\n')
} catch {
  process.stdout.write(JSON.stringify({code:'device_credential_permissions_failed',passed:false})+'\\n')
  process.exitCode = 1
} finally { permissions?.closePrivatePermissionWorker() }
`

async function terminateTree(child) {
  if (!children.has(child)) return
  if (process.platform === 'win32' && Number.isInteger(child.pid)) {
    await new Promise((done) => {
      const killer = spawn(
        join(
          environment.SystemRoot ?? environment.SYSTEMROOT ?? 'C:\\Windows',
          'System32/taskkill.exe'
        ),
        ['/PID', String(child.pid), '/T', '/F'],
        { windowsHide: true, shell: false, env: environment, stdio: 'ignore' }
      )
      const timer = setTimeout(() => {
        killer.kill()
        done()
      }, 3000)
      killer.once('error', () => {
        clearTimeout(timer)
        done()
      })
      killer.once('close', () => {
        clearTimeout(timer)
        done()
      })
    })
  }
  if (children.has(child)) child.kill()
}

async function runChild(executable, childArgs, name, input) {
  phase = name
  const start = performance.now()
  const stage = {
    name,
    deadlineMs,
    elapsedMs: null,
    exitCode: null,
    timedOut: false,
    closeConfirmed: false,
    stderrPresent: false
  }
  stages.push(stage)
  let output = ''
  let exceededOutputLimit = false
  const child = spawn(executable, childArgs, {
    cwd: workspace,
    env: environment,
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  children.add(child)
  child.once('spawn', () => {
    stage.pid = child.pid
  })
  let termination
  const terminate = () => (termination ??= terminateTree(child))
  try {
    await new Promise((done) => {
      const timer = setTimeout(
        () => {
          stage.timedOut = true
          void terminate()
        },
        Math.max(1, deadlineMs - (performance.now() - start))
      )
      child.stdout.on('data', (chunk) => {
        if (Buffer.byteLength(output) + chunk.length > 16384) {
          exceededOutputLimit = true
          void terminate()
        } else output += chunk.toString('utf8')
      })
      child.stderr.on('data', () => {
        stage.stderrPresent = true
      })
      child.stdin.on('error', () => {})
      child.once('error', () => {
        stage.spawnFailed = true
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        children.delete(child)
        stage.exitCode = code
        stage.closeConfirmed = true
        stage.elapsedMs = Math.round(performance.now() - start)
        done()
      })
      child.stdin.end(input === undefined ? '' : JSON.stringify(input))
    })
  } finally {
    if (children.has(child)) await terminate()
    if (termination) await termination
  }
  let result
  try {
    result = JSON.parse(output)
  } catch {
    throw new Error('device_credential_child_protocol_invalid')
  }
  if (
    [
      'device_credential_permissions_verified',
      'device_credential_permissions_failed',
      'device_credential_phase_passed',
      'device_credential_fixture_failed',
      'device_credential_safe_storage_unavailable',
      'device_credential_fixture_arguments_invalid'
    ].includes(result?.code)
  )
    stage.code = result.code
  if (
    result?.pid === stage.pid &&
    result?.runtime &&
    typeof result.runtime.node === 'string' &&
    ['win32', 'darwin', 'linux'].includes(result.runtime.platform) &&
    typeof result.runtime.arch === 'string' &&
    (result.runtime.electron === null || typeof result.runtime.electron === 'string')
  )
    stage.runtime = result.runtime
  assert(
    stage.closeConfirmed &&
      stage.elapsedMs <= deadlineMs &&
      !stage.timedOut &&
      !stage.spawnFailed &&
      !exceededOutputLimit &&
      stage.exitCode === 0
  )
  assert(result.passed === true)
  return result
}

async function main() {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(
      'Usage: node scripts/run-device-credential-check.mjs\nWindows current-user development Electron safeStorage check; no application, chat or model calls.\n'
    )
    return
  }
  if (args.length !== 0) throw new Error('device_credential_arguments_invalid')
  if (process.platform !== 'win32') throw new Error('device_credential_platform_unsupported')
  phase = 'prepare_permissions'
  const factorySource = join(workspace, 'src/main/services/device-credential-cipher.ts')
  const permissionSource = join(workspace, 'src/core/persistence/private-backup-directory.ts')
  const fixtureSource = join(workspace, 'scripts/device-credential-electron-fixture.cjs')
  expectedElectronVersion = JSON.parse(
    await readFile(join(workspace, 'node_modules/electron/package.json'), 'utf8')
  ).version
  assert(/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(expectedElectronVersion))
  permissionSourceHash = sha256(await readFile(permissionSource))
  const permissionBuildOptions = {
    absWorkingDir: workspace,
    entryPoints: [permissionSource],
    bundle: true,
    write: false,
    platform: 'node',
    logLevel: 'silent'
  }
  const permissionEsm = (await build({ ...permissionBuildOptions, format: 'esm' })).outputFiles[0]
    .contents
  const permissionCjs = (await build({ ...permissionBuildOptions, format: 'cjs' })).outputFiles[0]
    .contents
  reportDirectory = join(workspace, '.local/reports/device-credential-check', randomUUID())
  await mkdir(reportDirectory, { recursive: true, mode: 0o700 })
  assert((await realpath(reportDirectory)).toLowerCase() === reportDirectory.toLowerCase())
  const permissionInput = {
    module: Buffer.from(permissionEsm).toString('base64'),
    root: reportDirectory,
    paths: []
  }
  const protect = await runChild(
    process.execPath,
    ['--input-type=module', '-e', permissionProgram],
    'protect_private_directory',
    { ...permissionInput, protect: true }
  )
  assert(protect.code === 'device_credential_permissions_verified')
  permissionsProtected = true
  phase = 'bundle'
  factorySourceHash = sha256(await readFile(factorySource))
  const fixture = await readFile(fixtureSource)
  fixtureSourceHash = sha256(fixture)
  const factoryBuild = await build({
    absWorkingDir: workspace,
    entryPoints: [factorySource],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    external: ['electron'],
    metafile: true,
    logLevel: 'silent'
  })
  assert(
    factoryBuild.outputFiles.length === 1 &&
      factorySourceHash === sha256(await readFile(factorySource))
  )
  assert(
    Object.keys(factoryBuild.metafile.inputs).every((file) =>
      /^(src\/main\/services\/device-credential-cipher\.ts|src\/shared\/contracts\/(registration|identity)\.ts|node_modules\/zod\/)/.test(
        file.replaceAll('\\', '/')
      )
    )
  )
  const factoryBundle = factoryBuild.outputFiles[0].contents
  factoryBundleHash = sha256(factoryBundle)
  dependencySourceHashes = Object.fromEntries(
    await Promise.all(
      Object.keys(factoryBuild.metafile.inputs).map(async (file) => [
        file.replaceAll('\\', '/'),
        sha256(await readFile(resolve(workspace, file)))
      ])
    )
  )
  await writeFile(join(reportDirectory, 'factory.cjs'), factoryBundle, { flag: 'wx', mode: 0o600 })
  await writeFile(join(reportDirectory, 'private-directory.cjs'), permissionCjs, {
    flag: 'wx',
    mode: 0o600
  })
  await writeFile(join(reportDirectory, 'fixture.cjs'), fixture, { flag: 'wx', mode: 0o600 })
  await mkdir(join(reportDirectory, 'user-data'), { mode: 0o700 })
  const verify = async (name, paths) => {
    const result = await runChild(
      process.execPath,
      ['--input-type=module', '-e', permissionProgram],
      name,
      { ...permissionInput, paths, protect: false }
    )
    assert(result.code === 'device_credential_permissions_verified')
  }
  await verify(
    'verify_private_inputs',
    ['factory.cjs', 'private-directory.cjs', 'fixture.cjs', 'user-data'].map((p) =>
      join(reportDirectory, p)
    )
  )
  const electronPids = []
  for (const name of ['producer', 'consumer']) {
    const result = await runChild(
      electronPath,
      [join(reportDirectory, 'fixture.cjs'), name, reportDirectory],
      name
    )
    const persisted = JSON.parse(await readFile(join(reportDirectory, `${name}.json`), 'utf8'))
    assert(
      JSON.stringify(result) === JSON.stringify(persisted) &&
        result.protocol === 'device-credential-electron-phase-v1' &&
        result.phase === name &&
        result.code === 'device_credential_phase_passed' &&
        result.factoryHash === factoryBundleHash &&
        result.runtime.electron === expectedElectronVersion &&
        /^\d+\.\d+\.\d+$/.test(result.runtime.node) &&
        result.runtime.platform === 'win32' &&
        result.runtime.arch === process.arch &&
        Number.isInteger(result.pid) &&
        result.pid > 0 &&
        result.pid === stages.at(-1).pid &&
        result.realElectronSafeStorage === true &&
        result.encryptionAvailable === true &&
        result.crossProcessDecryptionVerified === (name === 'consumer') &&
        result.rejectionCount === (name === 'consumer' ? 10 : 0) &&
        result.windowsCreated === 0 &&
        result.webContentsCreated === 0 &&
        result.fixtureNetworkCalls === 0 &&
        result.modelCalls === 0
    )
    electronPids.push(result.pid)
    for (const key of [
      'chatClientsLoaded',
      'mainApplicationLoaded',
      'rendererLoaded',
      'nativeAdapterLoaded',
      'installedApplicationVerified',
      'cleanPcVerified',
      'realCustomerVerified',
      'multiComputerVerified'
    ])
      assert(result[key] === false)
  }
  assert(electronPids.length === 2 && electronPids[0] !== electronPids[1])
  await verify(
    'verify_private_results',
    [
      'encrypted-device.private.json',
      'expected-token-hash.private.json',
      'producer.json',
      'consumer.json'
    ].map((p) => join(reportDirectory, p))
  )
  passed = true
}

try {
  await main()
} catch (error) {
  failureCode = [
    'device_credential_arguments_invalid',
    'device_credential_platform_unsupported',
    'device_credential_child_protocol_invalid'
  ].includes(error?.message)
    ? error.message
    : 'device_credential_check_failed'
  process.exitCode = 1
} finally {
  stop()
  await Promise.all([...children].map(terminateTree))
  if (reportDirectory) {
    const result = {
      protocol: 'device-credential-development-check-v1',
      passed,
      code: passed ? 'device_credential_check_passed' : failureCode,
      phase,
      currentOperatingSystemUserOnly: true,
      isolatedUserData: true,
      developmentElectronOnly: true,
      childEnvironmentSanitized: true,
      factorySourceHash,
      factoryBundleHash,
      dependencySourceHashes,
      permissionSourceHash,
      fixtureSourceHash,
      expectedElectronVersion,
      distinctElectronProcessesVerified: passed,
      plaintextTokenPersisted: false,
      stages,
      childProcessesClosed: children.size === 0,
      crossProcessDecryptionVerified: passed,
      contextMismatchRejections: passed ? 7 : null,
      invalidCiphertextRejections: passed ? 2 : null,
      legacyBareTokenRejected: passed,
      privatePermissionsProtected: permissionsProtected,
      privatePermissionsVerified: passed,
      installedApplicationVerified: false,
      cleanPcVerified: false,
      realCustomerVerified: false,
      multiComputerVerified: false,
      modelCalls: 0,
      chatClientsLoaded: false,
      productionAdmissionVerified: false
    }
    try {
      await writeFile(
        join(reportDirectory, 'result.json'),
        JSON.stringify(result, null, 2) + '\n',
        { flag: 'wx', mode: 0o600 }
      )
      process.stdout.write(
        JSON.stringify({
          passed,
          code: result.code,
          phase,
          reportId: reportDirectory.split(/[\\/]/).at(-1),
          childProcessesClosed: result.childProcessesClosed
        }) + '\n'
      )
    } catch {
      process.exitCode = 1
      process.stdout.write(
        JSON.stringify({ passed: false, code: 'device_credential_report_failed', phase }) + '\n'
      )
    }
  } else if (failureCode) {
    process.stdout.write(JSON.stringify({ passed: false, code: failureCode, phase }) + '\n')
  }
}
