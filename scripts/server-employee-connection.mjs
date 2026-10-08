import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'

const require = createRequire(new URL('../server/package.json', import.meta.url))
const { build } = require('esbuild')
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** Isolated acceptance data only. Local secret storage is a test double; HTTP is real. */
export async function checkReleaseEmployeeConnection({
  root,
  release,
  operator,
  launch,
  environment,
  serverUrl,
  certificatePath,
  preparedCases
}) {
  const suffix = randomUUID().replaceAll('-', ''),
    tenantId = `tls_company_${suffix}`
  const cases =
    preparedCases ??
    ['wechat', 'wework'].map((platform, index) => ({
      code: randomBytes(32).toString('base64url'),
      scope: {
        tenant_id: tenantId,
        employee_id: `tls_employee_${index}_${suffix}`,
        account_id: `tls_account_${index}_${suffix}`,
        platform
      }
    }))
  const scopeTenant = preparedCases ? cases[0].scope.tenant_id : tenantId
  if (
    preparedCases &&
    (cases.length !== 2 || cases.some((item) => item.scope.tenant_id !== scopeTenant))
  )
    throw new Error('release_employee_fixture_scope_invalid')
  if (!preparedCases) {
    await operator.query('INSERT INTO autoreply.tenants(id,name) VALUES($1,$2)', [
      tenantId,
      'Synthetic TLS acceptance'
    ])
    for (const item of cases) {
      const scope = item.scope
      await operator.query(
        "INSERT INTO autoreply.employees(tenant_id,id,role) VALUES($1,$2,'employee')",
        [tenantId, scope.employee_id]
      )
      // Fixture operator prepares active accounts; this does not exercise admin publication/resume.
      // No publication or generation configuration is installed, so no automatic sending authority exists.
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
  }
  const entry = 'scripts/server-employee-connection-fixture.ts'
  const captured = new Map()
  const compiled = await build({
    absWorkingDir: root,
    entryPoints: [entry],
    bundle: true,
    write: false,
    metafile: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    packages: 'external',
    logLevel: 'silent',
    plugins: [
      {
        name: 'capture-employee-fixture-sources',
        setup(builder) {
          builder.onLoad({ filter: /\.ts$/ }, async ({ path }) => {
            const name = relative(root, path).replaceAll('\\', '/')
            if (!(name === entry || /^(src\/(core|main\/services|shared))\/.+\.ts$/.test(name)))
              throw new Error('release_employee_fixture_module_invalid')
            const bytes = await readFile(path)
            captured.set(name, bytes)
            return { contents: bytes.toString('utf8'), loader: 'ts' }
          })
        }
      }
    ]
  })
  if (compiled.warnings.length || compiled.outputFiles.length !== 1)
    throw new Error('release_employee_fixture_build_failed')
  for (const output of Object.values(compiled.metafile.outputs))
    for (const dependency of output.imports)
      if (
        dependency.external &&
        !['node:crypto', 'node:assert/strict', 'zod'].includes(dependency.path)
      )
        throw new Error('release_employee_fixture_dependency_invalid')
  for (const [path, bytes] of captured)
    if (hash(await readFile(join(root, path))) !== hash(bytes))
      throw new Error('release_employee_fixture_source_changed')
  const fixturePath = join(
    release,
    '.local',
    'test-tls',
    preparedCases ? 'employee-paused-connection.mjs' : 'employee-connection.mjs'
  )
  await mkdir(dirname(fixturePath), { recursive: true })
  await writeFile(fixturePath, compiled.outputFiles[0].contents, { flag: 'wx' })
  const fixture = launch(process.execPath, [fixturePath], {
    cwd: release,
    ipc: true,
    timeout: 10000,
    env: {
      ...environment,
      NODE_EXTRA_CA_CERTS: certificatePath,
      AUTOREPLY_EMPLOYEE_TLS_FIXTURE: JSON.stringify({
        serverUrl,
        cases,
        paused: Boolean(preparedCases)
      })
    }
  })
  let revokeStarted = false,
    revokeSucceeded = false
  const revocations = []
  fixture.child.on('message', (message) => {
    const operation = (async () => {
      if (
        revokeStarted ||
        !message ||
        message.kind !== 'revoke' ||
        typeof message.agentId !== 'string' ||
        !/^[a-f0-9-]{36}$/.test(message.agentId)
      )
        throw new Error('release_employee_fixture_message_invalid')
      revokeStarted = true
      const changed = await operator.query(
        `UPDATE autoreply.agents SET revoked_at=clock_timestamp()
        WHERE tenant_id=$1 AND account_id=$2 AND employee_id=$3 AND id=$4 AND revoked_at IS NULL RETURNING id`,
        [scopeTenant, cases[0].scope.account_id, cases[0].scope.employee_id, message.agentId]
      )
      if (changed.rowCount !== 1) throw new Error('release_employee_fixture_revoke_failed')
      revokeSucceeded = true
      fixture.child.send('revoked')
    })().then(
      () => true,
      () => {
        if (fixture.child.connected) fixture.child.send('revoke_failed')
        return false
      }
    )
    revocations.push(operation)
  })
  const result = await fixture.result
  const revocationResults = await Promise.all(revocations)
  if (
    result.code !== 0 ||
    result.failure ||
    (!preparedCases && !revokeSucceeded) ||
    !revocationResults.every(Boolean)
  )
    throw new Error('release_employee_tls_connection_failed')
  const summary = JSON.parse(result.stdout)
  if (
    summary.employees !== 2 ||
    !summary.registrationVerified ||
    (preparedCases
      ? !summary.pausedAccountsBlocked || summary.leaseGranted !== false
      : !summary.revokedCredentialRejected ||
        !summary.otherEmployeeUnaffected ||
        !summary.generationNotConfiguredVerified) ||
    !summary.localCipherMock ||
    summary.installedDesktopVerified !== false
  )
    throw new Error('release_employee_tls_summary_invalid')
  const state = (
    await operator.query(
      `SELECT
    (SELECT count(*)::integer FROM autoreply.agents WHERE tenant_id=$1) AS agents,
    (SELECT count(*)::integer FROM autoreply.account_leases WHERE tenant_id=$1) AS leases,
    (SELECT count(*)::integer FROM autoreply.agents WHERE tenant_id=$1 AND revoked_at IS NOT NULL) AS revoked,
    (SELECT count(*)::integer FROM autoreply.enrollment_codes WHERE tenant_id=$1 AND used_at IS NOT NULL) AS consumed,
    (SELECT count(*)::integer FROM autoreply.execution_permits WHERE tenant_id=$1) AS permits,
    (SELECT count(*)::integer FROM autoreply.model_call_attempts WHERE tenant_id=$1) AS attempts`,
      [scopeTenant]
    )
  ).rows[0]
  if (
    state.agents !== 2 ||
    state.leases !== (preparedCases ? 0 : 2) ||
    state.revoked !== (preparedCases ? 0 : 1) ||
    state.consumed !== 2 ||
    state.permits !== 0 ||
    state.attempts !== 0
  )
    throw new Error('release_employee_tls_database_state_invalid')
  for (const [path, bytes] of captured)
    if (hash(await readFile(join(root, path))) !== hash(bytes))
      throw new Error('release_employee_fixture_source_changed')
  return {
    ...summary,
    state,
    fixtureSha256: hash(compiled.outputFiles[0].contents),
    operatorFixtureOnly: !preparedCases,
    administratorProvisionEnrollmentVerified: Boolean(preparedCases),
    administratorWorkflowVerified: false,
    sourceHashes: [...captured].map(([path, bytes]) => ({ path, sha256: hash(bytes) }))
  }
}
