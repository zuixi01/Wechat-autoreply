import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { createRequire, isBuiltin } from 'node:module'
import { dirname, join, relative } from 'node:path'

const require = createRequire(new URL('../server/package.json', import.meta.url))
const { build } = require('esbuild')
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const check = (condition, code = 'release_windows_device_fixture_invalid') => {
  if (!condition) throw new Error(code)
}
const deadlineMs = 15000
const permissionProgram = `
process.once('message', async (input) => {
  let permissions
  try {
    permissions = await import('data:text/javascript;base64,' + input.module)
    if (input.protect) await permissions.protectPrivateDirectory(input.root)
    else await permissions.verifyPrivatePaths(input.root, input.paths)
    process.stdout.write(JSON.stringify({passed:true,code:'windows_device_permissions_verified'})+'\\n')
  } catch {
    process.stdout.write(JSON.stringify({passed:false,code:'windows_device_permissions_failed'})+'\\n')
    process.exitCode = 1
  } finally {
    permissions?.closePrivatePermissionWorker()
    if (process.connected) process.disconnect()
  }
})
`

/** Real release HTTPS and Windows safeStorage, using isolated synthetic accounts.
 * Operator SQL prepares enrollment only; this is not installed-client acceptance. */
export async function checkReleaseWindowsDeviceConnection({
  root,
  release,
  operator,
  launch,
  environment,
  serverUrl,
  certificatePath
}) {
  check(process.platform === 'win32', 'release_windows_device_platform_invalid')
  const url = new URL(serverUrl)
  check(
    url.protocol === 'https:' &&
      ['127.0.0.1', '[::1]'].includes(url.hostname) &&
      url.port &&
      url.pathname === '/' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      serverUrl === url.origin,
    'release_windows_device_endpoint_invalid'
  )
  // Only runtime necessities and the explicit public test CA reach children.
  const childEnvironment = Object.fromEntries(
    Object.entries(environment).filter(
      ([key, value]) =>
        value !== undefined &&
        /^(PATH|SystemRoot|WINDIR|SystemDrive|ComSpec|PATHEXT|TEMP|TMP|TMPDIR|USERPROFILE|APPDATA|LOCALAPPDATA|HOMEDRIVE|HOMEPATH|HOME)$/i.test(
          key
        )
    )
  )
  const captured = new Map()
  const entry = 'scripts/server-windows-device-fixture.ts'
  const capturePlugin = {
    name: 'capture-windows-device-production-sources',
    setup(builder) {
      builder.onLoad({ filter: /\.ts$/ }, async ({ path }) => {
        const name = relative(root, path).replaceAll('\\', '/')
        check(
          name === entry || /^(src\/(core|main\/services|shared))\/.+\.ts$/.test(name),
          'release_windows_device_source_invalid'
        )
        const bytes = await readFile(path)
        if (captured.has(name))
          check(hash(captured.get(name)) === hash(bytes), 'release_windows_device_source_changed')
        captured.set(name, bytes)
        return { contents: bytes.toString('utf8'), loader: 'ts' }
      })
    }
  }
  const options = {
    absWorkingDir: root,
    bundle: true,
    write: false,
    metafile: true,
    platform: 'node',
    packages: 'external',
    external: ['electron'],
    logLevel: 'silent',
    plugins: [capturePlugin]
  }
  const compiled = await build({ ...options, entryPoints: [entry], format: 'cjs' })
  const permissions = await build({
    ...options,
    entryPoints: ['src/core/persistence/private-backup-directory.ts'],
    format: 'esm'
  })
  for (const output of [compiled, permissions]) {
    check(
      output.warnings.length === 0 && output.outputFiles.length === 1,
      'release_windows_device_build_failed'
    )
    for (const bundle of Object.values(output.metafile.outputs))
      for (const imported of bundle.imports)
        check(
          imported.external &&
            (isBuiltin(imported.path) || ['electron', 'zod'].includes(imported.path)),
          'release_windows_device_dependency_invalid'
        )
  }
  for (const source of [
    entry,
    'src/main/services/agent-registration.ts',
    'src/main/services/device-credential-cipher.ts',
    'src/core/persistence/private-backup-directory.ts',
    'src/core/persistence/windows-private-permissions.ts'
  ])
    check(captured.has(source), 'release_windows_device_required_source_missing')
  const verifySources = async () => {
    for (const [path, bytes] of captured)
      check(
        hash(await readFile(join(root, path))) === hash(bytes),
        'release_windows_device_source_changed'
      )
  }
  await verifySources()
  const fixtureSha256 = hash(compiled.outputFiles[0].contents)
  const electronRequire = createRequire(join(root, 'package.json'))
  const electronPackagePath = electronRequire.resolve('electron/package.json')
  const electronPackageBytes = await readFile(electronPackagePath)
  const expectedElectronVersion = JSON.parse(electronPackageBytes.toString('utf8')).version
  check(
    /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(expectedElectronVersion),
    'release_windows_device_electron_version_invalid'
  )
  const binaryName = (await readFile(join(dirname(electronPackagePath), 'path.txt'), 'utf8')).trim()
  check(binaryName === 'electron.exe', 'release_windows_device_electron_path_invalid')
  const electronPath = join(dirname(electronPackagePath), 'dist', binaryName)
  const directory = join(release, '.local', `windows-device-${randomUUID()}`)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  check(
    (await realpath(directory)).toLowerCase() === directory.toLowerCase(),
    'release_windows_device_directory_invalid'
  )
  const stages = []
  const runtimeResults = []
  const phase = async (name, executable, args, { ipc, payload, ca } = {}) => {
    const started = performance.now()
    const running = launch(executable, args, {
      cwd: release,
      env: { ...childEnvironment, ...(ca ? { NODE_EXTRA_CA_CERTS: certificatePath } : {}) },
      ipc: Boolean(ipc),
      timeout: deadlineMs
    })
    let expired = false
    let termination
    const terminate = () =>
      (termination ??= (async () => {
        if (running.child.exitCode !== null || running.child.signalCode !== null) return
        if (!Number.isInteger(running.child.pid)) {
          running.child.kill('SIGKILL')
          return
        }
        const systemRoot =
          childEnvironment.SystemRoot ?? childEnvironment.SYSTEMROOT ?? 'C:\\Windows'
        const killer = launch(
          join(systemRoot, 'System32/taskkill.exe'),
          ['/PID', String(running.child.pid), '/T', '/F'],
          { cwd: release, env: childEnvironment, timeout: 2000 }
        )
        await killer.result
        if (running.child.exitCode === null && running.child.signalCode === null)
          running.child.kill('SIGKILL')
      })())
    const timer = setTimeout(
      () => {
        expired = true
        void terminate()
      },
      Math.max(1, deadlineMs - (performance.now() - started))
    )
    let sent = !ipc
    if (ipc) {
      try {
        running.child.send(payload, (error) => {
          if (error) sent = false
        })
        sent = true
      } catch {
        sent = false
        void terminate()
      }
    }
    let result
    try {
      result = await running.result
    } finally {
      clearTimeout(timer)
      if (termination) await termination
    }
    const elapsed = performance.now() - started
    const elapsedMs = Math.ceil(elapsed)
    stages.push({
      name,
      elapsedMs,
      deadlineMs,
      exitCode: result.code,
      pid: running.child.pid,
      timedOut: expired || result.failure === 'child_timeout',
      closeConfirmed: running.child.exitCode !== null || running.child.signalCode !== null,
      stderrPresent: result.stderr.trim() !== ''
    })
    if (
      result.code !== 0 ||
      result.failure ||
      expired ||
      elapsed > deadlineMs ||
      result.elapsedMs > deadlineMs ||
      !sent
    ) {
      const error = new Error('release_windows_device_child_failed')
      error.releaseDiagnostic = {
        phase: `windows_device_${name}`,
        exitCode: result.code,
        failure:
          expired || elapsed > deadlineMs || result.elapsedMs > deadlineMs
            ? 'child_elapsed_deadline_exceeded'
            : result.failure,
        elapsedMs,
        stdoutEmpty: result.stdout.trim() === ''
      }
      throw error
    }
    let summary
    try {
      summary = JSON.parse(result.stdout)
    } catch {
      throw new Error('release_windows_device_child_output_invalid')
    }
    check(summary.passed === true, 'release_windows_device_phase_failed')
    return { summary, stage: stages.at(-1) }
  }
  const permissionModule = Buffer.from(permissions.outputFiles[0].contents).toString('base64')
  const verifyPrivate = async (name, paths = [], protect = false) => {
    const { summary } = await phase(
      name,
      process.execPath,
      ['--input-type=module', '-e', permissionProgram],
      { ipc: true, payload: { module: permissionModule, root: directory, paths, protect } }
    )
    check(
      summary.code === 'windows_device_permissions_verified',
      'release_windows_device_permissions_invalid'
    )
  }
  await verifyPrivate('protect_private_directory', [], true)
  const fixturePath = join(directory, 'fixture.cjs')
  await writeFile(fixturePath, compiled.outputFiles[0].contents, { flag: 'wx', mode: 0o600 })
  await mkdir(join(directory, 'user-data'), { mode: 0o700 })
  const suffix = randomUUID().replaceAll('-', '')
  const tenantId = `windows_tls_tenant_${suffix}`
  const cases = ['wechat', 'wework'].map((platform, index) => ({
    code: randomBytes(32).toString('base64url'),
    scope: {
      tenant_id: tenantId,
      employee_id: `windows_tls_employee_${index}_${suffix}`,
      account_id: `windows_tls_account_${index}_${suffix}`,
      platform
    }
  }))
  await operator.query('INSERT INTO autoreply.tenants(id,name) VALUES($1,$2)', [
    tenantId,
    'Synthetic Windows TLS acceptance'
  ])
  for (const item of cases) {
    const scope = item.scope
    await operator.query(
      "INSERT INTO autoreply.employees(tenant_id,id,role) VALUES($1,$2,'employee')",
      [tenantId, scope.employee_id]
    )
    await operator.query(
      'INSERT INTO autoreply.accounts(tenant_id,id,employee_id,platform,paused) VALUES($1,$2,$3,$4,false)',
      [tenantId, scope.account_id, scope.employee_id, scope.platform]
    )
    await operator.query(
      `INSERT INTO autoreply.enrollment_codes(code_hash,tenant_id,account_id,employee_id,expires_at)
      VALUES($1,$2,$3,$4,clock_timestamp()+interval '1 minute')`,
      [hash(item.code), tenantId, scope.account_id, scope.employee_id]
    )
  }
  await writeFile(
    join(directory, 'config.private.json'),
    JSON.stringify({ protocol: 'windows-device-connection-v1', serverUrl, cases }) + '\n',
    { flag: 'wx', mode: 0o600 }
  )
  await verifyPrivate('verify_private_inputs', [
    fixturePath,
    join(directory, 'config.private.json'),
    join(directory, 'user-data')
  ])
  const electronPhase = async (name) => {
    const { summary, stage } = await phase(name, electronPath, [fixturePath, name, directory], {
      ca: true
    })
    await verifyPrivate(`verify_${name}_output`, [join(directory, `${name}.json`)])
    const persisted = JSON.parse(await readFile(join(directory, `${name}.json`), 'utf8'))
    check(
      JSON.stringify(summary) === JSON.stringify(persisted) &&
        summary.protocol === 'windows-device-connection-phase-v1' &&
        summary.phase === name &&
        summary.code === 'windows_device_connection_phase_passed' &&
        summary.fixtureSha256 === fixtureSha256 &&
        summary.pid === stage.pid &&
        Number.isInteger(summary.pid) &&
        summary.pid > 0 &&
        summary.runtime.electron === expectedElectronVersion &&
        /^\d+\.\d+\.\d+$/.test(summary.runtime.node) &&
        summary.runtime.platform === 'win32' &&
        summary.runtime.arch === process.arch &&
        summary.actualElectronSafeStorage === true &&
        summary.localCipherMock === false &&
        summary.windowsCreated === 0 &&
        summary.webContentsCreated === 0 &&
        summary.modelCalls === 0 &&
        summary.clientOperations === 0 &&
        summary.installedDesktopVerified === false &&
        Number.isSafeInteger(summary.requests) &&
        summary.requests > 0,
      'release_windows_device_summary_invalid'
    )
    check(
      !runtimeResults.some((r) => r.pid === summary.pid),
      'release_windows_device_process_reused'
    )
    runtimeResults.push({
      phase: name,
      runtime: summary.runtime,
      pid: summary.pid,
      requests: summary.requests
    })
    return summary
  }
  const producer = await electronPhase('producer')
  check(
    producer.registrationVerified && producer.oneUseEnrollmentVerified && producer.refreshVerified,
    'release_windows_device_registration_invalid'
  )
  const restart = await electronPhase('restart')
  check(
    restart.crossProcessDecryptionVerified &&
      restart.leaseRenewalVerified &&
      restart.leaseConflictRejected &&
      restart.crossScopeRejectedBeforeRequest &&
      restart.contextRejectionsBeforeRequest === 6 &&
      restart.generationNotConfiguredVerified,
    'release_windows_device_restart_invalid'
  )
  await verifyPrivate(
    'verify_private_devices',
    ['device-0.private.json', 'device-1.private.json', 'identities.private.json'].map((name) =>
      join(directory, name)
    )
  )
  const saved = JSON.parse(await readFile(join(directory, 'identities.private.json'), 'utf8'))
  check(
    saved.protocol === 'windows-device-identities-v1' &&
      Array.isArray(saved.identities) &&
      saved.identities.length === 2 &&
      Array.isArray(saved.leaseVersions) &&
      saved.leaseVersions.length === 2 &&
      saved.leaseVersions.every((v) => Number.isSafeInteger(v) && v > 0),
    'release_windows_device_identity_invalid'
  )
  for (const [index, identity] of saved.identities.entries()) {
    const scope = cases[index].scope
    check(
      identity.tenantId === scope.tenant_id &&
        identity.employeeId === scope.employee_id &&
        identity.accountId === scope.account_id &&
        identity.platform === scope.platform &&
        /^[a-f0-9-]{36}$/.test(identity.agentId),
      'release_windows_device_identity_scope_invalid'
    )
  }
  check(
    saved.identities[0].agentId !== saved.identities[1].agentId,
    'release_windows_device_agents_not_distinct'
  )
  const revoked = await operator.query(
    `UPDATE autoreply.agents SET revoked_at=clock_timestamp()
    WHERE tenant_id=$1 AND account_id=$2 AND employee_id=$3 AND id=$4 AND revoked_at IS NULL RETURNING id`,
    [tenantId, cases[0].scope.account_id, cases[0].scope.employee_id, saved.identities[0].agentId]
  )
  check(revoked.rowCount === 1, 'release_windows_device_revoke_failed')
  const denied = await electronPhase('revoked')
  check(
    denied.revokedCredentialRejected &&
      denied.otherEmployeeUnaffected &&
      denied.sameLeaseVersionVerified,
    'release_windows_device_revocation_invalid'
  )
  const state = (
    await operator.query(
      `SELECT
    (SELECT count(*)::int FROM autoreply.agents WHERE tenant_id=$1) AS agents,
    (SELECT count(*)::int FROM autoreply.account_leases WHERE tenant_id=$1) AS leases,
    (SELECT count(*)::int FROM autoreply.agents WHERE tenant_id=$1 AND revoked_at IS NOT NULL) AS revoked,
    (SELECT count(*)::int FROM autoreply.enrollment_codes WHERE tenant_id=$1 AND used_at IS NOT NULL) AS consumed,
    (SELECT count(*)::int FROM autoreply.execution_permits WHERE tenant_id=$1) AS permits,
    (SELECT count(*)::int FROM autoreply.model_call_attempts WHERE tenant_id=$1) AS attempts,
    (SELECT count(*)::int FROM autoreply.generation_publications WHERE tenant_id=$1) AS "generationPublications",
    (SELECT count(*)::int FROM autoreply.published_configurations WHERE tenant_id=$1) AS configurations,
    (SELECT count(*)::int FROM autoreply.evaluation_approvals WHERE tenant_id=$1) AS approvals`,
      [tenantId]
    )
  ).rows[0]
  check(
    state.agents === 2 &&
      state.leases === 2 &&
      state.revoked === 1 &&
      state.consumed === 2 &&
      state.permits === 0 &&
      state.attempts === 0 &&
      state.generationPublications === 0 &&
      state.configurations === 0 &&
      state.approvals === 0,
    'release_windows_device_database_state_invalid'
  )
  await verifySources()
  return {
    employees: 2,
    platforms: ['wechat', 'wework'],
    registrationVerified: true,
    oneUseEnrollmentVerified: true,
    refreshVerified: true,
    crossProcessDecryptionVerified: true,
    leaseRenewalVerified: true,
    leaseConflictRejected: true,
    crossScopeRejectedBeforeRequest: true,
    contextRejectionsBeforeRequest: 6,
    generationNotConfiguredVerified: true,
    revokedCredentialRejected: true,
    otherEmployeeUnaffected: true,
    sameLeaseVersionVerified: true,
    actualElectronSafeStorage: true,
    localCipherMock: false,
    operatorFixtureOnly: true,
    administratorWorkflowVerified: false,
    privatePermissionsVerified: true,
    explicitPublicTestCa: true,
    tlsCertificateValidationEnabled: true,
    currentOperatingSystemUserOnly: true,
    developmentElectronOnly: true,
    installedDesktopVerified: false,
    cleanPcVerified: false,
    realCustomerVerified: false,
    multiComputerVerified: false,
    productionAdmissionVerified: false,
    modelsCalled: false,
    clientOperations: false,
    childProcessesClosed: true,
    additionalSqlPoolsCreated: 0,
    fixtureSha256,
    electronPackageSha256: hash(electronPackageBytes),
    expectedElectronVersion,
    runtimeResults,
    sourceHashes: [...captured].map(([path, bytes]) => ({ path, sha256: hash(bytes) })),
    stages,
    state,
    privateDirectoryId: directory.split(/[\\/]/).at(-1)
  }
}
