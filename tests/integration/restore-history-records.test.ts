import { createHash, createPublicKey, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { embeddedPostgres } from '../fixtures/embedded-postgres'
import { historyFixture } from '../fixtures/restore-history'
import { Administration } from '../../server/src/admin/administration'
import { RestorePauseAuthority } from '../../server/src/execution/restore-pause-authority'
import { AccountAuthority, tokenHash } from '../../server/src/auth/account-authority'
import { hashContext } from '../../src/core/reply/hashes'
import { RestoreHistoryRequirementRecordSchema } from '../../server/src/admin/restore-history'
import { executeAdminCommand, parseAdminCommand } from '../../server/src/admin/command'
import { RestoreHistoryMaintenance } from '../../server/src/recovery/restore-history-maintenance'
import { RestoreExecutionMaintenance } from '../../server/src/recovery/restore-execution-maintenance'
import { restoreExecutionSubjects } from '../../server/src/recovery/restore-execution-proof'
import { readCompleteRestoreAssessment } from '../../server/src/admin/restore-assessment'
import { ReconciliationAuthority } from '../../server/src/execution/reconciliation-authority'
import { DeviceReconciliationReportSchema } from '../../src/shared/contracts/reconciliation'
import { RequestSealAuthority } from '../../server/src/execution/request-seal-authority'
import { requestNonDispatchProof } from '../../src/core/sending/request-seal-proof'
import { RestoreRecoveryMaintenance } from '../../server/src/recovery/restore-recovery-authorization'
import { RestoreRecoveryApprovalInputSchema } from '../../src/shared/contracts/restore-recovery'
import { RestoreRecoveryAuthority } from '../../server/src/execution/restore-recovery-authority'
import { createServer } from 'node:http'
import { createApplication } from '../../server/src/http/application'
import { listenFetchLoopback } from '../fixtures/fetch-loopback'
import { AgentRegistration } from '../../src/main/services/agent-registration'
import { parseRestoreResolutionPackage } from '../../src/shared/contracts/restore-resolution'
import { parseRestoreObservationGrant } from '../../src/shared/contracts/restore-observation'
import { RestoreRecoveryCompletionAuthority } from '../../server/src/execution/restore-recovery-completion-authority'
import { restoreCompletionInputFixture } from '../fixtures/restore-completion'
import { readRestoreCompletionAudit } from '../../server/src/admin/restore-completion-audit'
import { RestoreAdmissionMaintenance } from '../../server/src/recovery/restore-admission'

// These tests execute full SQL recovery reviews on PGlite. A cold Windows run
// can exceed five seconds without an application timeout or changed result.
vi.setConfig({ testTimeout: 30000 })

let pg: Awaited<ReturnType<typeof embeddedPostgres>>, admin: Administration
let f: ReturnType<typeof historyFixture>
let requirement: ReturnType<typeof RestoreHistoryRequirementRecordSchema.parse>
const credential = 'H'.repeat(43)
const maintenanceInput = () => ({
  registrationId: randomUUID(),
  tenantId: 'tenant',
  accountId: 'account',
  caseId: requirement.caseId,
  uploadId: requirement.uploadId,
  expectedContextHash: requirement.contextHash,
  expectedInventoryBasisHash: requirement.inventoryBasisHash,
  expectedAssessmentBasisHash: requirement.assessmentBasisHash,
  expectedScopeHash: requirement.scopeHash,
  platformAccountIdHash: requirement.platformAccountIdHash,
  backupStartedAt: requirement.backupStartedAt,
  backupStartVerificationSha256: requirement.backupStartVerificationSha256,
  allDevicesStoppedAt: requirement.allDevicesStoppedAt,
  deviceStopVerificationSha256: requirement.deviceStopVerificationSha256,
  sourceTrust: requirement.sourceTrust,
  review: {
    reviewerId: 'synthetic-reviewer',
    evidenceSha256: '3'.repeat(64),
    reviewedAt: Date.now(),
    backupStartVerified: true,
    allDevicesStoppedVerified: true,
    physicalSourceHistoryVerified: true
  }
})
async function asMaintenance<T>(
  operation: (service: RestoreHistoryMaintenance) => Promise<T>
): Promise<T> {
  await login('postgres')
  try {
    return await operation(new RestoreHistoryMaintenance(pg.db))
  } finally {
    await login()
  }
}

it('registers reviewed maintenance facts against actual complete evidence and retries the original immutable record', async () => {
  const input = maintenanceInput()
  const first = await asMaintenance((m) => m.register(input))
  expect(first.receipt).toMatchObject({
    recordedBy: 'postgres',
    canRelease: false,
    factVerificationPerformedByThisCommand: false
  })
  expect(first.requirement).toMatchObject({
    requirementId: input.registrationId,
    assessmentBasisHash: requirement.assessmentBasisHash
  })
  expect(await asMaintenance((m) => m.register(input))).toEqual(first)
  expect(
    (
      await ownerQuery<{ n: number }>(
        'SELECT count(*)::int AS n FROM restore_history_maintenance_records'
      )
    ).rows[0].n
  ).toBe(1)
  f.proof.observedThrough = Date.now()
  f.proof.capturedAt = f.proof.observedThrough
  const saved = await admin.recordRestoreHistoryProof(
    'tenant',
    'account',
    requirement.caseId,
    requirement.uploadId,
    { requirementId: input.registrationId, signedProof: f.envelope() }
  )
  expect(saved).toMatchObject({
    current: { state: 'current', canRelease: false },
    canRelease: false
  })
})
it('refuses maintenance facts from actual administrator, employee, worker and assumed roles', async () => {
  const input = maintenanceInput()
  for (const role of [
    'history_records_admin',
    'autoreply_app',
    'autoreply_learning_worker',
    'autoreply_restore_reader'
  ]) {
    await login(role)
    await expect(new RestoreHistoryMaintenance(pg.db).register(input)).rejects.toThrow(
      'maintenance_denied'
    )
  }
  await login('postgres')
  await pg.sql.exec('SET ROLE autoreply_admin')
  await expect(new RestoreHistoryMaintenance(pg.db).register(input)).rejects.toThrow(
    'maintenance_denied'
  )
  await login()
  expect(
    (
      await ownerQuery<{ n: number }>(
        'SELECT count(*)::int AS n FROM restore_history_maintenance_records'
      )
    ).rows[0].n
  ).toBe(0)
})
it('rejects changed, foreign, future, expired and unreviewed maintenance facts', async () => {
  const input = maintenanceInput()
  const mutations = [
    { ...input, expectedAssessmentBasisHash: 'f'.repeat(64) },
    { ...input, tenantId: 'foreign' },
    { ...input, sourceTrust: { ...input.sourceTrust, accountId: 'other' } },
    { ...input, backupStartedAt: Date.now() + 60000 },
    { ...input, review: { ...input.review, reviewedAt: Date.now() + 60000 } },
    { ...input, review: { ...input.review, reviewedAt: 0 } },
    { ...input, review: { ...input.review, physicalSourceHistoryVerified: false } },
    { ...input, sourceTrust: { ...input.sourceTrust, notAfter: 0 } },
    { ...input, canRelease: true }
  ]
  for (const raw of mutations) await expect(asMaintenance((m) => m.register(raw))).rejects.toThrow()
  expect(
    (
      await ownerQuery<{ n: number }>(
        'SELECT count(*)::int AS n FROM restore_history_maintenance_records'
      )
    ).rows[0].n
  ).toBe(0)
})
it('refuses active central leases and rolls back requirements when the maintenance audit fails', async () => {
  const input = maintenanceInput()
  await owner(
    "INSERT INTO account_leases(tenant_id,account_id,agent_id,login_epoch,client_instance_id,version,expires_at) VALUES('tenant','account','agent',1,'synthetic-process',1,clock_timestamp()+interval '60 seconds')"
  )
  const activeAssessment = await admin.restoreAssessment(
    'tenant',
    'account',
    input.caseId,
    input.uploadId
  )
  await expect(
    asMaintenance((m) =>
      m.register({ ...input, expectedAssessmentBasisHash: activeAssessment.basisHash })
    )
  ).rejects.toThrow('maintenance_not_ready')
  await owner(`DELETE FROM account_leases;CREATE OR REPLACE FUNCTION maintenance_fault() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'synthetic maintenance fault'; END$$;
    CREATE TRIGGER maintenance_fault BEFORE INSERT ON restore_history_maintenance_records FOR EACH ROW EXECUTE FUNCTION maintenance_fault()`)
  try {
    await expect(asMaintenance((m) => m.register(input))).rejects.toThrow(
      'synthetic maintenance fault'
    )
    expect(
      (
        await ownerQuery<{ n: number }>(
          'SELECT count(*)::int AS n FROM ledger_restore_history_requirements WHERE id=$1',
          [input.registrationId]
        )
      ).rows[0].n
    ).toBe(0)
  } finally {
    await owner('DROP TRIGGER maintenance_fault ON restore_history_maintenance_records')
  }
  expect((await asMaintenance((m) => m.register(input))).receipt.canRelease).toBe(false)
})
it('revokes by the real public key, preserves exact retries and rejects re-registration under another key label', async () => {
  await record()
  const raw = {
    registrationId: randomUUID(),
    publicKeyPem: requirement.sourceTrust.publicKeyPem,
    reasonSha256: '4'.repeat(64),
    reviewerId: 'synthetic-reviewer',
    reviewedAt: Date.now()
  }
  const first = await asMaintenance((m) => m.revoke(raw))
  expect(await asMaintenance((m) => m.revoke(raw))).toEqual(first)
  expect((await read()).current.state).toBe('source_revoked')
  const input = maintenanceInput()
  input.sourceTrust = {
    ...input.sourceTrust,
    source: { ...input.sourceTrust.source, keyId: 'renamed-key' }
  }
  await expect(asMaintenance((m) => m.register(input))).rejects.toThrow('maintenance_not_ready')
  await expect(
    asMaintenance((m) => m.revoke({ ...raw, reasonSha256: '5'.repeat(64) }))
  ).rejects.toThrow('maintenance_conflict')
  expect(
    (
      await ownerQuery<{ n: number }>(
        'SELECT count(*)::int AS n FROM restore_history_key_revocations'
      )
    ).rows[0].n
  ).toBe(1)
})
it('keeps maintenance requests and original actor immutable, private to maintenance, and rejects changed ID retries', async () => {
  const input = maintenanceInput()
  await asMaintenance((m) => m.register(input))
  await expect(
    asMaintenance((m) => m.register({ ...input, backupStartVerificationSha256: '5'.repeat(64) }))
  ).rejects.toThrow('maintenance_conflict')
  await expect(pg.sql.query('SELECT * FROM restore_history_maintenance_records')).rejects.toThrow(
    'permission denied'
  )
  await expect(
    owner('UPDATE restore_history_maintenance_records SET recorded_by=$1', ['forged'])
  ).rejects.toThrow('restore_history_immutable')
  await expect(owner('DELETE FROM restore_history_maintenance_records')).rejects.toThrow(
    'restore_history_immutable'
  )
  const again = await asMaintenance((m) => m.register(input))
  expect(again.receipt.recordedBy).toBe('postgres')
})
async function login(role = 'history_records_admin') {
  await pg.sql.exec(
    `SET SESSION AUTHORIZATION postgres;RESET ROLE;SET SESSION AUTHORIZATION ${role}`
  )
}
async function owner(sql: string, params: unknown[] = []) {
  await login('postgres')
  try {
    return params.length ? await pg.sql.query(sql, params) : await pg.sql.exec(sql)
  } finally {
    await login()
  }
}
async function ownerQuery<T>(sql: string, params: unknown[] = []) {
  await login('postgres')
  try {
    return await pg.sql.query<T>(sql, params)
  } finally {
    await login()
  }
}
async function installRequirement(r = requirement) {
  await owner(
    `INSERT INTO ledger_restore_history_requirements(tenant_id,account_id,case_id,upload_id,id,requirement_hash,requirement_json,recorded_at) VALUES('tenant','account',$1,$2,$3,$4,$5::jsonb,$6)`,
    [
      r.caseId,
      r.uploadId,
      r.requirementId,
      hashContext(r),
      JSON.stringify(r),
      new Date(r.recordedAt)
    ]
  )
}
const submission = () => ({ requirementId: requirement.requirementId, signedProof: f.envelope() })
const record = () =>
  admin.recordRestoreHistoryProof(
    'tenant',
    'account',
    f.required.caseId,
    f.required.uploadId,
    submission()
  )
const read = () =>
  admin.restoreHistoryProof('tenant', 'account', f.required.caseId, f.proof.proofId)
async function executionReviewFixture(
  withPermit = true,
  extraSourceMessages = 0,
  terminal = false
) {
  if (withPermit)
    await owner(
      `INSERT INTO execution_permits(tenant_id,id,account_id,agent_id,task_id,draft_hash,task_hash,draft_revision,lease_version,login_epoch,client_instance_id,conversation_id,status,issued_at,expires_at)
 VALUES('tenant','review-permit','account','agent','synthetic-task',$1,$2,0,1,1,'synthetic-client','customer','unknown',$3,$4)`,
      ['4'.repeat(64), '5'.repeat(64), new Date(Date.now() - 1000), new Date(Date.now() - 500)]
    )
  if (withPermit && terminal)
    await owner(
      `UPDATE execution_permits SET status='confirmed',settlement_hash=$1,settled_at=clock_timestamp()
    WHERE tenant_id='tenant' AND id='review-permit'`,
      [
        hashContext({
          permitId: 'review-permit',
          draftHash: '4'.repeat(64),
          status: 'confirmed',
          sourceMessageId: 'synthetic-automation-outbound',
          verificationProofHash: '9'.repeat(64)
        })
      ]
    )
  const assessment = await admin.restoreAssessment(
    'tenant',
    'account',
    requirement.caseId,
    requirement.uploadId
  )
  const stoppedAt = Date.now()
  const registered = await asMaintenance((m) =>
    m.register({
      ...maintenanceInput(),
      expectedAssessmentBasisHash: assessment.basisHash,
      allDevicesStoppedAt: stoppedAt
    })
  )
  requirement = registered.requirement
  if (withPermit)
    f.proof.conversations[0].messages.push({
      sourceMessageId: 'synthetic-automation-outbound',
      position: 3,
      direction: 'automation_outbound',
      contentHash: '6'.repeat(64),
      sentAt: Date.now() - 200
    })
  f.proof.observedThrough = Date.now()
  f.proof.capturedAt = f.proof.observedThrough
  for (let index = 0; index < extraSourceMessages; index++)
    f.proof.conversations[0].messages.push({
      sourceMessageId: 'synthetic-extra-' + index,
      position: f.proof.conversations[0].messages.length + 1,
      direction: 'inbound',
      contentHash: '8'.repeat(64),
      sentAt: f.proof.observedThrough
    })
  const history = await record()
  const subjects = await pg.db.transaction('tenant', async (db) =>
    restoreExecutionSubjects(
      await readCompleteRestoreAssessment(
        db,
        { tenant_id: 'tenant', actor_id: 'admin' },
        'account',
        requirement.caseId,
        requirement.uploadId
      )
    )
  )
  const input = {
    reviewId: randomUUID(),
    tenantId: 'tenant',
    accountId: 'account',
    caseId: requirement.caseId,
    uploadId: requirement.uploadId,
    historyProofId: f.proof.proofId,
    assessmentBasisHash: assessment.basisHash,
    reviewerId: 'synthetic-independent-reviewer',
    reviewedAt: Date.now(),
    outcomes: subjects.map((s) => ({
      subjectKey: s.subjectKey,
      subjectHash: s.subjectHash,
      conversationId: s.conversationId,
      evidenceSha256: '7'.repeat(64),
      observedAt: f.proof.observedThrough,
      outcome: 'confirmed' as const,
      sourceMessageId: 'synthetic-automation-outbound',
      sourceContentHash: '6'.repeat(64),
      draftTextHash: s.draftHash,
      causalAttributionVerified: true as const
    }))
  }
  const save = (raw: unknown = input) =>
    asMaintenance(() => new RestoreExecutionMaintenance(pg.db).record(raw))
  const inspect = () =>
    admin.restoreExecutionReview('tenant', 'account', requirement.caseId, input.reviewId)
  return { input, save, inspect, history }
}
async function resolvePermit(
  e: Awaited<ReturnType<typeof executionReviewFixture>>,
  outcome: 'confirmed' | 'not_sent' = 'confirmed',
  sourceMessageId = 'synthetic-automation-outbound'
) {
  const c = await admin.openReconciliation('tenant', 'account', 'review-permit')
  const request = {
    taskId: 'synthetic-task',
    taskHash: '5'.repeat(64),
    draftHash: '4'.repeat(64),
    draftRevision: 0,
    leaseVersion: 1,
    loginEpoch: 1,
    clientInstanceId: 'synthetic-client'
  }
  await login('autoreply_app')
  const service = new ReconciliationAuthority(new AccountAuthority(pg.db)),
    challenge = await service.challenge(credential, request),
    at = Date.now()
  const report = DeviceReconciliationReportSchema.parse({
    caseId: challenge.caseId,
    snapshotHash: challenge.snapshotHash,
    request,
    stopped: {
      stoppedAt: at,
      observerStopped: true,
      senderQuiescent: true,
      settlementQuiescent: true,
      leaseStopped: true,
      verifiedDriverStopped: true
    },
    observation: {
      executionId: randomUUID(),
      identity: {
        tenantId: 'tenant',
        accountId: 'account',
        employeeId: 'employee',
        agentId: 'agent',
        platform: 'wechat',
        loginEpoch: 1,
        clientInstanceId: 'synthetic-client'
      },
      conversationId: 'customer',
      permitId: 'review-permit',
      taskHash: request.taskHash,
      draftHash: request.draftHash,
      draftRevision: 0,
      leaseVersion: 1,
      observedAt: at,
      verificationProofHash: '9'.repeat(64),
      status: outcome,
      ...(outcome === 'confirmed'
        ? { sourceMessageId }
        : { dispatchStarted: false, quiescent: true })
    }
  })
  await service.report(credential, report)
  await login()
  const note = {
    noteId: randomUUID(),
    snapshotHash: c.snapshotHash,
    referenceId: 'synthetic-independent-note',
    evidenceHash: '8'.repeat(64),
    observedAt: Date.now()
  }
  await admin.recordReconciliationNote('tenant', 'account', c.caseId, note)
  const decision = await admin.decideReconciliation('tenant', 'account', c.caseId, {
    decisionId: randomUUID(),
    snapshotHash: c.snapshotHash,
    reportHash: hashContext(report),
    noteId: note.noteId,
    outcome
  })
  const apply = async () => {
    await login('autoreply_app')
    try {
      return await service.applied(credential, {
        caseId: c.caseId,
        snapshotHash: c.snapshotHash,
        reportHash: hashContext(report),
        request,
        decisionId: decision.decisionId,
        decisionHash: hashContext(decision)
      })
    } finally {
      await login()
    }
  }
  const inspect = () =>
    admin.restoreResolutionBasis('tenant', 'account', e.input.caseId, e.input.reviewId)
  return { apply, inspect, decision, report, note }
}
it('requires original independent reconciliation and exact device application before treating reviewed unknown permits as resolved', async () => {
  const e = await executionReviewFixture()
  await e.save()
  await expect(
    admin.restoreResolutionBasis('tenant', 'account', e.input.caseId, e.input.reviewId)
  ).rejects.toThrow('RESTORE_RESOLUTION_NOT_READY')
  const r = await resolvePermit(e)
  await expect(r.inspect()).rejects.toThrow('RESTORE_RESOLUTION_NOT_READY')
  await r.apply()
  const basis = await r.inspect()
  expect(basis).toMatchObject({
    centralPermits: 1,
    reconciledPermits: 1,
    separateReconciliationComplete: true,
    canRelease: false,
    automaticStart: false
  })
  expect(await r.inspect()).toEqual(basis)
  expect(
    await executeAdminCommand(
      admin,
      parseAdminCommand([
        'restore-resolution-basis',
        '--tenant',
        'tenant',
        '--account',
        'account',
        '--case',
        e.input.caseId,
        '--review',
        e.input.reviewId
      ]),
      async () => {
        throw Error('unexpected_file_read')
      }
    )
  ).toEqual(basis)
  expect(
    (
      await ownerQuery<{ status: string }>('SELECT status FROM execution_permits WHERE id=$1', [
        'review-permit'
      ])
    ).rows[0].status
  ).toBe('unknown')
})
it('rejects an applied confirmed decision for a different source message than the independently reviewed history anchor', async () => {
  const e = await executionReviewFixture()
  await e.save()
  const r = await resolvePermit(e, 'confirmed', 'different-message')
  await r.apply()
  await expect(r.inspect()).rejects.toThrow('RESTORE_RESOLUTION_CONFLICT')
})
it('rejects corrupted original note bindings and applied decision hashes even when an applied row exists', async () => {
  const e = await executionReviewFixture()
  await e.save()
  const r = await resolvePermit(e)
  await r.apply()
  await owner('UPDATE reconciliation_applied SET decision_hash=$1', ['0'.repeat(64)])
  await expect(r.inspect()).rejects.toThrow('RESTORE_RESOLUTION_CONFLICT')
  await owner('UPDATE reconciliation_applied SET decision_hash=$1', [hashContext(r.decision)])
  await owner('UPDATE reconciliation_notes SET evidence_hash=$1', ['0'.repeat(64)])
  await expect(r.inspect()).rejects.toThrow('RESTORE_RESOLUTION_CONFLICT')
})
it('requires every account request seal to have its exact immutable original applied receipt', async () => {
  const e = await executionReviewFixture(false)
  await e.save()
  const identity = {
    tenantId: 'tenant',
    employeeId: 'employee',
    accountId: 'account',
    agentId: 'agent',
    platform: 'wechat' as const,
    loginEpoch: 1,
    clientInstanceId: 'synthetic-client'
  }
  const request = {
      taskId: 'orphan-request',
      taskHash: '5'.repeat(64),
      draftHash: '4'.repeat(64),
      draftRevision: 0,
      leaseVersion: 1,
      loginEpoch: 1,
      clientInstanceId: 'synthetic-client'
    },
    executionId = randomUUID()
  const input = {
    executionId,
    identity,
    request,
    stopped: {
      stoppedAt: Date.now(),
      observerStopped: true,
      senderQuiescent: true,
      settlementQuiescent: true,
      leaseStopped: true,
      verifiedDriverStopped: true
    },
    verificationProofHash: requestNonDispatchProof({ executionId, identity, request })
  }
  await login('autoreply_app')
  const service = new RequestSealAuthority(new AccountAuthority(pg.db)),
    result = await service.seal(credential, input)
  await login()
  if (result.status !== 'request_sealed') throw Error('synthetic_seal_not_created')
  await expect(
    admin.restoreResolutionBasis('tenant', 'account', e.input.caseId, e.input.reviewId)
  ).rejects.toThrow('RESTORE_RESOLUTION_NOT_READY')
  await login('autoreply_app')
  await service.applied(credential, {
    sealId: result.seal.sealId,
    requestHash: result.seal.requestHash,
    sealHash: hashContext(result.seal),
    executionId
  })
  await login()
  expect(
    await admin.restoreResolutionBasis('tenant', 'account', e.input.caseId, e.input.reviewId)
  ).toMatchObject({
    appliedRequestSeals: 1,
    separateReconciliationComplete: true,
    canRelease: false
  })
  await expect(
    owner('UPDATE execution_request_seal_applications SET seal_hash=$1', ['0'.repeat(64)])
  ).rejects.toThrow('foreign key constraint')
})
it('checks an empty resolved execution set without granting recovery or exposing source contents', async () => {
  const e = await executionReviewFixture(false)
  await e.save()
  const basis = await admin.restoreResolutionBasis(
    'tenant',
    'account',
    e.input.caseId,
    e.input.reviewId
  )
  expect(basis).toMatchObject({
    centralPermits: 0,
    reconciledPermits: 0,
    localExecutions: 0,
    canRelease: false
  })
  expect(JSON.stringify(basis)).not.toContain('privateKey')
  expect(JSON.stringify(basis)).not.toContain('messages')
  await owner("UPDATE employees SET enabled=false WHERE tenant_id='tenant' AND id='admin'")
  await expect(
    admin.restoreResolutionBasis('tenant', 'account', e.input.caseId, e.input.reviewId)
  ).rejects.toThrow('DENIED')
})
async function recoveryApprovalFixture(
  withPermit = true,
  extraSourceMessages = 0,
  terminal = false
) {
  const e = await executionReviewFixture(withPermit, extraSourceMessages, terminal)
  await e.save()
  if (withPermit && !terminal) {
    const r = await resolvePermit(e)
    await r.apply()
  }
  const preview = await admin.previewRestoreRecovery(
    'tenant',
    'account',
    e.input.caseId,
    e.input.uploadId,
    e.input.reviewId
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
  const approve = (raw: unknown = input) =>
    asMaintenance(() => new RestoreRecoveryMaintenance(pg.db).approve(raw))
  const inspect = () =>
    admin.restoreRecoveryAuthorization('tenant', 'account', input.caseId, input.authorizationId)
  return { e, preview, input, approve, inspect }
}
it('authorizes a complete durable boundary only after independent original resolutions and preserves pause and unknown history', async () => {
  const r = await recoveryApprovalFixture(),
    saved = await r.approve()
  expect(saved).toMatchObject({
    receipt: {
      status: 'approved_for_boundary',
      physicalFactsVerifiedByThisCommand: false,
      recordedBy: 'postgres',
      localDurableApplicationRequired: true,
      centralCompletionRequired: true,
      canRelease: false
    },
    current: { state: 'current' }
  })
  expect(await r.approve()).toEqual(saved)
  expect(await r.inspect()).toEqual(saved)
  expect(
    (await ownerQuery<{ paused: boolean }>('SELECT paused FROM accounts WHERE id=$1', ['account']))
      .rows[0].paused
  ).toBe(true)
  expect(
    (
      await ownerQuery<{ status: string }>('SELECT status FROM execution_permits WHERE id=$1', [
        'review-permit'
      ])
    ).rows[0].status
  ).toBe('unknown')
  await expect(admin.resume('tenant', 'account')).rejects.toThrow('UNRESOLVED_RESTORE')
  const row = (
    await ownerQuery<{ boundary_json: { history: { conversations: unknown[] } } }>(
      'SELECT boundary_json FROM ledger_restore_recovery_authorizations'
    )
  ).rows[0]
  expect(row.boundary_json.history.conversations).toHaveLength(2)
  expect(
    await executeAdminCommand(
      admin,
      parseAdminCommand([
        'restore-recovery-authorization',
        '--tenant',
        'tenant',
        '--account',
        'account',
        '--case',
        r.input.caseId,
        '--authorization',
        r.input.authorizationId
      ]),
      async () => {
        throw Error('unexpected_file_read')
      }
    )
  ).toEqual(saved)
})
it('does not permit ordinary administrators, device or learning logins to create authorizations or forge release rows', async () => {
  const r = await recoveryApprovalFixture(false)
  for (const role of [
    'history_records_admin',
    'autoreply_app',
    'autoreply_learning_worker',
    'autoreply_restore_reader'
  ]) {
    await login(role)
    await expect(new RestoreRecoveryMaintenance(pg.db).approve(r.input)).rejects.toThrow(
      'maintenance_denied'
    )
    await expect(
      pg.sql.query('INSERT INTO ledger_restore_recovery_authorizations(tenant_id) VALUES($1)', [
        'tenant'
      ])
    ).rejects.toThrow('permission denied')
  }
  await login()
  await r.approve()
  await expect(
    owner('UPDATE ledger_restore_recovery_authorizations SET recorded_by=$1', ['forged'])
  ).rejects.toThrow('restore_history_immutable')
  await expect(owner('DELETE FROM ledger_restore_recovery_authorizations')).rejects.toThrow(
    'restore_history_immutable'
  )
  const foreign = await pg.db.transaction('foreign', (db) =>
    db.query('SELECT authorization_id FROM ledger_restore_recovery_authorizations')
  )
  expect(foreign.rows).toHaveLength(0)
})
it('rejects changed hashes, scope, review times or input flags instead of manufacturing recovery permission', async () => {
  const r = await recoveryApprovalFixture(false)
  for (const raw of [
    { ...r.input, expectedResolutionBasisHash: '0'.repeat(64) },
    { ...r.input, expectedHistoryReceiptHash: '0'.repeat(64) },
    { ...r.input, expectedExecutionReceiptHash: '0'.repeat(64) },
    { ...r.input, expectedInventoryBasisHash: '0'.repeat(64) },
    { ...r.input, expectedContextHash: '0'.repeat(64) },
    { ...r.input, reviewedAt: Date.now() + 60000 },
    { ...r.input, reviewedAt: 0 },
    { ...r.input, canRelease: true },
    { ...r.input, accountId: 'other' }
  ])
    await expect(r.approve(raw)).rejects.toThrow()
  expect(
    (
      await ownerQuery<{ n: number }>(
        'SELECT count(*)::int AS n FROM ledger_restore_recovery_authorizations'
      )
    ).rows[0].n
  ).toBe(0)
})
it('keeps historical authorization but invalidates current use after source revocation or changed original resolutions', async () => {
  const r = await recoveryApprovalFixture(),
    saved = await r.approve()
  const originalHash = (
    await ownerQuery<{ decision_hash: string }>('SELECT decision_hash FROM reconciliation_applied')
  ).rows[0].decision_hash
  await owner('UPDATE reconciliation_applied SET decision_hash=$1', ['0'.repeat(64)])
  const changed = await r.inspect()
  expect(changed.receipt).toEqual(saved.receipt)
  expect(changed.current.state).toBe('evidence_unavailable')
  await owner('UPDATE reconciliation_applied SET decision_hash=$1', [originalHash])
  await asMaintenance((m) =>
    m.revoke({
      registrationId: randomUUID(),
      publicKeyPem: f.trust.publicKeyPem,
      reasonSha256: '9'.repeat(64),
      reviewerId: 'synthetic-reviewer',
      reviewedAt: Date.now()
    })
  )
  expect((await r.inspect()).current.state).toBe('evidence_unavailable')
  await expect(
    r.approve({ ...r.input, authorizationId: randomUUID(), reviewedAt: Date.now() })
  ).rejects.toThrow('RESTORE_RECOVERY_NOT_READY')
})
it('checks persisted boundary and request integrity on reads without exposing the full private history', async () => {
  const r = await recoveryApprovalFixture(false)
  const saved = await r.approve()
  expect(JSON.stringify(saved)).not.toContain('sourceMessageId')
  expect(JSON.stringify(await r.inspect())).not.toContain('boundary_json')
  await owner('DROP TRIGGER restore_history_immutable ON ledger_restore_recovery_authorizations')
  await owner('UPDATE ledger_restore_recovery_authorizations SET boundary_hash=$1', [
    '0'.repeat(64)
  ])
  await expect(r.inspect()).rejects.toThrow('RESTORE_RECOVERY_CONFLICT')
})
it('records every central-only execution, retries exactly and preserves unknown permit and pause', async () => {
  const e = await executionReviewFixture(),
    first = await e.save()
  expect(first).toMatchObject({
    receipt: {
      subjects: 1,
      confirmed: 1,
      executionGroups: 1,
      recordedBy: 'postgres',
      physicalOutcomeVerifiedByThisCommand: false,
      canRelease: false
    },
    current: { state: 'current' }
  })
  expect(await e.save()).toEqual(first)
  expect(await e.inspect()).toEqual(first)
  expect(
    await executeAdminCommand(
      admin,
      parseAdminCommand([
        'restore-execution-review',
        '--tenant',
        'tenant',
        '--account',
        'account',
        '--case',
        e.input.caseId,
        '--review',
        e.input.reviewId
      ]),
      async () => {
        throw Error('unexpected_file_read')
      }
    )
  ).toEqual(first)
  expect(
    (
      await ownerQuery<{ status: string }>('SELECT status FROM execution_permits WHERE id=$1', [
        'review-permit'
      ])
    ).rows[0].status
  ).toBe('unknown')
  expect(
    (await ownerQuery<{ paused: boolean }>('SELECT paused FROM accounts WHERE id=$1', ['account']))
      .rows[0].paused
  ).toBe(true)
  await expect(e.save({ ...e.input, reviewerId: 'changed' })).rejects.toThrow(
    'restore_execution_conflict'
  )
})
it('does not accept partial coverage, another basis, missing source or unverified causality', async () => {
  const e = await executionReviewFixture()
  for (const raw of [
    { ...e.input, outcomes: [] },
    { ...e.input, assessmentBasisHash: '0'.repeat(64) },
    { ...e.input, outcomes: [{ ...e.input.outcomes[0], sourceMessageId: 'missing' }] },
    { ...e.input, outcomes: [{ ...e.input.outcomes[0], causalAttributionVerified: false }] }
  ])
    await expect(e.save(raw)).rejects.toThrow()
  expect(
    (
      await ownerQuery<{ n: number }>(
        'SELECT count(*)::int AS n FROM ledger_restore_execution_reviews'
      )
    ).rows[0].n
  ).toBe(0)
})
it('restricts execution maintenance writes to actual independent authority and makes them immutable', async () => {
  const e = await executionReviewFixture()
  for (const role of [
    'history_records_admin',
    'autoreply_app',
    'autoreply_learning_worker',
    'autoreply_restore_reader'
  ]) {
    await login(role)
    await expect(new RestoreExecutionMaintenance(pg.db).record(e.input)).rejects.toThrow(
      'maintenance_denied'
    )
    await expect(
      pg.sql.query('INSERT INTO ledger_restore_execution_reviews(tenant_id) VALUES($1)', ['tenant'])
    ).rejects.toThrow('permission denied')
  }
  await login()
  await e.save()
  await expect(
    owner('UPDATE ledger_restore_execution_reviews SET recorded_by=$1', ['forged'])
  ).rejects.toThrow('restore_history_immutable')
  await expect(owner('DELETE FROM ledger_restore_execution_reviews')).rejects.toThrow(
    'restore_history_immutable'
  )
  await login('autoreply_app')
  await expect(pg.sql.query('SELECT * FROM ledger_restore_execution_reviews')).rejects.toThrow(
    'permission denied'
  )
  await login()
  const foreign = await pg.db.transaction('foreign', (db) =>
    db.query('SELECT * FROM ledger_restore_execution_reviews')
  )
  expect(foreign.rows).toHaveLength(0)
})
it('records an explicit reviewed nondispatch journal while retaining original unknown settlement', async () => {
  const e = await executionReviewFixture(),
    s = e.input.outcomes[0]
  const saved = await e.save({
    ...e.input,
    outcomes: [
      {
        subjectKey: s.subjectKey,
        subjectHash: s.subjectHash,
        conversationId: s.conversationId,
        evidenceSha256: s.evidenceSha256,
        observedAt: s.observedAt,
        outcome: 'not_sent',
        dispatchStarted: false,
        quiescent: true,
        dispatchJournalEntrySha256: '8'.repeat(64),
        nonDispatchJournalVerified: true
      }
    ]
  })
  expect(saved.receipt).toMatchObject({
    notSent: 1,
    confirmed: 0,
    separateReconciliationRequired: true
  })
  expect(
    (
      await ownerQuery<{ status: string }>('SELECT status FROM execution_permits WHERE id=$1', [
        'review-permit'
      ])
    ).rows[0].status
  ).toBe('unknown')
})
it('retains original review after changed central facts without recertifying it', async () => {
  const e = await executionReviewFixture(),
    saved = await e.save()
  await owner("UPDATE execution_permits SET status='not_sent' WHERE id='review-permit'")
  const again = await e.save()
  expect(again.receipt).toEqual(saved.receipt)
  expect(again.current.state).toBe('history_not_current')
  await expect(e.save({ ...e.input, reviewId: randomUUID() })).rejects.toThrow(
    'restore_execution_not_ready'
  )
})
it('rejects new reviews after source revocation while preserving the historical receipt', async () => {
  const e = await executionReviewFixture(),
    saved = await e.save()
  await asMaintenance((m) =>
    m.revoke({
      registrationId: randomUUID(),
      publicKeyPem: f.trust.publicKeyPem,
      reasonSha256: '9'.repeat(64),
      reviewerId: 'synthetic-reviewer',
      reviewedAt: Date.now()
    })
  )
  expect((await e.inspect()).receipt).toEqual(saved.receipt)
  expect((await e.inspect()).current.state).toBe('history_not_current')
  await expect(e.save({ ...e.input, reviewId: randomUUID() })).rejects.toThrow(
    'restore_execution_not_ready'
  )
})
it('records an empty execution set without releasing a restore with historical messages', async () => {
  const e = await executionReviewFixture(false)
  expect((await e.save()).receipt).toMatchObject({
    subjects: 0,
    executionGroups: 0,
    canRelease: false
  })
})
it('revalidates original source signatures and receipt contents on historical reads', async () => {
  const e = await executionReviewFixture()
  await e.save()
  await owner('DROP TRIGGER restore_history_immutable ON ledger_restore_execution_reviews')
  await owner("UPDATE ledger_restore_execution_reviews SET recorded_by='forged'")
  await expect(e.inspect()).rejects.toThrow('restore_execution_conflict')
})
it('rolls back execution review on storage failure and rejects disabled readers', async () => {
  const e = await executionReviewFixture()
  await owner(`CREATE OR REPLACE FUNCTION autoreply.execution_review_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic_review_storage_failure'; END $$;
 CREATE TRIGGER execution_review_fault BEFORE INSERT ON ledger_restore_execution_reviews FOR EACH ROW EXECUTE FUNCTION autoreply.execution_review_fault();`)
  try {
    await expect(e.save()).rejects.toThrow('synthetic_review_storage_failure')
    expect(
      (
        await ownerQuery<{ n: number }>(
          'SELECT count(*)::int AS n FROM ledger_restore_execution_reviews'
        )
      ).rows[0].n
    ).toBe(0)
  } finally {
    await owner('DROP TRIGGER execution_review_fault ON ledger_restore_execution_reviews')
  }
  await e.save()
  await owner("UPDATE employees SET enabled=false WHERE tenant_id='tenant' AND id='admin'")
  await expect(e.inspect()).rejects.toThrow('DENIED')
})
it('gives only the exact authenticated paused target its current independently approved boundary', async () => {
  const r = await recoveryApprovalFixture(),
    approved = await r.approve(),
    input = {
      caseId: r.input.caseId,
      restoreId: approved.receipt.restoreId,
      contextHash: approved.receipt.contextHash
    }
  await login('autoreply_app')
  const service = new RestoreRecoveryAuthority(new AccountAuthority(pg.db)),
    result = await service.latest(credential, input)
  expect(result.authorization).toEqual(approved.receipt)
  expect(result.boundary.history).toEqual(f.proof)
  expect(JSON.stringify(result)).not.toContain('publicKeyPem')
  expect(result.authorization.canRelease).toBe(false)
  await expect(service.latest('invalid', input)).rejects.toThrow('DENIED')
  for (const bad of [
    { ...input, caseId: randomUUID() },
    { ...input, restoreId: randomUUID() },
    { ...input, contextHash: '0'.repeat(64) },
    { ...input, canRelease: true }
  ])
    await expect(service.latest(credential, bad)).rejects.toThrow()
  expect((await pg.sql.query('SELECT current_user AS role')).rows[0]).toEqual({
    role: 'autoreply_app'
  })
  await owner(
    "UPDATE agents SET revoked_at=clock_timestamp() WHERE tenant_id='tenant' AND id='agent'"
  )
  await login('autoreply_app')
  await expect(service.latest(credential, input)).rejects.toThrow('DENIED')
})
async function completionDeclarationFixture(trustExpiresIn?: number, withPermit = true) {
  requirement.sourceTrust = {
    ...requirement.sourceTrust,
    stableSourceOrderVerified: true,
    sourceOrderVerificationSha256: 'b'.repeat(64)
  }
  if (trustExpiresIn !== undefined) requirement.sourceTrust.notAfter = Date.now() + trustExpiresIn
  const r = await recoveryApprovalFixture(withPermit),
    approved = await r.approve(),
    a = approved.receipt
  await login('autoreply_app')
  const authority = new AccountAuthority(pg.db),
    reader = new RestoreRecoveryAuthority(authority),
    lookup = {
      caseId: a.caseId,
      restoreId: a.restoreId,
      contextHash: a.contextHash,
      authorizationId: a.authorizationId
    },
    p = await reader.latest(credential, {
      caseId: a.caseId,
      restoreId: a.restoreId,
      contextHash: a.contextHash
    }),
    resolutions = await reader.resolutions(credential, lookup),
    grant = await reader.observationGrant(credential, lookup)
  return {
    r,
    p,
    authority,
    input: restoreCompletionInputFixture(p, resolutions, grant),
    service: new RestoreRecoveryCompletionAuthority(authority)
  }
}
it('records one exact authenticated durable declaration, protects original scope and retains unknown outcomes and pause', async () => {
  const c = await completionDeclarationFixture(),
    ack = await c.service.acknowledge(credential, c.input)
  expect(ack).toMatchObject({
    status: 'durable_recovery_recorded',
    localDurabilityDeclared: true,
    localDurabilityVerifiedByServer: false,
    accountAdmissionRequired: true,
    canRelease: false
  })
  expect(await c.service.acknowledge(credential, c.input)).toEqual(ack)
  const changed = structuredClone(c.input)
  changed.boundaryApplication.postInventoryBasisHash = 'f'.repeat(64)
  await expect(c.service.acknowledge(credential, changed)).rejects.toThrow(
    'RESTORE_COMPLETION_CONFLICT'
  )
  await expect(
    c.service.acknowledge(credential, { ...c.input, completionId: randomUUID() })
  ).rejects.toThrow('RESTORE_COMPLETION_CONFLICT')
  await expect(c.service.acknowledge('invalid', c.input)).rejects.toThrow('DENIED')
  expect((await pg.sql.query('SELECT current_user AS role')).rows[0]).toEqual({
    role: 'autoreply_app'
  })
  const rows = await ownerQuery<{ n: number }>(
    'SELECT count(*)::int AS n FROM ledger_restore_recovery_completions'
  )
  expect(rows.rows[0].n).toBe(1)
  expect(
    (await ownerQuery<{ status: string }>('SELECT status FROM execution_permits')).rows[0].status
  ).toBe('unknown')
  await expect(admin.resume('tenant', 'account')).rejects.toThrow('UNRESOLVED_RESTORE')
  await owner('DROP TRIGGER restore_history_immutable ON ledger_restore_recovery_completions')
  await owner('UPDATE ledger_restore_recovery_completions SET receipt_hash=$1', ['0'.repeat(64)])
  await login('autoreply_app')
  await expect(c.service.acknowledge(credential, c.input)).rejects.toThrow(
    'RESTORE_COMPLETION_CONFLICT'
  )
})
async function admissionFixture(withPermit = false) {
  const c = await completionDeclarationFixture(undefined, withPermit)
  await c.service.acknowledge(credential, c.input)
  await login()
  const audit = await admin.restoreCompletionAudit('tenant', 'account')
  const input = {
    approvalId: randomUUID(),
    tenantId: 'tenant',
    accountId: 'account',
    expectedBasisHash: audit.basisHash,
    reviewedBy: 'synthetic-independent-reviewer',
    reviewedAt: Date.now(),
    evidenceSha256: 'e'.repeat(64),
    completeAccountCasesVerified: true,
    physicalDurabilityIndependentlyVerified: true
  }
  const approve = (raw: unknown = input) =>
    asMaintenance(() => new RestoreAdmissionMaintenance(pg.db).approve(raw))
  return { c, input, approve }
}
it('admits only an independently reviewed complete account, retains old outcomes and invalidates admission on a new case', async () => {
  const a = await admissionFixture(true)
  const receipt = await a.approve()
  expect(receipt).toMatchObject({
    centralAdmissionApproved: true,
    localAdmissionRequired: true,
    physicalVerificationPerformedByThisCommand: false,
    automaticStart: false,
    recordedBy: 'postgres'
  })
  expect(await a.approve()).toEqual(receipt)
  await expect(a.approve({ ...a.input, evidenceSha256: 'f'.repeat(64) })).rejects.toThrow(
    'RESTORE_ADMISSION_CONFLICT'
  )
  await owner("UPDATE accounts SET paused=false WHERE tenant_id='tenant' AND id='account'")
  await login('autoreply_app')
  const lease = await a.c.authority.acquireLease(credential, 1, 'admitted-instance')
  expect(lease.identity.agentId).toBe('agent')
  // RLS hides historical permits from an ordinary device update. Explicit SET ROLE
  // on the fixture owner bypasses RLS but disables the trusted bootstrap exemption,
  // isolating the execution trigger's independent anti-replay check.
  await pg.sql.query(
    "UPDATE execution_permits SET status='issued' WHERE tenant_id='tenant' AND account_id='account'"
  )
  await expect(
    owner(
      "SET ROLE postgres;UPDATE execution_permits SET status='issued' WHERE tenant_id='tenant' AND account_id='account'"
    )
  ).rejects.toThrow('restored_permit_replay_denied')
  expect(
    (await ownerQuery<{ status: string }>('SELECT status FROM execution_permits')).rows[0].status
  ).toBe('unknown')
  const descriptor = { ...f.required.manifest.context, restoreId: randomUUID() }
  const fields = Object.fromEntries(
    Object.entries(descriptor).filter(([key]) => key !== 'contextHash')
  )
  await admin.openRestoreReview('tenant', 'account', {
    agentId: 'agent',
    context: { ...fields, contextHash: hashContext(fields) }
  })
  await expect(admin.resume('tenant', 'account')).rejects.toThrow('UNRESOLVED_RESTORE')
  expect(await a.approve()).toEqual(receipt)
  await login('autoreply_app')
  await expect(a.c.authority.acquireLease(credential, 1, 'admitted-instance')).rejects.toThrow(
    'PAUSED'
  )
  await login()
  // Invalidation still allows stopping an existing lease and revoking the old holder.
  await expect(admin.revoke('tenant', 'account', 'agent')).resolves.toBeUndefined()
})
it('rejects lease renewal after source-key revocation without renewing historical admission or blocking holder revocation', async () => {
  const a = await admissionFixture()
  const receipt = await a.approve()
  await owner("UPDATE accounts SET paused=false WHERE tenant_id='tenant' AND id='account'")
  await login('autoreply_app')
  await a.c.authority.acquireLease(credential, 1, 'admitted-instance')
  await asMaintenance((m) =>
    m.revoke({
      registrationId: randomUUID(),
      publicKeyPem: requirement.sourceTrust.publicKeyPem,
      reasonSha256: 'd'.repeat(64),
      reviewerId: 'synthetic-independent-reviewer',
      reviewedAt: Date.now()
    })
  )
  expect(await a.approve()).toEqual(receipt)
  await login('autoreply_app')
  await expect(a.c.authority.acquireLease(credential, 1, 'admitted-instance')).rejects.toThrow(
    'UNRESOLVED_RESTORE'
  )
  await login()
  await expect(admin.resume('tenant', 'account')).rejects.toThrow('UNRESOLVED_RESTORE')
  await expect(admin.revoke('tenant', 'account', 'agent')).resolves.toBeUndefined()
})
it('denies ordinary admission writers, rolls back failed approvals and rejects a missing-field sealed receipt', async () => {
  const a = await admissionFixture()
  await expect(new RestoreAdmissionMaintenance(pg.db).approve(a.input)).rejects.toThrow(
    'maintenance_denied'
  )
  await login('autoreply_app')
  await expect(new RestoreAdmissionMaintenance(pg.db).approve(a.input)).rejects.toThrow(
    'maintenance_denied'
  )
  await expect(
    pg.sql.query('INSERT INTO ledger_restore_admissions(tenant_id) VALUES($1)', ['tenant'])
  ).rejects.toThrow()
  await owner(`CREATE OR REPLACE FUNCTION admission_audit_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='ledger_restore_admission_approved' THEN RAISE EXCEPTION 'synthetic_admission_audit_failure';END IF;RETURN NEW;END $$;
    CREATE TRIGGER admission_audit_fault BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION admission_audit_fault()`)
  try {
    await expect(a.approve()).rejects.toThrow('synthetic_admission_audit_failure')
    expect(
      (await ownerQuery<{ n: number }>('SELECT count(*)::int AS n FROM ledger_restore_admissions'))
        .rows[0].n
    ).toBe(0)
    expect(
      (
        await ownerQuery<{ n: number }>(
          'SELECT count(*)::int AS n FROM ledger_restore_admission_cases'
        )
      ).rows[0].n
    ).toBe(0)
  } finally {
    await owner(
      'DROP TRIGGER admission_audit_fault ON audit_events;DROP FUNCTION admission_audit_fault()'
    )
  }
  await a.approve()
  // Root fault injection preserves the storage seal, isolating required-field validation.
  await owner('DROP TRIGGER restore_history_immutable ON ledger_restore_admissions')
  try {
    await owner("UPDATE ledger_restore_admissions SET receipt_json=receipt_json-'automaticStart'")
    await owner(
      "UPDATE ledger_restore_admissions SET storage_hash=encode(sha256(convert_to(jsonb_build_object('request',request_json,'receipt',receipt_json)::text,'UTF8')),'hex')"
    )
    expect(
      (
        await ownerQuery<{ current: boolean }>(
          "SELECT restore_admission_current('tenant','account','agent') AS current"
        )
      ).rows[0].current
    ).toBe(false)
    await expect(
      owner("UPDATE accounts SET paused=false WHERE tenant_id='tenant' AND id='account'")
    ).rejects.toThrow('ledger_restore_review_pending')
  } finally {
    await owner(
      'CREATE TRIGGER restore_history_immutable BEFORE UPDATE OR DELETE ON ledger_restore_admissions FOR EACH ROW EXECUTE FUNCTION restore_history_immutable()'
    )
  }
})
it('audits every restore case rather than treating one completed declaration as account admission', async () => {
  const c = await completionDeclarationFixture(undefined, false)
  await c.service.acknowledge(credential, c.input)
  await login()
  const first = await admin.restoreCompletionAudit('tenant', 'account')
  expect(first).toMatchObject({
    readyCases: 1,
    pendingCases: 0,
    allCasesPrepared: true,
    canRelease: false
  })
  expect(first.cases[0]).toMatchObject({
    completionId: c.input.completionId,
    state: 'ready_for_independent_review'
  })
  const descriptor = { ...f.required.manifest.context, restoreId: randomUUID() }
  const fields = Object.fromEntries(
    Object.entries(descriptor).filter(([key]) => key !== 'contextHash')
  )
  await admin.openRestoreReview('tenant', 'account', {
    agentId: 'agent',
    context: { ...fields, contextHash: hashContext(fields) }
  })
  const second = await admin.restoreCompletionAudit('tenant', 'account')
  expect(second).toMatchObject({
    readyCases: 1,
    pendingCases: 1,
    allCasesPrepared: false,
    canRelease: false
  })
  expect(second.cases).toHaveLength(2)
  expect(second.basisHash).not.toBe(first.basisHash)
  expect(second.cases.some((v) => v.state === 'awaiting_authorization')).toBe(true)
  await expect(admin.resume('tenant', 'account')).rejects.toThrow('UNRESOLVED_RESTORE')
})
it('does not retain an earlier ready sample if the authorization expires before the complete audit finishes', async () => {
  const c = await completionDeclarationFixture(undefined, false)
  await c.service.acknowledge(credential, c.input)
  await login()
  const result = await pg.db.transaction('tenant', async (db) => {
    await db.query("SELECT id FROM accounts WHERE tenant_id='tenant' AND id='account' FOR UPDATE")
    const clockAtFinish = new Proxy(db, {
      get(target, key) {
        if (key !== 'query') return Reflect.get(target, key)
        return async (sql: string, values?: unknown[]) => {
          const value = await target.query(sql, values)
          // Synthetic final-clock boundary; all original SQL/evidence checks remain real.
          return sql.endsWith('AS completed_at')
            ? { ...value, rows: [{ completed_at: String(c.p.authorization.expiresAt) }] }
            : value
        }
      }
    })
    return readRestoreCompletionAudit(
      clockAtFinish,
      { tenant_id: 'tenant', actor_id: 'admin' },
      'account'
    )
  })
  expect(result).toMatchObject({
    readyCases: 0,
    pendingCases: 1,
    preparedUntil: null,
    allCasesPrepared: false,
    canRelease: false
  })
  expect(result.cases[0].state).toBe('awaiting_current_evidence')
})
it('rejects corrupted original completion evidence during the account-wide audit', async () => {
  const c = await completionDeclarationFixture(undefined, false)
  await c.service.acknowledge(credential, c.input)
  await owner('DROP TRIGGER restore_history_immutable ON ledger_restore_recovery_completions')
  await owner('UPDATE ledger_restore_recovery_completions SET request_hash=$1', ['f'.repeat(64)])
  await login()
  await expect(admin.restoreCompletionAudit('tenant', 'account')).rejects.toThrow(
    'RESTORE_COMPLETION_AUDIT_CONFLICT'
  )
})
it('exposes only authenticated complete account audit metadata through the strict admin command', async () => {
  const command = parseAdminCommand([
    'restore-completion-audit',
    '--tenant',
    'tenant',
    '--account',
    'account'
  ])
  const result = await executeAdminCommand(admin, command, async () => {
    throw Error('unexpected_file_read')
  })
  expect(result).toMatchObject({
    readyCases: 0,
    pendingCases: 1,
    allCasesPrepared: false,
    canRelease: false
  })
  for (const option of ['--case', '--limit', '--after'])
    expect(() =>
      parseAdminCommand([
        'restore-completion-audit',
        '--tenant',
        'tenant',
        '--account',
        'account',
        option,
        '50'
      ])
    ).toThrow()
  await login('autoreply_app')
  await expect(
    executeAdminCommand(admin, command, async () => {
      throw Error('unexpected_file_read')
    })
  ).rejects.toThrow('DENIED')
})
it('returns an exact already committed declaration after real expiry without pretending the original approval is current', async () => {
  // Allow the SQL review to finish before expiry, then still wait for and
  // assert genuine database-clock expiry rather than substituting a fake clock.
  const c = await completionDeclarationFixture(10000, false),
    ack = await c.service.acknowledge(credential, c.input),
    a = c.p.authorization
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, a.expiresAt - Date.now() + 20)))
  const now = Number(
    (
      await pg.sql.query<{ now: string }>(
        'SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now'
      )
    ).rows[0].now
  )
  expect(now).toBeGreaterThanOrEqual(a.expiresAt)
  await expect(
    new RestoreRecoveryAuthority(c.authority).latest(credential, {
      caseId: a.caseId,
      restoreId: a.restoreId,
      contextHash: a.contextHash
    })
  ).rejects.toThrow('RESTORE_RECOVERY_TARGET_NOT_READY')
  expect(await c.service.acknowledge(credential, c.input)).toEqual(ack)
  expect(ack.canRelease).toBe(false)
})
it('rolls back failed central audit and rejects incomplete provenance or revoked source before the first durable declaration', async () => {
  const c = await completionDeclarationFixture(),
    bad = structuredClone(c.input)
  bad.provenance[0].contextHash = 'f'.repeat(64)
  await expect(c.service.acknowledge(credential, bad)).rejects.toThrow(
    'RESTORE_COMPLETION_CONFLICT'
  )
  await owner(`CREATE OR REPLACE FUNCTION completion_audit_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='ledger_restore_durable_recovery_recorded' THEN RAISE EXCEPTION 'synthetic_completion_audit_failure';END IF;RETURN NEW;END $$;
    CREATE TRIGGER completion_audit_fault BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION completion_audit_fault()`)
  try {
    await login('autoreply_app')
    await expect(c.service.acknowledge(credential, c.input)).rejects.toThrow(
      'synthetic_completion_audit_failure'
    )
    expect(
      (
        await ownerQuery<{ n: number }>(
          'SELECT count(*)::int AS n FROM ledger_restore_recovery_completions'
        )
      ).rows[0].n
    ).toBe(0)
  } finally {
    await owner('DROP TRIGGER completion_audit_fault ON audit_events')
  }
  await asMaintenance((m) =>
    m.revoke({
      registrationId: randomUUID(),
      publicKeyPem: c.input.observationGrant.sourceTrust.publicKeyPem,
      reasonSha256: 'c'.repeat(64),
      reviewerId: 'synthetic-reviewer',
      reviewedAt: Date.now()
    })
  )
  await login('autoreply_app')
  await expect(c.service.acknowledge(credential, c.input)).rejects.toThrow(
    'RESTORE_COMPLETION_NOT_READY'
  )
})
it('connects production HTTP declaration transport and enforces response binding and revoked credentials', async () => {
  const c = await completionDeclarationFixture(),
    server = createServer(
      createApplication(c.authority, { restoration: new RestorePauseAuthority(c.authority) })
    ),
    origin = await listenFetchLoopback(server),
    client = new AgentRegistration(
      {
        load: () => ({
          serverUrl: origin,
          encryptedCredential: 'synthetic',
          scope: c.p.authorization.scope
        }),
        save: () => {
          throw Error('unexpected_write')
        }
      },
      { available: () => true, encrypt: () => '', decrypt: () => credential },
      fetch,
      true
    )
  try {
    const ack = await client.acknowledgeRestoreRecovery(c.input, c.p.authorization.scope)
    expect(await client.acknowledgeRestoreRecovery(c.input, c.p.authorization.scope)).toEqual(ack)
    const unauthorized = await fetch(origin + '/v1/restorations/recovery/acknowledge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(c.input)
    })
    expect(unauthorized.status).toBe(401)
    await owner(
      "UPDATE agents SET revoked_at=clock_timestamp() WHERE tenant_id='tenant' AND id='agent'"
    )
    await login('autoreply_app')
    await expect(
      client.acknowledgeRestoreRecovery(c.input, c.p.authorization.scope)
    ).rejects.toThrow('AUTHORIZATION_FAILED')
  } finally {
    const closed = new Promise<void>((r) => server.close(() => r()))
    server.closeAllConnections()
    await closed
  }
})
it('requires independent ordered-source maintenance evidence before giving a target an observation grant', async () => {
  const r = await recoveryApprovalFixture(false),
    approved = await r.approve(),
    a = approved.receipt,
    service = new RestoreRecoveryAuthority(new AccountAuthority(pg.db)),
    input = {
      caseId: a.caseId,
      restoreId: a.restoreId,
      contextHash: a.contextHash,
      authorizationId: a.authorizationId
    }
  await login('autoreply_app')
  await expect(service.observationGrant(credential, input)).rejects.toThrow(
    'RESTORE_RECOVERY_TARGET_NOT_READY'
  )
})
it('transports a narrowly bound public-key observation grant without releasing the account and rechecks credential revocation', async () => {
  requirement.sourceTrust = {
    ...requirement.sourceTrust,
    stableSourceOrderVerified: true,
    sourceOrderVerificationSha256: 'b'.repeat(64)
  }
  const r = await recoveryApprovalFixture(false),
    approved = await r.approve(),
    a = approved.receipt,
    input = {
      caseId: a.caseId,
      restoreId: a.restoreId,
      contextHash: a.contextHash,
      authorizationId: a.authorizationId
    }
  await login('autoreply_app')
  const authority = new AccountAuthority(pg.db),
    service = new RestoreRecoveryAuthority(authority),
    boundary = await service.latest(credential, {
      caseId: a.caseId,
      restoreId: a.restoreId,
      contextHash: a.contextHash
    }),
    server = createServer(
      createApplication(authority, { restoration: new RestorePauseAuthority(authority) })
    ),
    origin = await listenFetchLoopback(server),
    client = new AgentRegistration(
      {
        load: () => ({ serverUrl: origin, encryptedCredential: 'synthetic', scope: a.scope }),
        save: () => {
          throw Error('unexpected_write')
        }
      },
      { available: () => true, encrypt: () => '', decrypt: () => credential },
      fetch,
      true
    )
  try {
    const grant = await client.restoreObservationGrant(input, boundary)
    expect(parseRestoreObservationGrant(grant, boundary)).toEqual(grant)
    expect(grant.sourceTrust.publicKeyPem).toBe(f.trust.publicKeyPem)
    expect(JSON.stringify(grant)).not.toContain('PRIVATE KEY')
    expect(grant).toMatchObject({ canRelease: false, automaticStart: false })
    await expect(
      service.observationGrant(credential, { ...input, authorizationId: randomUUID() })
    ).rejects.toThrow('RESTORE_RECOVERY_TARGET_CONFLICT')
    await expect(
      service.observationGrant(credential, { ...input, canRelease: true })
    ).rejects.toThrow()
    expect((await pg.sql.query('SELECT current_user AS role')).rows[0]).toEqual({
      role: 'autoreply_app'
    })
    const unauthorized = await fetch(origin + '/v1/restorations/recovery/observation-grant', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input)
    })
    expect(unauthorized.status).toBe(401)
    await asMaintenance((m) =>
      m.revoke({
        registrationId: randomUUID(),
        publicKeyPem: grant.sourceTrust.publicKeyPem,
        reasonSha256: 'c'.repeat(64),
        reviewerId: 'synthetic-reviewer',
        reviewedAt: Date.now()
      })
    )
    await login('autoreply_app')
    await expect(service.observationGrant(credential, input)).rejects.toThrow(
      'RESTORE_RECOVERY_TARGET_NOT_READY'
    )
    await owner(
      "UPDATE agents SET revoked_at=clock_timestamp() WHERE tenant_id='tenant' AND id='agent'"
    )
    await login('autoreply_app')
    await expect(client.restoreObservationGrant(input, boundary)).rejects.toThrow(
      'AUTHORIZATION_FAILED'
    )
  } finally {
    const closed = new Promise<void>((r) => server.close(() => r()))
    server.closeAllConnections()
    await closed
  }
})
it('narrows target SQL reads without inheriting protected facts, exposing global keys or granting recovery writes', async () => {
  const r = await recoveryApprovalFixture(false),
    approved = await r.approve()
  await login('autoreply_app')
  await expect(
    pg.sql.query('SELECT * FROM ledger_restore_recovery_authorizations')
  ).rejects.toThrow('permission denied')
  await pg.db.transaction('tenant', async (db) => {
    await db.query(
      "SELECT set_config('app.restore_read_credential_hash',$1,true),set_config('app.restore_read_case_id',$2,true),set_config('app.restore_account_id','account',true)",
      [tokenHash(credential), r.input.caseId]
    )
    await db.query('SET LOCAL ROLE autoreply_restore_reader')
    expect(
      (await db.query('SELECT authorization_id FROM ledger_restore_recovery_authorizations')).rows
    ).toEqual([{ authorization_id: approved.receipt.authorizationId }])
    expect(
      (
        await db.query(
          'SELECT id FROM ledger_restore_history_requirements WHERE case_id<>$1::uuid',
          [r.input.caseId]
        )
      ).rows
    ).toEqual([])
    await db.query("SELECT set_config('app.restore_read_case_id',$1,true)", [randomUUID()])
    for (const table of [
      'ledger_restore_history_requirements',
      'ledger_restore_history_proofs',
      'ledger_restore_execution_reviews',
      'ledger_restore_recovery_authorizations',
      'reconciliation_cases',
      'execution_request_seals'
    ])
      expect((await db.query('SELECT 1 FROM ' + table)).rows).toEqual([])
  })
  for (const query of [
    'SELECT * FROM restore_history_key_revocations',
    'SELECT * FROM restore_history_maintenance_records',
    'SELECT token_hash FROM agents',
    "UPDATE ledger_restore_recovery_authorizations SET recorded_by='forged'",
    'DELETE FROM ledger_restore_recovery_authorizations'
  ]) {
    await pg.db.transaction('tenant', async (db) => {
      await db.query('SET LOCAL ROLE autoreply_restore_reader')
      await expect(db.query(query)).rejects.toThrow('permission denied')
    })
  }
  await pg.db.transaction('tenant', async (db) => {
    await db.query('SET LOCAL ROLE autoreply_restore_reader')
    await expect(
      db.query('SELECT * FROM autoreply.restore_recovery_key_revocation($1)', ['a'.repeat(64)])
    ).rejects.toThrow('restore_reader_denied')
  })
})
it('refuses a once-approved package after independent resolution damage or source-key revocation', async () => {
  const r = await recoveryApprovalFixture(),
    approved = await r.approve(),
    input = {
      caseId: r.input.caseId,
      restoreId: approved.receipt.restoreId,
      contextHash: approved.receipt.contextHash
    },
    service = new RestoreRecoveryAuthority(new AccountAuthority(pg.db))
  await ownerQuery("UPDATE reconciliation_applied SET decision_hash=$1 WHERE tenant_id='tenant'", [
    'f'.repeat(64)
  ])
  await login('autoreply_app')
  await expect(service.latest(credential, input)).rejects.toThrow(
    'RESTORE_RECOVERY_TARGET_NOT_READY'
  )
  // Restore the exact original decision binding, then test revocation independently.
  const decision = (
    await ownerQuery<{ decision_json: unknown }>(
      'SELECT decision_json FROM reconciliation_decisions'
    )
  ).rows[0].decision_json
  await ownerQuery('UPDATE reconciliation_applied SET decision_hash=$1 WHERE tenant_id=$2', [
    hashContext(decision),
    'tenant'
  ])
  await asMaintenance((m) =>
    m.revoke({
      registrationId: randomUUID(),
      publicKeyPem: requirement.sourceTrust.publicKeyPem,
      reasonSha256: '9'.repeat(64),
      reviewerId: 'synthetic-reviewer',
      reviewedAt: Date.now()
    })
  )
  await login('autoreply_app')
  await expect(service.latest(credential, input)).rejects.toThrow(
    'RESTORE_RECOVERY_TARGET_NOT_READY'
  )
})
it('returns an authentic terminal hash reference without fabricating the original receipt body or granting physical verification', async () => {
  const r = await recoveryApprovalFixture(true, 0, true),
    approved = await r.approve(),
    a = approved.receipt,
    service = new RestoreRecoveryAuthority(new AccountAuthority(pg.db))
  await login('autoreply_app')
  const result = await service.resolutions(credential, {
    caseId: a.caseId,
    restoreId: a.restoreId,
    contextHash: a.contextHash,
    authorizationId: a.authorizationId
  })
  expect(result.records).toHaveLength(1)
  expect(result.records[0]).toMatchObject({
    kind: 'terminal_reference',
    permit: { status: 'confirmed', newlyIssued: false },
    fact: { status: 'confirmed' }
  })
  expect(result.records[0]).not.toHaveProperty('receipt')
  expect(result.reviewReceipt.physicalOutcomeVerifiedByThisCommand).toBe(false)
  expect(result.canRelease).toBe(false)
})
it('delivers exact original independent resolution records to the authenticated target without modifying the old unknown permit', async () => {
  const r = await recoveryApprovalFixture(),
    approved = await r.approve(),
    a = approved.receipt,
    input = {
      caseId: a.caseId,
      restoreId: a.restoreId,
      contextHash: a.contextHash,
      authorizationId: a.authorizationId
    },
    service = new RestoreRecoveryAuthority(new AccountAuthority(pg.db))
  await login('autoreply_app')
  const boundary = await service.latest(credential, {
      caseId: a.caseId,
      restoreId: a.restoreId,
      contextHash: a.contextHash
    }),
    result = await service.resolutions(credential, input)
  expect(parseRestoreResolutionPackage(result, boundary)).toEqual(result)
  expect(result.records).toHaveLength(1)
  const record = result.records[0]
  expect(record.kind).toBe('reconciled')
  if (record.kind !== 'reconciled') throw Error('fixture_record')
  if (record.report.observation.status !== 'confirmed') throw Error('fixture_outcome')
  expect(record.report.observation.sourceMessageId).toBe('synthetic-automation-outbound')
  expect(record.fact.decisionHash).toBe(hashContext(record.decision))
  expect(result).toMatchObject({ canRelease: false, automaticStart: false })
  expect(result.localExecutions).toEqual([])
  expect(JSON.stringify(result)).not.toContain('publicKeyPem')
  await expect(
    service.resolutions(credential, { ...input, authorizationId: randomUUID() })
  ).rejects.toThrow('RESTORE_RECOVERY_TARGET_CONFLICT')
  await expect(service.resolutions(credential, { ...input, canRelease: true })).rejects.toThrow()
  expect(
    (await pg.db.pool.query<{ role: string }>('SELECT current_user AS role')).rows[0].role
  ).toBe('autoreply_app')
  const state = await ownerQuery<{ status: string }>('SELECT status FROM execution_permits')
  expect(state.rows[0].status).toBe('unknown')
  await ownerQuery("UPDATE reconciliation_applied SET decision_hash=$1 WHERE tenant_id='tenant'", [
    'f'.repeat(64)
  ])
  await login('autoreply_app')
  await expect(service.resolutions(credential, input)).rejects.toThrow(
    'RESTORE_RECOVERY_TARGET_NOT_READY'
  )
})
it('connects the production resolution route to ordinary credential transport and preserves authentication and strict request limits', async () => {
  const r = await recoveryApprovalFixture(),
    approved = await r.approve(),
    a = approved.receipt,
    input = {
      caseId: a.caseId,
      restoreId: a.restoreId,
      contextHash: a.contextHash,
      authorizationId: a.authorizationId
    }
  await login('autoreply_app')
  const authority = new AccountAuthority(pg.db),
    service = new RestoreRecoveryAuthority(authority),
    boundary = await service.latest(credential, {
      caseId: a.caseId,
      restoreId: a.restoreId,
      contextHash: a.contextHash
    }),
    server = createServer(
      createApplication(authority, { restoration: new RestorePauseAuthority(authority) })
    ),
    origin = await listenFetchLoopback(server),
    client = new AgentRegistration(
      {
        load: () => ({ serverUrl: origin, encryptedCredential: 'synthetic', scope: a.scope }),
        save: () => {
          throw Error('unexpected_write')
        }
      },
      { available: () => true, encrypt: () => '', decrypt: () => credential },
      fetch,
      true
    )
  try {
    const result = await client.restoreExecutionResolutions(input, boundary)
    expect(result.records[0].kind).toBe('reconciled')
    const unauthorized = await fetch(origin + '/v1/restorations/recovery/resolutions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input)
    })
    expect(unauthorized.status).toBe(401)
    const invalid = await fetch(origin + '/v1/restorations/recovery/resolutions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + credential },
      body: JSON.stringify({ ...input, path: 'private.sqlite' })
    })
    expect(invalid.status).toBe(400)
    await ownerQuery(
      "UPDATE agents SET revoked_at=clock_timestamp() WHERE tenant_id='tenant' AND id='agent'"
    )
    await login('autoreply_app')
    await expect(client.restoreExecutionResolutions(input, boundary)).rejects.toThrow(
      'AUTHORIZATION_FAILED'
    )
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()))
    server.closeAllConnections()
    await closed
  }
})
it('transports a complete history larger than the ordinary response limit through actual HTTP and the bound main-process client', async () => {
  const r = await recoveryApprovalFixture(false, 600),
    approved = await r.approve(),
    scope = f.proof.scope,
    input = {
      caseId: r.input.caseId,
      restoreId: approved.receipt.restoreId,
      contextHash: approved.receipt.contextHash
    }
  await login('autoreply_app')
  const authority = new AccountAuthority(pg.db),
    server = createServer(
      createApplication(authority, { restoration: new RestorePauseAuthority(authority) })
    ),
    origin = await listenFetchLoopback(server)
  const client = new AgentRegistration(
    {
      load: () => ({ serverUrl: origin, encryptedCredential: 'synthetic', scope }),
      save: () => {
        throw Error('unexpected_write')
      }
    },
    { available: () => true, encrypt: () => '', decrypt: () => credential },
    fetch,
    true
  )
  try {
    const result = await client.restoreLatestRecoveryBoundary(input, scope)
    expect(result.authorization).toEqual(approved.receipt)
    expect(result.boundary.history).toEqual(f.proof)
    expect(Buffer.byteLength(JSON.stringify(result))).toBeGreaterThan(65536)
    const unauthorized = await fetch(origin + '/v1/restorations/recovery/current', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input)
    })
    expect(unauthorized.status).toBe(401)
    const invalid = await fetch(origin + '/v1/restorations/recovery/current', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + credential },
      body: JSON.stringify({ ...input, path: 'private.sqlite' })
    })
    expect(invalid.status).toBe(400)
    await expect(
      client.restoreLatestRecoveryBoundary(input, { ...scope, account_id: 'other' })
    ).rejects.toThrow('DEVICE_SCOPE_CHANGED')
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()))
    server.closeAllConnections()
    await closed
  }
})
it('rejects self-consistent foreign response bindings and streamed oversized recovery packages before local use', async () => {
  const r = await recoveryApprovalFixture(false),
    approved = await r.approve(),
    scope = f.proof.scope,
    input = {
      caseId: r.input.caseId,
      restoreId: approved.receipt.restoreId,
      contextHash: approved.receipt.contextHash
    }
  await login('autoreply_app')
  const original = await new RestoreRecoveryAuthority(new AccountAuthority(pg.db)).latest(
    credential,
    input
  )
  let returned = JSON.stringify(original),
    requests = 0
  const client = new AgentRegistration(
    {
      load: () => ({ serverUrl: 'http://127.0.0.1:4782', encryptedCredential: 'synthetic', scope }),
      save: () => {
        throw Error('unexpected_write')
      }
    },
    { available: () => true, encrypt: () => '', decrypt: () => credential },
    async () => {
      requests++
      return new Response(returned, { status: 200 })
    },
    true
  )
  const foreign = structuredClone(original)
  foreign.authorization.caseId = randomUUID()
  foreign.boundary.history.caseId = foreign.authorization.caseId
  foreign.authorization.boundaryHash = hashContext(foreign.boundary)
  returned = JSON.stringify(foreign)
  await expect(client.restoreLatestRecoveryBoundary(input, scope)).rejects.toThrow(
    'INVALID_RESPONSE'
  )
  returned = ' '.repeat(2097153)
  await expect(client.restoreLatestRecoveryBoundary(input, scope)).rejects.toThrow('UNAVAILABLE')
  expect(requests).toBe(2)
  await expect(
    client.restoreLatestRecoveryBoundary(input, { ...scope, agent_id: 'other' })
  ).rejects.toThrow('DEVICE_SCOPE_CHANGED')
  expect(requests).toBe(2)
})
beforeAll(async () => {
  pg = await embeddedPostgres()
  await owner(
    'CREATE ROLE history_records_admin LOGIN NOSUPERUSER NOBYPASSRLS;GRANT autoreply_admin TO history_records_admin'
  )
  admin = new Administration(pg.db)
}, 20000)
afterAll(async () => {
  await pg?.db.close()
})
beforeEach(async () => {
  await owner(`DROP TRIGGER IF EXISTS history_audit_fault ON audit_events;TRUNCATE tenants CASCADE;TRUNCATE restore_history_key_revocations;
   INSERT INTO tenants(id,name) VALUES('tenant','synthetic'),('foreign','synthetic');
   INSERT INTO employees(tenant_id,id,role) VALUES('tenant','employee','employee'),('tenant','admin','admin');
   INSERT INTO admin_database_principals(login_name,tenant_id,employee_id) VALUES('history_records_admin','tenant','admin');
   INSERT INTO accounts(tenant_id,id,employee_id,platform,paused) VALUES('tenant','account','employee','wechat',false),('tenant','other','employee','wechat',true);
   INSERT INTO agents(tenant_id,id,account_id,employee_id,token_hash) VALUES('tenant','agent','account','employee','${tokenHash(credential)}');
   DROP TRIGGER IF EXISTS restore_history_immutable ON ledger_restore_history_proofs;
   CREATE TRIGGER restore_history_immutable BEFORE UPDATE OR DELETE ON ledger_restore_history_proofs FOR EACH ROW EXECUTE FUNCTION restore_history_immutable();
   DROP TRIGGER IF EXISTS restore_history_immutable ON ledger_restore_execution_reviews;
   CREATE TRIGGER restore_history_immutable BEFORE UPDATE OR DELETE ON ledger_restore_execution_reviews FOR EACH ROW EXECUTE FUNCTION restore_history_immutable();
   DROP TRIGGER IF EXISTS restore_history_immutable ON ledger_restore_recovery_authorizations;
   CREATE TRIGGER restore_history_immutable BEFORE UPDATE OR DELETE ON ledger_restore_recovery_authorizations FOR EACH ROW EXECUTE FUNCTION restore_history_immutable();
   DROP TRIGGER IF EXISTS restore_history_immutable ON ledger_restore_recovery_completions;
   CREATE TRIGGER restore_history_immutable BEFORE UPDATE OR DELETE ON ledger_restore_recovery_completions FOR EACH ROW EXECUTE FUNCTION restore_history_immutable();`)
  f = historyFixture()
  const review = await admin.openRestoreReview('tenant', 'account', {
    agentId: 'agent',
    context: f.required.manifest.context
  })
  f.required.caseId = review.caseId
  f.proof.caseId = review.caseId
  await login('autoreply_app')
  const service = new RestorePauseAuthority(new AccountAuthority(pg.db))
  const challenge = await service.challenge(credential, {
    caseId: review.caseId,
    requestId: randomUUID(),
    restoreId: review.restoreId,
    contextHash: review.contextHash
  })
  const now = Date.now()
  await service.report(credential, {
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
  const upload = await service.inventoryStart(credential, {
    caseId: review.caseId,
    requestId: randomUUID(),
    challengeId: challenge.challengeId,
    manifest: f.required.manifest
  })
  await service.inventoryPage(credential, {
    uploadId: upload.uploadId,
    index: 0,
    items: f.required.items
  })
  await service.inventoryComplete(credential, { uploadId: upload.uploadId, pageCount: 1 })
  f.required.uploadId = upload.uploadId
  f.proof.uploadId = upload.uploadId
  await login()
  const assessment = await admin.restoreAssessment(
    'tenant',
    'account',
    review.caseId,
    upload.uploadId
  )
  const at = Date.now()
  f.trust.notBefore = at - 60000
  f.trust.notAfter = at + 86400000
  requirement = RestoreHistoryRequirementRecordSchema.parse({
    formatVersion: 1,
    requirementId: randomUUID(),
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
  await installRequirement()
  const captured = Date.now()
  f.now = captured
  f.proof.observedThrough = captured
  f.proof.capturedAt = captured
})

it('authenticates and saves one exact receipt/audit, reads and retries without re-submitting authority', async () => {
  const value = await record()
  expect(value).toMatchObject({
    receipt: {
      recordedBy: 'admin',
      canRelease: false,
      automaticStart: false,
      checked: {
        sourceClaimAuthenticated: true,
        physicalHistoryVerifiedByThisCheck: false,
        executionOutcomesVerified: false
      }
    },
    current: { state: 'current', canRelease: false },
    canRelease: false
  })
  expect((await read()).receipt).toEqual(value.receipt)
  expect((await record()).receipt).toEqual(value.receipt)
  expect(
    (
      await ownerQuery<{ n: number }>(
        'SELECT count(*)::int AS n FROM ledger_restore_history_proofs'
      )
    ).rows[0].n
  ).toBe(1)
  expect(
    (
      await ownerQuery<{ n: number }>(
        "SELECT count(*)::int AS n FROM audit_events WHERE kind='ledger_restore_history_recorded'"
      )
    ).rows[0].n
  ).toBe(1)
  expect(JSON.stringify(value)).not.toContain('old-message')
  await expect(admin.resume('tenant', 'account')).rejects.toThrow('UNRESOLVED_RESTORE')
})
it('rejects mutated original content, replacement requirements and wrong route bindings under an existing proof ID', async () => {
  await record()
  f.proof.conversations[0].messages[1].contentHash = '3'.repeat(64)
  await expect(record()).rejects.toThrow('RESTORE_HISTORY_CONFLICT')
  await expect(
    admin.recordRestoreHistoryProof(
      'tenant',
      'account',
      randomUUID(),
      f.required.uploadId,
      submission()
    )
  ).rejects.toThrow('RESTORE_HISTORY_CONFLICT')
  await expect(
    admin.recordRestoreHistoryProof(
      'tenant',
      'account',
      f.required.caseId,
      randomUUID(),
      submission()
    )
  ).rejects.toThrow('RESTORE_HISTORY_CONFLICT')
  expect(
    (
      await ownerQuery<{ n: number }>(
        'SELECT count(*)::int AS n FROM ledger_restore_history_proofs'
      )
    ).rows[0].n
  ).toBe(1)
})
it('will not let a report supply its own trust key, backup time or administrator actor', async () => {
  for (const extra of [{ trust: f.trust }, { backupStartedAt: 1 }, { recordedBy: 'intruder' }])
    await expect(
      admin.recordRestoreHistoryProof('tenant', 'account', f.required.caseId, f.required.uploadId, {
        ...submission(),
        ...extra
      })
    ).rejects.toThrow()
  const missing = { ...submission(), requirementId: randomUUID() }
  await expect(
    admin.recordRestoreHistoryProof(
      'tenant',
      'account',
      f.required.caseId,
      f.required.uploadId,
      missing
    )
  ).rejects.toThrow('RESTORE_HISTORY_NOT_FOUND')
  expect(
    (
      await ownerQuery<{ n: number }>(
        'SELECT count(*)::int AS n FROM ledger_restore_history_proofs'
      )
    ).rows[0].n
  ).toBe(0)
})
it('authenticates before opening CLI evidence and authenticates again before mutation', async () => {
  const command = parseAdminCommand([
    'record-restore-history-proof',
    '--tenant',
    'tenant',
    '--account',
    'account',
    '--case',
    f.required.caseId,
    '--upload',
    f.required.uploadId,
    '--file',
    'synthetic-private.json'
  ])
  await login('autoreply_app')
  const load = vi.fn(async () => submission())
  await expect(executeAdminCommand(admin, command, load)).rejects.toThrow('DENIED')
  expect(load).not.toHaveBeenCalled()
  await login()
  const accepted = await executeAdminCommand(admin, command, async () => submission())
  expect(accepted).toMatchObject({ current: { state: 'current' }, canRelease: false })
  const lookup = parseAdminCommand([
    'restore-history-proof',
    '--tenant',
    'tenant',
    '--account',
    'account',
    '--case',
    f.required.caseId,
    '--proof',
    f.proof.proofId
  ])
  expect(await executeAdminCommand(admin, lookup, load)).toMatchObject({
    receipt: { proofId: f.proof.proofId },
    canRelease: false
  })
  await expect(
    admin.restoreHistoryProof('foreign', 'account', f.required.caseId, f.proof.proofId)
  ).rejects.toThrow('DENIED')
})
it('does not let administrators or devices write maintenance trust, revocations or alter stored proofs', async () => {
  await record()
  await expect(
    pg.sql.query('UPDATE ledger_restore_history_proofs SET receipt_hash=$1', ['3'.repeat(64)])
  ).rejects.toThrow()
  await expect(pg.sql.query('DELETE FROM ledger_restore_history_proofs')).rejects.toThrow()
  await expect(
    pg.sql.query('INSERT INTO restore_history_key_revocations VALUES($1,$2,clock_timestamp())', [
      '3'.repeat(64),
      '4'.repeat(64)
    ])
  ).rejects.toThrow()
  await expect(
    pg.sql.query(
      'INSERT INTO ledger_restore_history_requirements SELECT * FROM ledger_restore_history_requirements'
    )
  ).rejects.toThrow()
  await login('autoreply_app')
  await expect(pg.sql.query('SELECT * FROM ledger_restore_history_proofs')).rejects.toThrow()
  await expect(pg.sql.query('SELECT * FROM ledger_restore_history_requirements')).rejects.toThrow()
})
it('keeps historical receipts on key revocation but refuses new evidence and reports the current source state', async () => {
  const value = await record()
  const key = createPublicKey(f.trust.publicKeyPem).export({ type: 'spki', format: 'der' })
  await owner('INSERT INTO restore_history_key_revocations VALUES($1,$2,$3)', [
    createHash('sha256').update(key).digest('hex'),
    '5'.repeat(64),
    new Date(value.receipt.recordedAt + 1)
  ])
  expect(await read()).toMatchObject({
    receipt: value.receipt,
    current: { state: 'source_revoked' },
    canRelease: false
  })
  expect((await record()).receipt).toEqual(value.receipt)
  f.proof.proofId = randomUUID()
  await expect(record()).rejects.toThrow('RESTORE_HISTORY_NOT_READY')
})
it('does not re-certify old receipts when a newer maintenance requirement supersedes their basis', async () => {
  const value = await record(),
    oldId = requirement.requirementId
  await installRequirement({
    ...requirement,
    requirementId: randomUUID(),
    recordedAt: value.receipt.recordedAt + 1
  })
  expect(await read()).toMatchObject({
    receipt: value.receipt,
    current: { state: 'requirement_superseded' },
    canRelease: false
  })
  expect(requirement.requirementId).toBe(oldId)
  f.proof.proofId = randomUUID()
  await expect(record()).rejects.toThrow('RESTORE_HISTORY_NOT_READY')
})
it('marks the entire basis stale after a central execution absent from the backup and never settles it', async () => {
  const value = await record()
  await owner(
    `INSERT INTO execution_permits(tenant_id,account_id,id,agent_id,lease_version,task_id,draft_hash,status,expires_at) VALUES('tenant','account','late-unknown','agent',1,'synthetic-task',$1,'unknown',clock_timestamp()-interval '1 minute')`,
    ['6'.repeat(64)]
  )
  expect(await read()).toMatchObject({
    receipt: value.receipt,
    current: { state: 'basis_changed' },
    canRelease: false
  })
  expect((await record()).receipt).toEqual(value.receipt)
  f.proof.proofId = randomUUID()
  await expect(record()).rejects.toThrow('RESTORE_HISTORY_NOT_READY')
  expect(
    (
      await ownerQuery<{ status: string }>(
        "SELECT status FROM execution_permits WHERE id='late-unknown'"
      )
    ).rows[0].status
  ).toBe('unknown')
})
it('rolls back evidence together with a failed audit and permits retrying the exact original ID', async () => {
  await owner(`CREATE OR REPLACE FUNCTION history_audit_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='ledger_restore_history_recorded' THEN RAISE EXCEPTION 'synthetic_audit_fault'; END IF; RETURN NEW; END $$;
   CREATE TRIGGER history_audit_fault BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION history_audit_fault()`)
  await expect(record()).rejects.toThrow('synthetic_audit_fault')
  expect(
    (
      await ownerQuery<{ n: number }>(
        'SELECT count(*)::int AS n FROM ledger_restore_history_proofs'
      )
    ).rows[0].n
  ).toBe(0)
  await owner('DROP TRIGGER history_audit_fault ON audit_events')
  expect(await record()).toMatchObject({
    receipt: { proofId: f.proof.proofId },
    current: { state: 'current' }
  })
})
it('rejects a tampered signature and corrupt persisted hashes rather than trusting a stored passed flag', async () => {
  const changed = submission()
  changed.signedProof.signature = 'A'.repeat(86)
  await expect(
    admin.recordRestoreHistoryProof(
      'tenant',
      'account',
      f.required.caseId,
      f.required.uploadId,
      changed
    )
  ).rejects.toThrow('restore_history_signature_invalid')
  await record()
  await owner('DROP TRIGGER restore_history_immutable ON ledger_restore_history_proofs')
  await owner('UPDATE ledger_restore_history_proofs SET receipt_hash=$1', ['7'.repeat(64)])
  await expect(read()).rejects.toThrow('RESTORE_HISTORY_CONFLICT')
})
it('makes maintenance requirements immutable even to the maintenance table owner', async () => {
  await login('postgres')
  await expect(
    pg.sql.query('UPDATE ledger_restore_history_requirements SET recorded_at=clock_timestamp()')
  ).rejects.toThrow('restore_history_immutable')
  await expect(pg.sql.query('DELETE FROM ledger_restore_history_requirements')).rejects.toThrow(
    'restore_history_immutable'
  )
})

it('re-verifies a persisted signature even when an injected passed receipt and all JSON hashes agree', async () => {
  const value = await record(),
    forged = submission()
  forged.signedProof.signature = 'A'.repeat(86)
  const receipt = structuredClone(value.receipt)
  receipt.checked.signedProofHash = hashContext(forged.signedProof)
  await owner('DROP TRIGGER restore_history_immutable ON ledger_restore_history_proofs')
  await owner(
    'UPDATE ledger_restore_history_proofs SET request_json=$1::jsonb,request_hash=$2,receipt_json=$3::jsonb,receipt_hash=$4',
    [JSON.stringify(forged), hashContext(forged), JSON.stringify(receipt), hashContext(receipt)]
  )
  await expect(read()).rejects.toThrow('RESTORE_HISTORY_CONFLICT')
})

it('rejects a CLI mutation if administrator authority is removed after its initial file-read authentication', async () => {
  const command = parseAdminCommand([
    'record-restore-history-proof',
    '--tenant',
    'tenant',
    '--account',
    'account',
    '--case',
    f.required.caseId,
    '--upload',
    f.required.uploadId,
    '--file',
    'synthetic-private.json'
  ])
  await expect(
    executeAdminCommand(admin, command, async () => {
      await owner("UPDATE employees SET enabled=false WHERE tenant_id='tenant' AND id='admin'")
      return submission()
    })
  ).rejects.toThrow('DENIED')
  expect(
    (
      await ownerQuery<{ n: number }>(
        'SELECT count(*)::int AS n FROM ledger_restore_history_proofs'
      )
    ).rows[0].n
  ).toBe(0)
})
