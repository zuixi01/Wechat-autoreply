import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { request as secureRequest } from 'node:https'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { checkReleaseCalibrationDeclaration } from './server-calibration-declaration.mjs'
import { checkReleaseHoldout } from './server-holdout-release.mjs'

function check(condition, code) {
  if (!condition) throw new Error(code)
}
async function bounded(operation, timeout, code) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await operation()) return
    await new Promise((accept) => setTimeout(accept, 100))
  }
  throw new Error(code)
}
async function freePort() {
  const server = createServer()
  await new Promise((accept, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', accept)
  })
  const port = server.address().port
  await new Promise((accept, reject) => server.close((error) => (error ? reject(error) : accept())))
  return port
}
function request(port, certificate, input, { token, origin } = {}) {
  return new Promise((accept, reject) => {
    const bytes = Buffer.from(JSON.stringify(input))
    const outgoing = secureRequest(
      `https://127.0.0.1:${port}/v1/admin/operations`,
      {
        method: 'POST',
        ca: certificate,
        agent: false,
        signal: AbortSignal.timeout(700),
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': bytes.length,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(origin ? { Origin: origin } : {})
        }
      },
      (response) => {
        const chunks = []
        let size = 0
        response.on('data', (chunk) => {
          size += chunk.length
          if (size > 32768) {
            response.destroy(new Error('release_admin_response_limit'))
            return
          }
          chunks.push(chunk)
        })
        response.once('error', reject)
        response.once('end', () => {
          try {
            accept({
              status: response.statusCode,
              body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
            })
          } catch {
            reject(new Error('release_admin_response_invalid'))
          }
        })
      }
    )
    outgoing.once('error', reject)
    outgoing.end(bytes)
  })
}

/** Runs the packaged administrator entrypoints. Credentials and captured output
 * remain private; only explicit non-secret proof fields reach recorded/summary.
 * preparedCases must be passed directly to the employee check, never a report. */
export async function checkReleaseAdminDeployment({
  root,
  release,
  operator,
  launch,
  environment,
  databaseUrl,
  certificatePath,
  keyPath,
  recorded
}) {
  let running
  try {
    check(typeof root === 'string' && typeof release === 'string', 'release_admin_paths_invalid')
    const suffix = randomUUID().replaceAll('-', '')
    const tenant = `release_admin_tenant_${suffix}`
    const actor = `release_admin_actor_${suffix}`
    const login = `release_admin_ok_${suffix}`
    const password = randomBytes(32).toString('hex')
    const token = randomBytes(32).toString('base64url')
    const adminEntry = join(release, 'server', 'scripts', 'admin.js')
    const serverEntry = join(release, 'server', 'scripts', 'admin-server.js')
    const rejected = [
      { phase: 'admin_application_mixed_login', prefix: 'ra_app', other: 'autoreply_app' },
      {
        phase: 'admin_worker_mixed_login',
        prefix: 'ra_worker',
        other: 'autoreply_learning_worker'
      },
      {
        phase: 'admin_reviewer_mixed_login',
        prefix: 'ra_reviewer',
        other: 'autoreply_jev_reviewer'
      },
      { phase: 'admin_non_inheriting_login', prefix: 'ra_noinherit', noInherit: true },
      { phase: 'admin_createrole_login', prefix: 'ra_createrole', createRole: true }
    ].map((fixture) => ({ ...fixture, login: `${fixture.prefix}_${suffix}` }))
    await operator.query('INSERT INTO autoreply.tenants(id,name) VALUES($1,$2)', [
      tenant,
      'Synthetic release administrator tenant'
    ])
    await operator.query(
      "INSERT INTO autoreply.employees(tenant_id,id,role) VALUES($1,$2,'admin')",
      [tenant, actor]
    )
    for (const fixture of [{ login }, ...rejected]) {
      check(/^[a-z][a-z0-9_]{0,62}$/.test(fixture.login), 'release_admin_login_name_invalid')
      await operator.query(
        `CREATE ROLE ${fixture.login} LOGIN ${fixture.noInherit ? 'NOINHERIT' : 'INHERIT'} NOSUPERUSER NOBYPASSRLS NOCREATEDB ${fixture.createRole ? 'CREATEROLE' : 'NOCREATEROLE'} NOREPLICATION PASSWORD '${password}'`
      )
      await operator.query(
        `GRANT autoreply_admin TO ${fixture.login}${fixture.noInherit ? ' WITH INHERIT FALSE' : ''}`
      )
      if (fixture.other) await operator.query(`GRANT ${fixture.other} TO ${fixture.login}`)
      await operator.query(
        'INSERT INTO autoreply.admin_database_principals(login_name,tenant_id,employee_id) VALUES($1,$2,$3)',
        [fixture.login, tenant, actor]
      )
    }
    const urlFor = (name) => {
      const url = new URL(databaseUrl)
      url.username = name
      url.password = password
      return url.href
    }
    const backendsClosed = (name) =>
      bounded(
        async () =>
          (
            await operator.query(
              'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND usename=$1',
              [name]
            )
          ).rows[0].n === 0,
        3000,
        'release_admin_connections_not_closed'
      )
    const role = (
      await operator.query(
        `SELECT rolcanlogin,rolinherit,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication,
          pg_has_role(rolname,'autoreply_admin','USAGE') AS admin_usage,
          EXISTS(SELECT 1 FROM pg_roles p WHERE p.rolname IN ('autoreply_app','autoreply_learning_worker','autoreply_jev_reviewer') AND pg_has_role(r.rolname,p.oid,'MEMBER')) AS mixed
        FROM pg_roles r WHERE rolname=$1`,
        [login]
      )
    ).rows[0]
    check(
      role.rolcanlogin &&
        role.rolinherit &&
        role.admin_usage &&
        !role.mixed &&
        !role.rolsuper &&
        !role.rolbypassrls &&
        !role.rolcreatedb &&
        !role.rolcreaterole &&
        !role.rolreplication,
      'release_admin_fixture_invalid'
    )
    recorded('actual_dedicated_admin_login_fixture', {
      ordinaryLogin: true,
      tenantMapped: true,
      rejectionFixtures: rejected.length
    })
    const cli = async (parameters) => {
      const result = await launch(process.execPath, [adminEntry, ...parameters], {
        cwd: release,
        env: { ...environment, ADMIN_DATABASE_URL: urlFor(login) },
        timeout: 6000
      }).result
      check(
        result.code === 0 && !result.failure && result.stderr.trim() === '',
        'release_admin_cli_failed'
      )
      await backendsClosed(login)
      try {
        return JSON.parse(result.stdout)
      } catch {
        throw new Error('release_admin_cli_output_invalid')
      }
    }
    const preparedCases = []
    for (const platform of ['wechat', 'wework']) {
      const scope = {
        tenant_id: tenant,
        employee_id: `release_${platform}_employee_${suffix}`,
        account_id: `release_${platform}_account_${suffix}`,
        platform
      }
      await cli([
        'provision',
        '--tenant',
        tenant,
        '--employee',
        scope.employee_id,
        '--account',
        scope.account_id,
        '--platform',
        platform
      ])
      const enrollment = await cli(['enroll', '--tenant', tenant, '--account', scope.account_id])
      check(
        /^[A-Za-z0-9_-]{43}$/.test(enrollment.enrollmentCode) && enrollment.validForSeconds === 600,
        'release_admin_enrollment_invalid'
      )
      const code = enrollment.enrollmentCode
      const persisted = (
        await operator.query(
          `SELECT a.employee_id,a.platform,a.enabled,a.paused,e.used_at IS NULL AS unused,
            e.expires_at>clock_timestamp() AS valid FROM autoreply.accounts a
          JOIN autoreply.enrollment_codes e ON(e.tenant_id,e.account_id,e.employee_id)=(a.tenant_id,a.id,a.employee_id)
          WHERE a.tenant_id=$1 AND a.id=$2 AND e.code_hash=$3`,
          [tenant, scope.account_id, createHash('sha256').update(code).digest('hex')]
        )
      ).rows[0]
      check(
        persisted?.employee_id === scope.employee_id &&
          persisted.platform === platform &&
          persisted.enabled === true &&
          persisted.paused === true &&
          persisted.unused &&
          persisted.valid,
        'release_admin_provision_persistence_failed'
      )
      preparedCases.push({ code, scope })
      recorded(`actual_admin_cli_${platform}_provision_enroll`, {
        paused: true,
        unusedEnrollmentStored: true,
        cliBackends: 0,
        enrollmentSecretReported: false
      })
    }
    const audit = (
      await operator.query(
        'SELECT id,actor_id,kind,account_id,details_json FROM autoreply.audit_events WHERE tenant_id=$1 ORDER BY id',
        [tenant]
      )
    ).rows
    check(
      audit.length === 4 &&
        audit.every((row) => row.actor_id === actor) &&
        preparedCases.every(({ scope }) =>
          ['account_provisioned', 'enrollment_created'].every(
            (kind) =>
              audit.filter((row) => row.account_id === scope.account_id && row.kind === kind)
                .length === 1
          )
        ),
      'release_admin_cli_audit_failed'
    )
    recorded('actual_admin_cli_committed_audit', { accounts: 2, auditEvents: 4 })
    await checkReleaseCalibrationDeclaration({
      root,
      release,
      operator,
      launch,
      environment,
      connection: urlFor(login),
      tenant,
      account: preparedCases[0].scope.account_id,
      login,
      recorded
    })
    await checkReleaseHoldout({
      root,
      release,
      operator,
      launch,
      environment,
      connection: urlFor(login),
      tenant,
      account: preparedCases[0].scope.account_id,
      login,
      recorded
    })
    // Fresh second fixture account and dataset: do not edit or reuse sealed
    // evidence from the complete-usage run. Keep the full original workload.
    await checkReleaseHoldout({
      root,
      release,
      operator,
      launch,
      environment,
      connection: urlFor(login),
      tenant,
      account: preparedCases[1].scope.account_id,
      login,
      recorded,
      omitHoldoutUsage: true
    })
    const noOperations = async () => {
      const row = (
        await operator.query(
          `SELECT (SELECT count(*)::int FROM autoreply.execution_permits WHERE tenant_id=$1) AS permits,
            (SELECT count(*)::int FROM autoreply.model_call_attempts WHERE tenant_id=$1) AS models,
            (SELECT count(*)::int FROM autoreply.generation_tasks WHERE tenant_id=$1) AS tasks`,
          [tenant]
        )
      ).rows[0]
      check(
        row.permits === 0 && row.models === 0 && row.tasks === 0,
        'release_admin_operation_detected'
      )
    }
    await noOperations()
    const port = await freePort()
    const certificate = await readFile(certificatePath)
    const serverEnvironment = {
      ...environment,
      ADMIN_DATABASE_URL: urlFor(login),
      ADMIN_TENANT_ID: tenant,
      ADMIN_GATEWAY_TOKEN: token,
      ADMIN_BIND_HOST: '127.0.0.1',
      ADMIN_PORT: String(port),
      DEV_ALLOW_LOCAL_HTTP: '0',
      ADMIN_TLS_CERT_PATH: certificatePath,
      ADMIN_TLS_KEY_PATH: keyPath
    }
    // Dispatches the entrypoint's installed signal handler on Windows. This is
    // intentionally the same bootstrap used for the release employee service.
    const bootstrap =
      "import {pathToFileURL} from 'node:url';process.on('message',m=>{if(m==='shutdown'){process.emit('SIGTERM');process.disconnect()}});await import(pathToFileURL(process.argv[1]).href)"
    running = launch(process.execPath, ['--input-type=module', '-e', bootstrap, serverEntry], {
      cwd: release,
      env: serverEnvironment,
      ipc: true,
      timeout: 25000
    })
    await bounded(
      async () => {
        check(running.child.exitCode === null, 'release_admin_gateway_exited_early')
        try {
          const identity = await request(port, certificate, { operation: 'identity' }, { token })
          return (
            identity.status === 200 &&
            identity.body.result?.tenantId === tenant &&
            identity.body.result.actorId === actor
          )
        } catch {
          return false
        }
      },
      10000,
      'release_admin_gateway_identity_failed'
    )
    recorded('actual_admin_tls_identity', { explicitFixtureCa: true, mappedActorVerified: true })
    const runtime = await request(
      port,
      certificate,
      { operation: 'runtime-status', input: {} },
      { token }
    )
    check(
      runtime.status === 200 &&
        runtime.body.result?.totalDevices === 0 &&
        runtime.body.result.revokedDevices === 0 &&
        runtime.body.result.rows?.length === 0 &&
        runtime.body.result.nextCursor === null,
      'release_admin_runtime_status_failed'
    )
    recorded('actual_admin_tls_runtime_status', { totalDevices: 0, rows: 0 })
    for (const [name, options, status] of [
      ['missing_bearer', {}, 401],
      ['origin', { token, origin: 'https://untrusted.invalid' }, 403],
      ['wrong_token', { token: randomBytes(32).toString('base64url') }, 401]
    ]) {
      const response = await request(port, certificate, { operation: 'identity' }, options)
      check(response.status === status, 'release_admin_gateway_authentication_failed')
      recorded(`actual_admin_tls_${name}_rejected`, { status })
    }
    const requestId = randomUUID()
    const paused = await request(
      port,
      certificate,
      { operation: 'request-pause-all', requestId },
      { token }
    )
    const result = paused.body.result
    check(
      paused.status === 200 &&
        result?.requestId === requestId &&
        result.actorId === actor &&
        result.accountCount === 2 &&
        result.activeAccounts === 2 &&
        result.outsideAccounts === 0 &&
        result.targetCount === 0 &&
        result.reportedTargets === 0 &&
        result.physicalStopVerified === false &&
        result.canAuthorizeSend === false,
      'release_admin_gateway_pause_failed'
    )
    const persistedPause = (
      await operator.query(
        `SELECT
          (SELECT count(*)::int FROM autoreply.accounts WHERE tenant_id=$1 AND paused) AS paused,
          (SELECT count(*)::int FROM autoreply.tenant_pause_batches WHERE tenant_id=$1 AND id=$2 AND actor_id=$3) AS batches,
          (SELECT count(*)::int FROM autoreply.tenant_pause_accounts WHERE tenant_id=$1 AND batch_id=$2) AS accounts,
          (SELECT count(*)::int FROM autoreply.account_pause_heads WHERE tenant_id=$1) AS heads,
          (SELECT count(*)::int FROM autoreply.audit_events WHERE tenant_id=$1 AND actor_id=$3 AND kind='account_pause_requested') AS account_audits,
          (SELECT count(*)::int FROM autoreply.audit_events WHERE tenant_id=$1 AND actor_id=$3 AND kind='tenant_pause_requested') AS tenant_audits`,
        [tenant, requestId, actor]
      )
    ).rows[0]
    check(
      persistedPause.paused === 2 &&
        persistedPause.batches === 1 &&
        persistedPause.accounts === 2 &&
        persistedPause.heads === 2 &&
        persistedPause.account_audits === 2 &&
        persistedPause.tenant_audits === 1,
      'release_admin_pause_persistence_failed'
    )
    const retainedAudit = (
      await operator.query(
        'SELECT id,actor_id,kind,account_id,details_json FROM autoreply.audit_events WHERE tenant_id=$1 AND id=ANY($2::text[]) ORDER BY id',
        [tenant, audit.map((row) => row.id)]
      )
    ).rows
    check(JSON.stringify(retainedAudit) === JSON.stringify(audit), 'release_admin_audit_changed')
    await noOperations()
    recorded('actual_admin_tls_pause_all_committed', {
      accountCount: 2,
      pausedAccounts: 2,
      pauseHeads: 2,
      pauseAuditEvents: 3,
      earlierAuditPreserved: true,
      modelAttempts: 0,
      executionPermits: 0,
      physicalStopVerified: false,
      canAuthorizeSend: false
    })
    running.child.send('shutdown')
    const stopped = await running.result
    check(stopped.code === 0 && !stopped.failure, 'release_admin_gateway_shutdown_failed')
    running = undefined
    await backendsClosed(login)
    recorded('actual_admin_tls_signal_handler_shutdown', {
      exitCode: 0,
      adminBackends: 0,
      method: 'ipc_dispatch_sigterm_handler',
      osSignalDeliveryVerified: false
    })
    for (const fixture of rejected) {
      const mappedRole = (
        await operator.query(
          `SELECT pg_has_role(r.rolname,'autoreply_admin','MEMBER') AS admin_member,
            pg_has_role(r.rolname,'autoreply_admin','USAGE') AS admin_usage, r.rolcreaterole,
            EXISTS(SELECT 1 FROM autoreply.admin_database_principals p WHERE p.login_name=r.rolname AND p.tenant_id=$2 AND p.employee_id=$3 AND p.enabled) AS mapped
          FROM pg_roles r WHERE r.rolname=$1`,
          [fixture.login, tenant, actor]
        )
      ).rows[0]
      check(
        mappedRole?.admin_member &&
          mappedRole.mapped &&
          mappedRole.admin_usage === !fixture.noInherit &&
          mappedRole.rolcreaterole === !!fixture.createRole,
        'release_admin_rejection_fixture_invalid'
      )
      for (const mode of ['cli', 'gateway']) {
        const entry = mode === 'cli' ? adminEntry : serverEntry
        const parameters = mode === 'cli' ? [entry, 'accounts', '--tenant', tenant] : [entry]
        const rejectedResult = await launch(process.execPath, parameters, {
          cwd: release,
          env: { ...serverEnvironment, ADMIN_DATABASE_URL: urlFor(fixture.login) },
          timeout: 6000
        }).result
        if (
          rejectedResult.code !== 1 ||
          rejectedResult.failure ||
          rejectedResult.stdout.trim() !== ''
        ) {
          const error = new Error(`release_${fixture.phase}_${mode}_unsafe_login_accepted`)
          error.releaseDiagnostic = {
            phase: `${fixture.phase}_${mode}`,
            exitCode: rejectedResult.code,
            failure: rejectedResult.failure,
            elapsedMs: rejectedResult.elapsedMs,
            stdoutEmpty: rejectedResult.stdout.trim() === ''
          }
          throw error
        }
        check(
          rejectedResult.stderr.trim() ===
            (mode === 'cli'
              ? '{"success":false,"code":"ADMIN_OPERATION_FAILED"}'
              : 'Administrator gateway unavailable. Check private configuration.'),
          'release_admin_rejection_diagnostic_invalid'
        )
        await backendsClosed(fixture.login)
        recorded(`${fixture.phase}_${mode}_rejected`, {
          exitCode: 1,
          adminBackends: 0,
          tenantMapped: true,
          genericDiagnostic: true,
          elapsedMs: rejectedResult.elapsedMs
        })
      }
    }
    await noOperations()
    return {
      summary: {
        dedicatedAdminLogin: true,
        cliProvisionedAccounts: 2,
        platforms: ['wechat', 'wework'],
        cliEnrollmentCommitted: true,
        accountsPaused: 2,
        earlierAuditPreserved: true,
        httpsIdentityVerified: true,
        httpsRuntimeStatusVerified: true,
        missingBearerStatus: 401,
        originStatus: 403,
        wrongTokenStatus: 401,
        pauseAllCommitted: true,
        rejectionLogins: 5,
        rejectedEntrypoints: 10,
        shutdownExitCode: 0,
        adminBackends: 0,
        modelAttempts: 0,
        executionPermits: 0,
        credentialsReported: false,
        physicalStopVerified: false,
        canAuthorizeSend: false
      },
      preparedCases
    }
  } catch (error) {
    const sanitized = new Error(
      typeof error?.message === 'string' &&
        /^release_(?:admin|calibration|holdout)_[a-z_]+$/.test(error.message)
        ? error.message
        : 'release_admin_validation_failed'
    )
    if (error?.releaseDiagnostic) sanitized.releaseDiagnostic = error.releaseDiagnostic
    throw sanitized
  } finally {
    if (running) {
      if (running.child.connected) running.child.send('shutdown')
      await running.result
    }
  }
}
