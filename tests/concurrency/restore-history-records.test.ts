import { Pool } from 'pg'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { protectPrivateDirectory } from '../../src/core/persistence/private-backup-directory'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { Postgres } from '../../server/src/database/postgres'
import { Administration } from '../../server/src/admin/administration'
import { AccountAuthority, tokenHash } from '../../server/src/auth/account-authority'
import { RestorePauseAuthority } from '../../server/src/execution/restore-pause-authority'
import { RestoreHistoryRequirementRecordSchema } from '../../server/src/admin/restore-history'
import { historyFixture } from '../fixtures/restore-history'
import { hashContext } from '../../src/core/reply/hashes'
import {
  lockRestoreHistoryKey,
  restoreHistoryKeySha256
} from '../../server/src/recovery/restore-history-key'
import {
  RestoreHistoryMaintenance,
  RestoreHistoryRegistrationSchema
} from '../../server/src/recovery/restore-history-maintenance'
import { RestoreExecutionMaintenance } from '../../server/src/recovery/restore-execution-maintenance'
import { RestoreRecoveryMaintenance } from '../../server/src/recovery/restore-recovery-authorization'
import { RestoreRecoveryApprovalInputSchema } from '../../src/shared/contracts/restore-recovery'
import { RestoreRecoveryAuthority } from '../../server/src/execution/restore-recovery-authority'
import { RestoreRecoveryCompletionAuthority } from '../../server/src/execution/restore-recovery-completion-authority'
import { restoreCompletionInputFixture } from '../fixtures/restore-completion'
import { parseRestoreRecoveryCompletionInput } from '../../src/shared/contracts/restore-completion'

let cluster: Pool, owner: Pool, adminDb: Postgres, appDb: Postgres, admin: Administration
const suffix = randomUUID().replaceAll('-', ''),
  database = 'autoreply_history_' + suffix
const adminLogin = 'history_admin_' + suffix,
  appLogin = 'history_app_' + suffix
const f = historyFixture(),
  token = 'Z'.repeat(43)
let requirementId: string
let maintenanceDb: Postgres
let maintenanceUrl: string
let maintenanceRequest: ReturnType<typeof RestoreHistoryRegistrationSchema.parse>
beforeAll(async () => {
  const uri = process.env.AUTOREPLY_POSTGRES_TEST_URL
  if (!uri || !process.env.AUTOREPLY_POSTGRES_TEST_REPORT)
    throw Error('use_isolated_postgres_runner')
  const url = new URL(uri)
  if (url.hostname !== '127.0.0.1' || !/^\/autoreply_concurrency_[a-f0-9]{32}$/.test(url.pathname))
    throw Error('use_isolated_postgres_runner')
  cluster = new Pool({ connectionString: uri, max: 1 })
  await cluster.query(`CREATE DATABASE "${database}"`)
  url.pathname = '/' + database
  maintenanceUrl = url.href
  owner = new Pool({
    connectionString: url.href,
    max: 2,
    options: '-c search_path=autoreply,public'
  })
  for (const file of (await readdir(resolve('server/migrations')))
    .filter((f) => /^\d{3}-.+\.sql$/.test(f))
    .sort()) {
    const source = await readFile(resolve('server/migrations', file), 'utf8')
    await owner.query(source)
    await owner.query(source)
  }
  const password = randomBytes(32).toString('hex')
  await owner.query(`CREATE ROLE "${adminLogin}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}';GRANT autoreply_admin TO "${adminLogin}";
   CREATE ROLE "${appLogin}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}';GRANT autoreply_app TO "${appLogin}";
   INSERT INTO tenants(id,name) VALUES('tenant','synthetic history');
   INSERT INTO employees(tenant_id,id,role) VALUES('tenant','admin','admin'),('tenant','employee','employee');
   INSERT INTO admin_database_principals(login_name,tenant_id,employee_id) VALUES('${adminLogin}','tenant','admin');
   INSERT INTO accounts(tenant_id,id,employee_id,platform,paused) VALUES('tenant','account','employee','wechat',false)`)
  await owner.query(
    "INSERT INTO agents(tenant_id,id,account_id,employee_id,token_hash) VALUES('tenant','agent','account','employee',$1)",
    [tokenHash(token)]
  )
  url.username = adminLogin
  url.password = password
  adminDb = new Postgres(url.href)
  admin = new Administration(adminDb)
  url.username = appLogin
  appDb = new Postgres(url.href)
  const review = await admin.openRestoreReview('tenant', 'account', {
    agentId: 'agent',
    context: f.required.manifest.context
  })
  f.required.caseId = review.caseId
  f.proof.caseId = review.caseId
  const service = new RestorePauseAuthority(new AccountAuthority(appDb))
  const challenge = await service.challenge(token, {
    caseId: review.caseId,
    requestId: randomUUID(),
    restoreId: review.restoreId,
    contextHash: review.contextHash
  })
  const hostWallClockAt = Date.now(),
    now = Number(
      (
        await appDb.pool.query(
          'SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now'
        )
      ).rows[0].now
    )
  // These are synthetic SQL facts, not a physical device stop. Use the same
  // authoritative clock as the challenge instead of mixing the Windows clock.
  await writeFile(
    join(process.env.AUTOREPLY_POSTGRES_TEST_REPORT!, 'restore-history-fixture-clock.json'),
    JSON.stringify(
      {
        kind: 'synthetic_sql_pause_fixture',
        hostWallClockAt,
        databaseObservedAt: now,
        challengeIssuedAt: challenge.issuedAt,
        challengeExpiresAt: challenge.expiresAt,
        physicalStopVerified: false
      },
      null,
      2
    )
  )
  await service.report(token, {
    challenge,
    instanceId: randomUUID(),
    runtimeGeneration: 1,
    stoppedAt: now,
    observedAt: now,
    stopped: {
      observerStopped: true,
      senderQuiescent: true,
      settlementQuiescent: true,
      leaseStopped: true,
      platformStopped: true
    }
  })
  const upload = await service.inventoryStart(token, {
    caseId: review.caseId,
    requestId: randomUUID(),
    challengeId: challenge.challengeId,
    manifest: f.required.manifest
  })
  await service.inventoryPage(token, {
    uploadId: upload.uploadId,
    index: 0,
    items: f.required.items
  })
  await service.inventoryComplete(token, { uploadId: upload.uploadId, pageCount: 1 })
  f.required.uploadId = upload.uploadId
  f.proof.uploadId = upload.uploadId
  const assessment = await admin.restoreAssessment(
      'tenant',
      'account',
      review.caseId,
      upload.uploadId
    ),
    at = Date.now()
  f.trust.notBefore = at - 60000
  f.trust.notAfter = at + 86400000
  requirementId = randomUUID()
  const r = RestoreHistoryRequirementRecordSchema.parse({
    formatVersion: 1,
    requirementId,
    caseId: review.caseId,
    uploadId: upload.uploadId,
    restoreId: review.restoreId,
    contextHash: review.contextHash,
    inventoryBasisHash: f.required.manifest.basisHash,
    assessmentBasisHash: assessment.basisHash,
    scopeHash: hashContext(f.required.manifest.scope),
    platformAccountIdHash: f.required.platformAccountIdHash,
    backupStartedAt: f.required.backupStartedAt,
    backupStartVerificationSha256: '1'.repeat(64),
    allDevicesStoppedAt: at,
    deviceStopVerificationSha256: '2'.repeat(64),
    sourceTrust: f.trust,
    recordedAt: at
  })
  maintenanceDb = new Postgres(maintenanceUrl)
  maintenanceRequest = RestoreHistoryRegistrationSchema.parse({
    registrationId: requirementId,
    tenantId: 'tenant',
    accountId: 'account',
    caseId: r.caseId,
    uploadId: r.uploadId,
    expectedContextHash: r.contextHash,
    expectedInventoryBasisHash: r.inventoryBasisHash,
    expectedAssessmentBasisHash: r.assessmentBasisHash,
    expectedScopeHash: r.scopeHash,
    platformAccountIdHash: r.platformAccountIdHash,
    backupStartedAt: r.backupStartedAt,
    backupStartVerificationSha256: r.backupStartVerificationSha256,
    allDevicesStoppedAt: r.allDevicesStoppedAt,
    deviceStopVerificationSha256: r.deviceStopVerificationSha256,
    sourceTrust: {
      ...r.sourceTrust,
      stableSourceOrderVerified: true,
      sourceOrderVerificationSha256: 'b'.repeat(64)
    },
    review: {
      reviewerId: 'synthetic-reviewer',
      evidenceSha256: '3'.repeat(64),
      reviewedAt: Date.now(),
      backupStartVerified: true,
      allDevicesStoppedVerified: true,
      physicalSourceHistoryVerified: true
    }
  })
  await new RestoreHistoryMaintenance(maintenanceDb).register(maintenanceRequest)
  f.proof.observedThrough = Date.now()
  f.proof.capturedAt = f.proof.observedThrough
})
afterAll(async () => {
  await adminDb?.close()
  await appDb?.close()
  await maintenanceDb?.close()
  await owner?.end()
  if (cluster) {
    await cluster.query(`DROP DATABASE IF EXISTS "${database}"`)
    await cluster.end()
  }
})
it('serializes reviewed maintenance registration across real independent connections and denies the ordinary operator', async () => {
  const clients = await Promise.all([maintenanceDb.pool.connect(), maintenanceDb.pool.connect()])
  try {
    expect(
      new Set(
        (await Promise.all(clients.map((c) => c.query('SELECT pg_backend_pid() AS pid')))).map(
          (r) => r.rows[0].pid
        )
      ).size
    ).toBe(2)
  } finally {
    clients.forEach((c) => c.release())
  }
  const input = { ...maintenanceRequest, registrationId: randomUUID() }
  const service = new RestoreHistoryMaintenance(maintenanceDb)
  const [first, second] = await Promise.all([service.register(input), service.register(input)])
  expect(second).toEqual(first)
  expect(first.receipt).toMatchObject({ recordedBy: 'postgres', canRelease: false })
  expect(
    (
      await owner.query(
        'SELECT count(*)::int AS n FROM restore_history_maintenance_records WHERE id=$1',
        [input.registrationId]
      )
    ).rows[0].n
  ).toBe(1)
  expect(
    (
      await owner.query(
        'SELECT count(*)::int AS n FROM ledger_restore_history_requirements WHERE id=$1',
        [input.registrationId]
      )
    ).rows[0].n
  ).toBe(1)
  await expect(new RestoreHistoryMaintenance(adminDb).register(input)).rejects.toThrow(
    'maintenance_denied'
  )
  // Existing proof tests must refer to the newly registered latest requirement.
  requirementId = input.registrationId
  f.proof.observedThrough = Date.now()
  f.proof.capturedAt = f.proof.observedThrough
})
it('serializes duplicate source submissions on independent backends into one exact proof and audit', async () => {
  const clients = await Promise.all([adminDb.pool.connect(), adminDb.pool.connect()])
  try {
    expect(
      new Set(
        (await Promise.all(clients.map((c) => c.query('SELECT pg_backend_pid() AS pid')))).map(
          (r) => r.rows[0].pid
        )
      ).size
    ).toBe(2)
  } finally {
    clients.forEach((c) => c.release())
  }
  const input = { requirementId, signedProof: f.envelope() }
  const [first, second] = await Promise.all([
    admin.recordRestoreHistoryProof(
      'tenant',
      'account',
      f.required.caseId,
      f.required.uploadId,
      input
    ),
    admin.recordRestoreHistoryProof(
      'tenant',
      'account',
      f.required.caseId,
      f.required.uploadId,
      input
    )
  ])
  expect(first.receipt).toEqual(second.receipt)
  expect(first).toMatchObject({ current: { state: 'current' }, canRelease: false })
  expect(
    (await owner.query('SELECT count(*)::int AS n FROM ledger_restore_history_proofs')).rows[0].n
  ).toBe(1)
  expect(
    (
      await owner.query(
        "SELECT count(*)::int AS n FROM audit_events WHERE kind='ledger_restore_history_recorded'"
      )
    ).rows[0].n
  ).toBe(1)
})
it('makes administrator disabling wait for an already authorized operation, then rejects future mutations', async () => {
  const lock = await owner.connect()
  const proof = { ...f.proof, proofId: randomUUID() }
  const { sign } = await import('node:crypto')
  const { restoreHistorySigningBytes } =
    await import('../../server/src/recovery/restore-history-proof')
  try {
    await lock.query('BEGIN')
    await lock.query("SELECT id FROM accounts WHERE tenant_id='tenant' AND id='account' FOR UPDATE")
    const pending = admin.recordRestoreHistoryProof(
      'tenant',
      'account',
      f.required.caseId,
      f.required.uploadId,
      {
        requirementId,
        signedProof: {
          proof,
          signature: sign(null, restoreHistorySigningBytes(proof), f.keys.privateKey).toString(
            'base64url'
          )
        }
      }
    )
    const result = expect(pending).resolves.toMatchObject({
      current: { state: 'current' },
      canRelease: false
    })
    // Observe an actual blocked backend, not a timed delay presumed to be a waiter.
    let waiting = false
    for (let i = 0; i < 100; i++) {
      const rows = (
        await cluster.query(
          'SELECT pid FROM pg_stat_activity WHERE usename=$1 AND wait_event_type=$2',
          [adminLogin, 'Lock']
        )
      ).rows
      if (rows.length) {
        waiting = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(waiting).toBe(true)
    const disabling = owner.query(
      "UPDATE employees SET enabled=false WHERE tenant_id='tenant' AND id='admin'"
    )
    const disabledResult = expect(disabling).resolves.toMatchObject({ rowCount: 1 })
    let disablingBlocked = false
    for (let i = 0; i < 100; i++) {
      const rows = (
        await cluster.query(
          "SELECT pid FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND query LIKE 'UPDATE employees SET enabled=false%'",
          [database]
        )
      ).rows
      if (rows.length) {
        disablingBlocked = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(disablingBlocked).toBe(true)
    await lock.query('COMMIT')
    await result
    await disabledResult
    await expect(
      admin.recordRestoreHistoryProof('tenant', 'account', f.required.caseId, f.required.uploadId, {
        requirementId,
        signedProof: f.envelope()
      })
    ).rejects.toThrow('DENIED')
    expect(
      (await owner.query('SELECT count(*)::int AS n FROM ledger_restore_history_proofs')).rows[0].n
    ).toBe(2)
  } finally {
    await lock.query('ROLLBACK')
    lock.release()
  }
})

it('runs the actual maintenance CLI, retries its original receipt, and denies wrong database and operator before reading files', async () => {
  const directory = resolve('.local/reports/postgres-history-maintenance', randomUUID())
  await mkdir(directory, { recursive: true })
  await protectPrivateDirectory(directory)
  const input = {
    ...maintenanceRequest,
    registrationId: randomUUID(),
    review: { ...maintenanceRequest.review, reviewedAt: Date.now() }
  }
  const path = join(directory, 'input.private.json'),
    output = join(directory, 'result.private.json'),
    retry = join(directory, 'retry.private.json')
  await writeFile(path, JSON.stringify(input), { flag: 'wx', mode: 0o600 })
  const execute = promisify(execFile)
  const run = (target: string, file = path, expectedDatabase = database, url = maintenanceUrl) =>
    execute(
      process.execPath,
      [
        '--import',
        'tsx',
        resolve('server/scripts/restore-history-maintenance.ts'),
        'register',
        '--database',
        expectedDatabase,
        '--file',
        file,
        '--output',
        target
      ],
      {
        windowsHide: true,
        timeout: 5000,
        env: { ...process.env, RESTORE_HISTORY_MAINTENANCE_DATABASE_URL: url }
      }
    )
  try {
    expect((await run(output)).stdout).toBe('Maintenance record saved; canRelease=false.\n')
  } finally {
    // A bounded child may stop after its database commit. Keep later independent
    // checks bound to actual committed facts; the CLI assertion still fails.
    const latest = (
      await owner.query(
        'SELECT id FROM ledger_restore_history_requirements WHERE tenant_id=$1 AND account_id=$2 AND case_id=$3 ORDER BY recorded_at DESC,id DESC LIMIT 1',
        ['tenant', 'account', f.required.caseId]
      )
    ).rows[0]
    if (latest) requirementId = latest.id
  }
  expect((await run(retry)).stdout).toBe('Maintenance record saved; canRelease=false.\n')
  const first = JSON.parse(await readFile(output, 'utf8'))
  expect(JSON.parse(await readFile(retry, 'utf8'))).toEqual(first)
  expect(first.receipt).toMatchObject({ recordedBy: 'postgres', canRelease: false })
  expect(
    (
      await owner.query(
        'SELECT count(*)::int AS n FROM restore_history_maintenance_records WHERE id=$1',
        [input.registrationId]
      )
    ).rows[0].n
  ).toBe(1)
  await expect(
    run(join(directory, 'wrong.private.json'), 'missing-private-file', 'wrong_database')
  ).rejects.toMatchObject({ stderr: 'maintenance_database_mismatch\n' })
  await expect(
    run(
      join(directory, 'denied.private.json'),
      'missing-private-file',
      database,
      adminDb.pool.options.connectionString!
    )
  ).rejects.toMatchObject({ stderr: 'maintenance_denied\n' })
  requirementId = input.registrationId
})

it('serializes execution review retries on independent backends and runs the actual private-output CLI', async () => {
  await owner.query("UPDATE employees SET enabled=true WHERE tenant_id='tenant' AND id='admin'")
  f.proof.proofId = randomUUID()
  f.proof.observedThrough = Date.now()
  f.proof.capturedAt = f.proof.observedThrough
  const history = await admin.recordRestoreHistoryProof(
    'tenant',
    'account',
    f.required.caseId,
    f.required.uploadId,
    { requirementId, signedProof: f.envelope() }
  )
  const input = {
    reviewId: randomUUID(),
    tenantId: 'tenant',
    accountId: 'account',
    caseId: f.required.caseId,
    uploadId: f.required.uploadId,
    historyProofId: f.proof.proofId,
    assessmentBasisHash: history.receipt.assessmentBasisHash,
    reviewerId: 'synthetic-reviewer',
    reviewedAt: Date.now(),
    outcomes: []
  }
  const clients = await Promise.all([maintenanceDb.pool.connect(), maintenanceDb.pool.connect()])
  try {
    expect(
      new Set(
        (await Promise.all(clients.map((c) => c.query('SELECT pg_backend_pid() AS pid')))).map(
          (r) => r.rows[0].pid
        )
      ).size
    ).toBe(2)
  } finally {
    clients.forEach((c) => c.release())
  }
  const service = new RestoreExecutionMaintenance(maintenanceDb)
  const [a, b] = await Promise.all([service.record(input), service.record(input)])
  expect(a).toEqual(b)
  expect(a.receipt).toMatchObject({
    subjects: 0,
    canRelease: false,
    physicalOutcomeVerifiedByThisCommand: false
  })
  expect(
    (
      await owner.query(
        'SELECT count(*)::int AS n FROM ledger_restore_execution_reviews WHERE review_id=$1',
        [input.reviewId]
      )
    ).rows[0].n
  ).toBe(1)
  await expect(new RestoreExecutionMaintenance(adminDb).record(input)).rejects.toThrow(
    'maintenance_denied'
  )
  const directory = resolve('.local/reports/postgres-execution-review', randomUUID())
  await mkdir(directory, { recursive: true })
  await protectPrivateDirectory(directory)
  const path = join(directory, 'input.private.json'),
    output = join(directory, 'result.private.json')
  await writeFile(path, JSON.stringify(input), { flag: 'wx', mode: 0o600 })
  const result = await promisify(execFile)(
    process.execPath,
    [
      '--import',
      'tsx',
      resolve('server/scripts/restore-history-maintenance.ts'),
      'review-executions',
      '--database',
      database,
      '--file',
      path,
      '--output',
      output
    ],
    {
      windowsHide: true,
      timeout: 5000,
      env: { ...process.env, RESTORE_HISTORY_MAINTENANCE_DATABASE_URL: maintenanceUrl }
    }
  )
  expect(result.stdout).toBe('Maintenance record saved; canRelease=false.\n')
  expect(JSON.parse(await readFile(output, 'utf8'))).toEqual(a)
  expect(
    await admin.restoreExecutionReview('tenant', 'account', input.caseId, input.reviewId)
  ).toEqual(a)
})
it('serializes complete recovery authorizations across real backends and retries the actual maintenance CLI without releasing the account', async () => {
  await owner.query("UPDATE employees SET enabled=true WHERE tenant_id='tenant' AND id='admin'")
  f.proof.proofId = randomUUID()
  f.proof.observedThrough = Date.now()
  f.proof.capturedAt = f.proof.observedThrough
  const history = await admin.recordRestoreHistoryProof(
    'tenant',
    'account',
    f.required.caseId,
    f.required.uploadId,
    { requirementId, signedProof: f.envelope() }
  )
  const reviewed = await new RestoreExecutionMaintenance(maintenanceDb).record({
    reviewId: randomUUID(),
    tenantId: 'tenant',
    accountId: 'account',
    caseId: f.required.caseId,
    uploadId: f.required.uploadId,
    historyProofId: f.proof.proofId,
    assessmentBasisHash: history.receipt.assessmentBasisHash,
    reviewerId: 'synthetic-reviewer',
    reviewedAt: Date.now(),
    outcomes: []
  })
  const preview = await admin.previewRestoreRecovery(
    'tenant',
    'account',
    f.required.caseId,
    f.required.uploadId,
    reviewed.receipt.reviewId
  )
  const fields = Object.fromEntries(
    Object.keys(RestoreRecoveryApprovalInputSchema.shape)
      .filter((k) => k in preview)
      .map((k) => [k, preview[k as keyof typeof preview]])
  )
  const input = RestoreRecoveryApprovalInputSchema.parse({
    ...fields,
    authorizationId: randomUUID(),
    reviewedBy: 'synthetic-reviewer',
    reviewedAt: Date.now()
  })
  const service = new RestoreRecoveryMaintenance(maintenanceDb),
    clients = await Promise.all([maintenanceDb.pool.connect(), maintenanceDb.pool.connect()])
  try {
    expect(
      new Set(
        (await Promise.all(clients.map((c) => c.query('SELECT pg_backend_pid() AS pid')))).map(
          (r) => r.rows[0].pid
        )
      ).size
    ).toBe(2)
  } finally {
    clients.forEach((c) => c.release())
  }
  const [first, second] = await Promise.all([service.approve(input), service.approve(input)])
  expect(first).toEqual(second)
  expect(first).toMatchObject({
    receipt: { status: 'approved_for_boundary', canRelease: false },
    current: { state: 'current' }
  })
  const fetched = await new RestoreRecoveryAuthority(new AccountAuthority(appDb)).latest(token, {
    caseId: input.caseId,
    restoreId: first.receipt.restoreId,
    contextHash: first.receipt.contextHash
  })
  expect(fetched.authorization).toEqual(first.receipt)
  expect(fetched.boundary.history).toEqual(f.proof)
  expect(JSON.stringify(fetched)).not.toContain('publicKeyPem')
  const resolutions = await new RestoreRecoveryAuthority(new AccountAuthority(appDb)).resolutions(
    token,
    {
      authorizationId: first.receipt.authorizationId,
      caseId: input.caseId,
      restoreId: first.receipt.restoreId,
      contextHash: first.receipt.contextHash
    }
  )
  expect(resolutions).toMatchObject({
    authorizationId: first.receipt.authorizationId,
    resolutionBasisHash: first.receipt.resolutionBasisHash,
    subjects: [],
    localExecutions: [],
    records: [],
    canRelease: false,
    automaticStart: false
  })
  const grant = await new RestoreRecoveryAuthority(new AccountAuthority(appDb)).observationGrant(
    token,
    {
      authorizationId: first.receipt.authorizationId,
      caseId: input.caseId,
      restoreId: first.receipt.restoreId,
      contextHash: first.receipt.contextHash
    }
  )
  expect(grant).toMatchObject({
    authorizationId: first.receipt.authorizationId,
    canRelease: false,
    automaticStart: false,
    sourceTrust: { stableSourceOrderVerified: true, publicKeyPem: f.trust.publicKeyPem }
  })
  expect(JSON.stringify(grant)).not.toContain('PRIVATE KEY')
  // This fixture declares synthetic local durability. Use the actual server clock for the
  // declaration so Windows/Docker clock skew cannot fabricate an invalid temporal ordering.
  const completionAt = Number(
    (await owner.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now'))
      .rows[0].now
  )
  expect(completionAt).toBeGreaterThanOrEqual(fetched.authorization.recordedAt)
  expect(completionAt).toBeGreaterThanOrEqual(grant.issuedAt)
  expect(completionAt).toBeLessThan(Math.min(fetched.authorization.expiresAt, grant.expiresAt))
  const completionInput = restoreCompletionInputFixture(fetched, resolutions, grant, completionAt)
  parseRestoreRecoveryCompletionInput(completionInput, fetched, resolutions)
  await writeFile(
    join(process.env.AUTOREPLY_POSTGRES_TEST_REPORT!, 'restore-completion-fixture-clock.json'),
    JSON.stringify({
      kind: 'synthetic_sql_completion_fixture',
      databaseObservedAt: completionAt,
      authorizationRecordedAt: fetched.authorization.recordedAt,
      grantIssuedAt: grant.issuedAt,
      grantExpiresAt: grant.expiresAt,
      physicalDurabilityVerified: false
    })
  )
  const completer = new RestoreRecoveryCompletionAuthority(new AccountAuthority(appDb)),
    completed = await Promise.all([
      completer.acknowledge(token, completionInput),
      completer.acknowledge(token, completionInput)
    ])
  expect(completed[0]).toEqual(completed[1])
  expect(completed[0]).toMatchObject({
    status: 'durable_recovery_recorded',
    localDurabilityVerifiedByServer: false,
    canRelease: false
  })
  expect(
    (await owner.query('SELECT count(*)::int AS n FROM ledger_restore_recovery_completions'))
      .rows[0].n
  ).toBe(1)
  expect(
    (
      await owner.query(
        "SELECT count(*)::int AS n FROM audit_events WHERE kind='ledger_restore_durable_recovery_recorded'"
      )
    ).rows[0].n
  ).toBe(1)
  await expect(
    appDb.pool.query('SELECT * FROM ledger_restore_recovery_authorizations')
  ).rejects.toThrow('permission denied')
  expect(
    (
      await owner.query(
        'SELECT count(*)::int AS n FROM ledger_restore_recovery_authorizations WHERE authorization_id=$1',
        [input.authorizationId]
      )
    ).rows[0].n
  ).toBe(1)
  await expect(new RestoreRecoveryMaintenance(adminDb).approve(input)).rejects.toThrow(
    'maintenance_denied'
  )
  expect(
    await admin.restoreRecoveryAuthorization(
      'tenant',
      'account',
      input.caseId,
      input.authorizationId
    )
  ).toEqual(first)
  const directory = resolve('.local/reports/postgres-recovery-authorization', randomUUID())
  await mkdir(directory, { recursive: true })
  await protectPrivateDirectory(directory)
  const path = join(directory, 'input.private.json'),
    output = join(directory, 'result.private.json')
  await writeFile(path, JSON.stringify(input), { flag: 'wx', mode: 0o600 })
  const result = await promisify(execFile)(
    process.execPath,
    [
      '--import',
      'tsx',
      resolve('server/scripts/restore-history-maintenance.ts'),
      'authorize-recovery',
      '--database',
      database,
      '--file',
      path,
      '--output',
      output
    ],
    {
      windowsHide: true,
      timeout: 5000,
      env: { ...process.env, RESTORE_HISTORY_MAINTENANCE_DATABASE_URL: maintenanceUrl }
    }
  )
  expect(result.stdout).toBe('Maintenance record saved; canRelease=false.\n')
  expect(JSON.parse(await readFile(output, 'utf8'))).toEqual(first)
  expect(
    (await owner.query("SELECT paused FROM accounts WHERE tenant_id='tenant' AND id='account'"))
      .rows[0].paused
  ).toBe(true)
  await expect(admin.resume('tenant', 'account')).rejects.toThrow('UNRESOLVED_RESTORE')
})
it('observes actual key lock waiters and refuses a new proof after independent maintenance revocation commits first', async () => {
  await owner.query("UPDATE employees SET enabled=true WHERE tenant_id='tenant' AND id='admin'")
  const originalProofs = (
    await owner.query('SELECT count(*)::int AS n FROM ledger_restore_history_proofs')
  ).rows[0].n
  const lock = await owner.connect()
  let revoking: Promise<unknown> | undefined, saving: Promise<unknown> | undefined
  try {
    await lock.query('BEGIN')
    await lockRestoreHistoryKey(lock, restoreHistoryKeySha256(f.trust.publicKeyPem))
    const waiters = async (expected: number): Promise<void> => {
      for (let i = 0; i < 100; i++) {
        const count = (
          await cluster.query(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND wait_event='advisory'",
            [database]
          )
        ).rows[0].n
        if (count === expected) return
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw new Error('history_key_waiter_not_observed')
    }
    revoking = expect(
      new RestoreHistoryMaintenance(maintenanceDb).revoke({
        registrationId: randomUUID(),
        publicKeyPem: f.trust.publicKeyPem,
        reasonSha256: '4'.repeat(64),
        reviewerId: 'synthetic-reviewer',
        reviewedAt: Date.now()
      })
    ).resolves.toMatchObject({ kind: 'key_revocation', canRelease: false })
    await waiters(1)
    f.proof.proofId = randomUUID()
    f.proof.observedThrough = Date.now()
    f.proof.capturedAt = f.proof.observedThrough
    saving = expect(
      admin.recordRestoreHistoryProof('tenant', 'account', f.required.caseId, f.required.uploadId, {
        requirementId,
        signedProof: f.envelope()
      })
    ).rejects.toThrow('RESTORE_HISTORY_NOT_READY')
    await waiters(2)
    await lock.query('COMMIT')
    await revoking
    await saving
    expect(
      (await owner.query('SELECT count(*)::int AS n FROM ledger_restore_history_proofs')).rows[0].n
    ).toBe(originalProofs)
    expect(
      (await owner.query('SELECT count(*)::int AS n FROM restore_history_key_revocations')).rows[0]
        .n
    ).toBe(1)
  } finally {
    await lock.query('ROLLBACK')
    lock.release()
    await Promise.allSettled([revoking, saving])
  }
})
it('rechecks an actual device revocation committed ahead of a queued recovery reader without exposing the package', async () => {
  const completionInput = (
    await owner.query('SELECT request_json FROM ledger_restore_recovery_completions LIMIT 1')
  ).rows[0].request_json
  const authorizationId = (
    await owner.query(
      'SELECT authorization_id FROM ledger_restore_recovery_authorizations ORDER BY recorded_at DESC LIMIT 1'
    )
  ).rows[0].authorization_id
  const lock = await owner.connect()
  let revoking: Promise<unknown> | undefined,
    reading: Promise<unknown> | undefined,
    resolutions: Promise<unknown> | undefined,
    completing: Promise<unknown> | undefined
  try {
    await lock.query('BEGIN')
    await lock.query("SELECT id FROM accounts WHERE tenant_id='tenant' AND id='account' FOR UPDATE")
    const waiters = async (expected: number): Promise<void> => {
      for (let i = 0; i < 100; i++) {
        const n = (
          await cluster.query(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock' AND query LIKE '%accounts%FOR UPDATE%'",
            [database]
          )
        ).rows[0].n
        if (n === expected) return
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw Error('recovery_account_waiter_not_observed')
    }
    revoking = expect(admin.revoke('tenant', 'account', 'agent')).resolves.toBeUndefined()
    await waiters(1)
    reading = expect(
      new RestoreRecoveryAuthority(new AccountAuthority(appDb)).latest(token, {
        caseId: f.required.caseId,
        restoreId: f.proof.restoreId,
        contextHash: f.proof.contextHash
      })
    ).rejects.toThrow('DENIED')
    await waiters(2)
    resolutions = expect(
      new RestoreRecoveryAuthority(new AccountAuthority(appDb)).resolutions(token, {
        caseId: f.required.caseId,
        restoreId: f.proof.restoreId,
        contextHash: f.proof.contextHash,
        authorizationId
      })
    ).rejects.toThrow('DENIED')
    await waiters(3)
    completing = expect(
      new RestoreRecoveryCompletionAuthority(new AccountAuthority(appDb)).acknowledge(
        token,
        completionInput
      )
    ).rejects.toThrow('DENIED')
    await waiters(4)
    await lock.query('COMMIT')
    await revoking
    await reading
    await resolutions
    await completing
    expect(
      (await owner.query("SELECT paused FROM accounts WHERE tenant_id='tenant' AND id='account'"))
        .rows[0].paused
    ).toBe(true)
  } finally {
    await lock.query('ROLLBACK')
    lock.release()
    await Promise.allSettled([revoking, reading, resolutions, completing])
  }
})
