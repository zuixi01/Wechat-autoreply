import { randomUUID } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { runJevReplayCommand } from '../../server/scripts/jev-replay'
import { hashContext } from '../../src/core/reply/hashes'
import { Postgres } from '../../server/src/database/postgres'
import { Administration } from '../../server/src/admin/administration'
import { JevBlindPacketSeals } from '../../server/src/generation/jev-blind-packet-seals'
import { PublicationSchema, type Publication } from '../../server/src/generation/publication'
import { textGeneratorVersion } from '../../server/src/generation/text-generator'
import { replayCaseInputHash } from '../../evals/jev/replay-input'
import { BlindLabelsSchema, PrivateBlindReviewPacketSchema } from '../../evals/jev/blind-review'
import { JevReplayArtifactManifestSchema } from '../../evals/jev/private-artifacts'
import type { JevReplayArmArtifact } from '../../evals/jev/replay'
import { createPrivateOutput, writePrivateJson } from '../../evals/memory/private-files'
import { verifyPrivatePaths } from '../../src/core/persistence/private-backup-directory'
import { embeddedPostgres } from '../fixtures/embedded-postgres'

// Synthetic protocol and ACL fixtures. These are not independent business accuracy evidence.
const id = randomUUID(),
  login = `jev_command_${id.replaceAll('-', '')}`,
  reviewerLogin = `jev_reviewer_${id.replaceAll('-', '')}`
const directory = resolve('.local', `jev-command-${id}`)
const text = {
  baseUrl: 'https://text.invalid/v1/',
  model: 'text-request',
  expectedModel: 'text-resolved'
}
const version = textGeneratorVersion(text)
const environment = {
  ADMIN_DATABASE_URL: 'synthetic-embedded-administrator',
  JEV_API_KEY: 'synthetic-jev-key',
  TEXT_MODEL_API_KEY: 'synthetic-text-key',
  TEXT_MODEL_BASE_URL: text.baseUrl,
  TEXT_MODEL_ID: text.model,
  TEXT_MODEL_EXPECTED_ID: text.expectedModel
}
// No administrator connection or model configuration is supplied to the reviewer command.
const reviewerEnvironment = { REVIEW_DATABASE_URL: 'synthetic-embedded-reviewer' }
const allCases = Array.from({ length: 300 }, (_, i) => ({
  caseId: `case-${i}`,
  conversationGroup: `conversation-${i}`,
  split: i < 100 ? ('calibration' as const) : ('holdout' as const),
  conversationId: 'customer-A',
  inbound: ['请转人工客服']
}))
const planFor = (cases: typeof allCases) => ({
  datasetId: 'synthetic-command',
  replayProtocol: 'jev-abc-v1' as const,
  currency: 'CNY' as const,
  maximumTurnCostMicros: 10000,
  maximumP95LatencyMs: 1000,
  assignments: cases.map(({ caseId, conversationGroup, split, ...rest }) => ({
    caseId,
    conversationGroup,
    split,
    inputHash: replayCaseInputHash({ caseId, conversationGroup, split, ...rest })
  }))
})
const input = {
  datasetId: 'synthetic-command',
  split: 'calibration',
  cases: allCases.slice(0, 100)
}
const inputPath = join(directory, 'inputs.private.json'),
  priorsPath = join(directory, 'priors.private.json')
const planPath = join(directory, 'plan', 'plan.private.json'),
  executePath = join(directory, 'execute')
const blindPath = join(directory, 'blind'),
  importPath = join(directory, 'import')
const artifactsPath = join(executePath, 'artifacts.manifest.private.json')
const aggregatePath = join(executePath, 'artifacts.private.json')
const packetPath = join(blindPath, 'sealed-mapping.private.json')
const labelsPath = join(directory, 'independent-labels.private.json'),
  reviewPath = join(directory, 'review')
const calibrationSettingsPath = join(directory, 'calibration-settings.private.json')
let labels: ReturnType<typeof BlindLabelsSchema.parse>
let reviewReceipt: {
  reviewId: string
  packetId: string
  packetHash: string
  labelsHash: string
  reviewerId: string
  revision: number
  reviewedAt: string
  centralReviewVerified: true
  releaseAuthorized: false
}
let pg: Awaited<ReturnType<typeof embeddedPostgres>>,
  admin: Administration,
  publication: Publication
let runId: string, planCode: number, limitCode: number, executeCode: number, blindCode: number
let globalNetwork: ReturnType<typeof vi.spyOn>
const close = vi.fn(async () => {})
const connect = vi.fn((connection: string): Postgres => {
  expect([environment.ADMIN_DATABASE_URL, reviewerEnvironment.REVIEW_DATABASE_URL]).toContain(
    connection
  )
  return Object.assign(Object.create(pg.db), { close }) as Postgres
})
const forbiddenNetwork = vi.fn<typeof fetch>(async () => {
  throw new Error('unexpected_model_call')
})
const messages: string[] = []
const dependencies = {
  environment,
  connect,
  fetch: forbiddenNetwork,
  stdout: (message: string) => {
    messages.push(message)
  }
}
const reviewerDependencies = { ...dependencies, environment: reviewerEnvironment }
const scoped = (mode: string, account = 'account-A', run = runId): string[] => [
  mode,
  '--tenant',
  'A',
  '--account',
  account,
  '--run',
  run
]
async function privateJson<T = Record<string, unknown>>(path: string): Promise<T> {
  await verifyPrivatePaths(dirname(path), [path])
  return JSON.parse(await readFile(path, 'utf8')) as T
}
async function switchLogin(name = login) {
  await pg.sql.exec(
    `SET SESSION AUTHORIZATION postgres; RESET ROLE; SET SESSION AUTHORIZATION ${name}`
  )
}
function importArgs(
  reviewId: string,
  path = labelsPath,
  out = importPath,
  artifacts = artifactsPath
) {
  return [
    ...scoped('import'),
    '--packet',
    packetPath,
    '--artifacts',
    artifacts,
    '--labels',
    path,
    '--review-id',
    reviewId,
    '--out',
    out
  ]
}
function calibrationArgs(
  reviewId: string,
  path = labelsPath,
  out = join(directory, 'calibration'),
  artifacts = artifactsPath
) {
  return [
    'calibrate',
    ...importArgs(reviewId, path, out, artifacts).slice(1),
    '--settings',
    calibrationSettingsPath
  ]
}
async function submitReview(path: string, out: string) {
  const packet = PrivateBlindReviewPacketSchema.parse(await privateJson(packetPath))
  await switchLogin(reviewerLogin)
  try {
    return await runJevReplayCommand(
      [...scoped('review-submit'), '--packet-id', packet.packetId, '--labels', path, '--out', out],
      reviewerDependencies
    )
  } finally {
    await switchLogin()
  }
}
async function counts() {
  return (
    await pg.db.transaction('A', (client) =>
      client.query(`SELECT
    (SELECT count(*) FROM jev_replay_artifact_seals)::int AS artifact_seals,
    (SELECT count(*) FROM jev_blind_packet_seals)::int AS packet_seals,
    (SELECT count(*) FROM jev_replay_attempts)::int AS attempts,
    (SELECT count(*) FROM generation_tasks)::int AS tasks,
    (SELECT count(*) FROM execution_permits)::int AS permits,
    (SELECT count(*) FROM evaluation_approvals)::int AS approvals,
    (SELECT count(*) FROM account_leases)::int AS leases`)
    )
  ).rows[0]
}

beforeAll(async () => {
  pg = await embeddedPostgres()
  await pg.sql.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE')
  for (const file of [
    '045-jev-replay-journal.sql',
    '046-jev-replay-artifact-seals.sql',
    '047-jev-blind-packet-seals.sql',
    '048-jev-blind-label-reviews.sql',
    '049-jev-calibration-declarations.sql',
    '050-jev-calibrated-holdouts.sql',
    '051-jev-replay-scoped-lookups.sql'
  ]) {
    const source = await readFile(resolve('server/migrations', file), 'utf8')
    await pg.sql.exec(source)
    await pg.sql.exec(source)
  }
  await pg.sql.exec(`CREATE ROLE ${login} LOGIN NOSUPERUSER NOBYPASSRLS;
    GRANT autoreply_admin TO ${login};
    INSERT INTO tenants(id,name) VALUES('A','synthetic command protocol');
    INSERT INTO employees(tenant_id,id,role) VALUES('A','admin-A','admin');
    INSERT INTO admin_database_principals(login_name,tenant_id,employee_id) VALUES('${login}','A','admin-A');
    SET SESSION AUTHORIZATION ${login}`)
  const principal = (
    await pg.db.transaction('A', (client) =>
      client.query(
        `SELECT session_user AS login,p.tenant_id,p.actor_id,r.rolsuper,r.rolbypassrls
    FROM autoreply.authenticate_admin('A') p JOIN pg_roles r ON r.rolname=session_user`
      )
    )
  ).rows[0]
  expect(principal).toEqual({
    login,
    tenant_id: 'A',
    actor_id: 'admin-A',
    rolsuper: false,
    rolbypassrls: false
  })
  admin = new Administration(pg.db, version)
  for (const suffix of ['A', 'B'])
    await admin.provision('A', {
      accountId: `account-${suffix}`,
      employeeId: `employee-${suffix}`,
      platform: 'wechat'
    })
  await pg.sql.exec(`SET SESSION AUTHORIZATION postgres; RESET ROLE;
    CREATE ROLE ${reviewerLogin} LOGIN NOSUPERUSER NOBYPASSRLS;
    GRANT autoreply_jev_reviewer TO ${reviewerLogin};
    INSERT INTO employees(tenant_id,id,role) VALUES('A','reviewer-A','employee');
    INSERT INTO jev_reviewer_database_principals(login_name,tenant_id,account_id,employee_id)
    VALUES('${reviewerLogin}','A','account-A','reviewer-A');
    SET SESSION AUTHORIZATION ${login}`)
  publication = PublicationSchema.parse(
    JSON.parse(await readFile('server/admin/publication.example.json', 'utf8'))
  )
  publication.configuration.automaticEnabled = true
  publication.configuration.modelResolved = 'jev-resolved'
  publication.policy = {
    ...publication.policy,
    mode: 'enforced',
    evaluationApproved: true,
    modelAlias: 'jev-alias',
    modelResolved: 'jev-resolved'
  }
  publication.textGeneratorVersion = version
  publication.evidence = [
    {
      evidenceId: 'synthetic-faq',
      tenantId: 'A',
      accountId: 'account-A',
      conversationId: 'customer-A',
      intent: 'faq',
      knowledgeVersion: publication.policy.knowledgeVersion,
      kind: 'approved_faq',
      content: '支持离线阅读。',
      source: 'synthetic fixture only',
      approvedBy: 'synthetic-author',
      validFrom: 0,
      expiresAt: Date.now() + 3600000
    }
  ]
  runId = (await admin.freezeEvaluation('A', 'account-A', { publication, plan: planFor(allCases) }))
    .runId
  await createPrivateOutput(directory)
  await writePrivateJson(inputPath, input)
  await writePrivateJson(priorsPath, {
    annotatedBy: 'synthetic-prior-author',
    cases: input.cases.map((c) => ({
      caseId: c.caseId,
      category: 'handoff',
      eligible: false,
      expectedHandoff: true,
      intentCount: 1
    }))
  })
  await writePrivateJson(calibrationSettingsPath, {
    candidates: [publication.policy],
    targets: {
      maximumErrorReleaseRate: 0.01,
      minimumAutomaticCoverage: 0.5,
      minimumAutomaticReplies: 30
    }
  })
}, 20000)

// Keep the complete 100-case/300-arm execution out of the fixed five-second test deadline.
// The same existing integration-fixture hook ceiling is retained, rather than shrinking the cut.
beforeAll(async () => {
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('global_http_forbidden'))
  try {
    expect(
      await runJevReplayCommand(
        [
          ...scoped('declare'),
          '--settings',
          calibrationSettingsPath,
          '--out',
          join(directory, 'declaration')
        ],
        dependencies
      )
    ).toBe(0)
    planCode = await runJevReplayCommand(
      [...scoped('plan'), '--input', inputPath, '--out', planPath],
      dependencies
    )
    limitCode = await runJevReplayCommand(
      ['limit', '--tenant', 'A', '--account', 'account-A', '--daily-attempt-limit', '10'],
      dependencies
    )
    executeCode = await runJevReplayCommand(
      [...scoped('execute'), '--input', inputPath, '--out', executePath, '--max-attempts', '10'],
      dependencies
    )
    expect(network).not.toHaveBeenCalled()
    expect(forbiddenNetwork).not.toHaveBeenCalled()
  } finally {
    network.mockRestore()
  }
}, 20000)

beforeAll(async () => {
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('global_http_forbidden'))
  try {
    blindCode = await runJevReplayCommand(
      [
        ...scoped('blind'),
        '--input',
        inputPath,
        '--artifacts',
        artifactsPath,
        '--priors',
        priorsPath,
        '--rubric',
        'synthetic-rubric-v1',
        '--kind',
        'synthetic',
        '--out',
        blindPath
      ],
      dependencies
    )
    expect(network).not.toHaveBeenCalled()
    expect(forbiddenNetwork).not.toHaveBeenCalled()
  } finally {
    network.mockRestore()
  }
}, 20000)

// The complete packet is submitted using a distinct, ordinary database reviewer identity.
beforeAll(async () => {
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('global_http_forbidden'))
  try {
    const packet = PrivateBlindReviewPacketSchema.parse(await privateJson(packetPath))
    labels = BlindLabelsSchema.parse({
      adjudicatedBy: 'reviewer-A',
      annotationSource: 'blinded_business_adjudication',
      labels: packet.mapping.map((m) => ({
        reviewId: m.reviewId,
        substantialCorrection: null,
        severeFactError: false,
        unauthorizedPromise: false,
        incorrectlyBlocked: false,
        coveredIntents: 0
      }))
    })
    await writePrivateJson(labelsPath, labels)
    expect(await submitReview(labelsPath, reviewPath)).toBe(0)
    reviewReceipt = await privateJson<typeof reviewReceipt>(
      join(reviewPath, 'review-receipt.private.json')
    )
    expect(network).not.toHaveBeenCalled()
    expect(forbiddenNetwork).not.toHaveBeenCalled()
  } finally {
    network.mockRestore()
  }
}, 20000)

beforeEach(async () => {
  await switchLogin()
  globalNetwork = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('global_http_forbidden'))
})
afterAll(async () => {
  globalNetwork?.mockRestore()
  if (pg) await pg.db.close()
})

describe('actual Jev replay command workflow with synthetic SQL and private Windows outputs', () => {
  it('handles help, strict duplicate/unknown flags and cancellation before opening a connection', async () => {
    const noConnect = vi.fn(() => {
      throw new Error('connection_forbidden')
    })
    expect(
      await runJevReplayCommand(['--help'], {
        environment: {},
        connect: noConnect,
        stdout: () => {}
      })
    ).toBe(0)
    await expect(
      runJevReplayCommand(['limit', '--tenant', 'A', '--tenant', 'B'], { connect: noConnect })
    ).rejects.toThrow('usage')
    await expect(
      runJevReplayCommand(['limit', '--disable-guards', 'true'], { connect: noConnect })
    ).rejects.toThrow('usage')
    const cancelled = new AbortController()
    cancelled.abort()
    await expect(
      runJevReplayCommand(
        ['limit', '--tenant', 'A', '--account', 'account-A', '--daily-attempt-limit', '10'],
        { environment, connect: noConnect, signal: cancelled.signal }
      )
    ).rejects.toThrow('evaluation_cancelled')
    expect(noConnect).not.toHaveBeenCalled()
    expect(globalNetwork).not.toHaveBeenCalled()
  })

  it('plans and executes the complete frozen cut, returning 0/2 with 300 central seals and actual private ACLs', async () => {
    expect([planCode, limitCode, executeCode]).toEqual([0, 0, 2])
    expect(await privateJson(planPath)).toMatchObject({
      mode: 'authenticated_replay_preflight',
      caseCount: 100,
      maximumLogicalModelCalls: 600,
      modelsCalled: false,
      releaseAuthorized: false
    })
    const files = (await readdir(executePath)).map((file) => join(executePath, file))
    // 300 per-arm records plus execution, manifest, compatible aggregate and status.
    expect(files).toHaveLength(304)
    await verifyPrivatePaths(executePath, files)
    const manifest = JevReplayArtifactManifestSchema.parse(await privateJson(artifactsPath))
    expect(manifest.parts).toHaveLength(300)
    expect(manifest.source).toMatchObject({ runId, datasetId: input.datasetId, split: input.split })
    const artifacts = await privateJson<JevReplayArmArtifact[]>(aggregatePath)
    expect(artifacts).toHaveLength(300)
    expect(new Set(artifacts.map((a) => `${a.caseId}/${a.arm}`)).size).toBe(300)
    expect(
      artifacts.every(
        (a) => a.status === 'handoff' && !a.releaseAuthorized && a.attempts?.length === 0
      )
    ).toBe(true)
    expect(await privateJson(join(executePath, 'status.json'))).toMatchObject({
      mode: 'awaiting_billing_and_independent_labels',
      modelsCalled: false,
      cases: 100,
      completedArms: 300,
      artifactInput: 'artifacts.manifest.private.json',
      aggregateAvailable: true,
      usageComplete: true,
      billedCostMicros: null,
      monetaryBudgetVerified: false,
      releaseAuthorized: false
    })
    expect(await counts()).toEqual({
      artifact_seals: 300,
      packet_seals: 1,
      attempts: 0,
      tasks: 0,
      permits: 0,
      approvals: 0,
      leases: 0
    })
    expect(forbiddenNetwork).not.toHaveBeenCalled()
    expect(globalNetwork).not.toHaveBeenCalled()
  })

  it('creates a centrally sealed blind packet without revealing arm or assignment to the reviewer', async () => {
    expect(blindCode).toBe(0)
    const packet = PrivateBlindReviewPacketSchema.parse(await privateJson(packetPath))
    expect(packet.dataKind).toBe('synthetic')
    expect(packet.mapping).toHaveLength(300)
    const reviewer = await privateJson<Record<string, unknown>[]>(
      join(blindPath, 'reviewer-view.private.json')
    )
    expect(reviewer).toHaveLength(300)
    expect(
      reviewer.every(
        (row) => Object.keys(row).sort().join(',') === 'context,draft,inbound,reviewId'
      )
    ).toBe(true)
    expect(await privateJson(join(blindPath, 'status.json'))).toMatchObject({
      mode: 'blind_review_ready',
      modelsCalled: false,
      releaseAuthorized: false
    })
    expect((await counts()).packet_seals).toBe(1)
    expect(globalNetwork).not.toHaveBeenCalled()
  })

  it('rejects repeat blind creation before reading artifacts or creating output and preserves the original packet', async () => {
    const repeatedOutput = join(directory, 'repeat-blind')
    const unreadArtifacts = join(directory, 'must-not-read.private.json')
    const central = async () =>
      (
        await pg.db.transaction('A', (client) =>
          client.query(
            "SELECT * FROM jev_blind_packet_seals WHERE account_id='account-A' AND run_id=$1",
            [runId]
          )
        )
      ).rows
    const originalCentral = await central(),
      originalPacket = await privateJson(packetPath)
    expect(originalCentral).toHaveLength(1)
    await expect(lstat(repeatedOutput)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(unreadArtifacts)).rejects.toMatchObject({ code: 'ENOENT' })
    const before = close.mock.calls.length
    await expect(
      runJevReplayCommand(
        [
          ...scoped('blind'),
          '--input',
          inputPath,
          '--artifacts',
          unreadArtifacts,
          '--priors',
          priorsPath,
          '--rubric',
          'synthetic-rubric-v1',
          '--kind',
          'synthetic',
          '--out',
          repeatedOutput
        ],
        dependencies
      )
    ).rejects.toThrow('jev_blind_packet_already_sealed')
    expect(close.mock.calls.length).toBe(before + 1)
    await expect(lstat(repeatedOutput)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await central()).toEqual(originalCentral)
    expect(await privateJson(packetPath)).toEqual(originalPacket)
    expect(forbiddenNetwork).not.toHaveBeenCalled()
    expect(globalNetwork).not.toHaveBeenCalled()
  })

  it('imports authenticated synthetic labels through the parser and original central seals after repeat blind rejection', async () => {
    const before = close.mock.calls.length
    expect(await runJevReplayCommand(importArgs(reviewReceipt.reviewId), dependencies)).toBe(0)
    expect(close.mock.calls.length).toBe(before + 1)
    const status = await privateJson(join(importPath, 'status.json'))
    expect(status).toMatchObject({
      mode: 'dataset_ready_cost_unknown',
      dataKind: 'synthetic',
      modelsCalled: false,
      reviewReceipt: {
        reviewId: reviewReceipt.reviewId,
        reviewerId: 'reviewer-A',
        revision: 1,
        centralReviewVerified: true,
        releaseAuthorized: false
      },
      monetaryBudgetVerified: false,
      releaseAuthorized: false
    })
    const result = await privateJson(join(importPath, 'adjudication.private.json'))
    expect(result).toMatchObject({
      dataKind: 'synthetic',
      billedCostMicros: null,
      approvalSubmission: null,
      releaseAuthorized: false
    })
    expect(result.limitations).toContain('Synthetic data does not demonstrate business accuracy.')
    expect((await counts()).approvals).toBe(0)
    expect(globalNetwork).not.toHaveBeenCalled()
  })

  it('recovers the original candidate declaration after execution with a fresh private output and no new record', async () => {
    const out = join(directory, 'declaration-retry')
    const first = await privateJson(
      join(directory, 'declaration', 'declaration-receipt.private.json')
    )
    expect(
      await runJevReplayCommand(
        [...scoped('declare'), '--settings', calibrationSettingsPath, '--out', out],
        dependencies
      )
    ).toBe(0)
    expect(await privateJson(join(out, 'declaration-receipt.private.json'))).toEqual(first)
    expect(first).toMatchObject({
      runId,
      settingsHash: hashContext(await privateJson(calibrationSettingsPath)),
      candidatePredeclarationVerified: true,
      releaseAuthorized: false
    })
    expect(
      (
        await pg.db.transaction('A', (db) =>
          db.query('SELECT count(*)::int AS n FROM jev_calibration_declarations')
        )
      ).rows[0].n
    ).toBe(1)
    expect((await counts()).approvals).toBe(0)
    expect(globalNetwork).not.toHaveBeenCalled()
  })

  it('rejects changed candidate targets before reading labels or artifacts and creating output', async () => {
    const changedPath = join(directory, 'changed-settings.private.json'),
      out = join(directory, 'changed-calibration')
    const settings = await privateJson<{
      candidates: unknown[]
      targets: {
        maximumErrorReleaseRate: number
        minimumAutomaticCoverage: number
        minimumAutomaticReplies: number
      }
    }>(calibrationSettingsPath)
    settings.targets.maximumErrorReleaseRate += 0.01
    await writePrivateJson(changedPath, settings)
    const args = calibrationArgs(
      reviewReceipt.reviewId,
      join(directory, 'absent-labels.private.json'),
      out,
      join(directory, 'absent-artifacts.private.json')
    )
    args[args.indexOf('--settings') + 1] = changedPath
    await expect(runJevReplayCommand(args, dependencies)).rejects.toThrow(
      'jev_calibration_declaration_changed'
    )
    await expect(lstat(out)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await counts()).approvals).toBe(0)
    expect(globalNetwork).not.toHaveBeenCalled()
  })

  it('calibrates the complete centrally sealed split against the original independent review without model calls or approvals', async () => {
    const out = join(directory, 'calibration')
    const before = close.mock.calls.length
    expect(await runJevReplayCommand(calibrationArgs(reviewReceipt.reviewId), dependencies)).toBe(2)
    expect(close.mock.calls.length).toBe(before + 1)
    const report = await privateJson(join(out, 'calibration-report.private.json'))
    expect(report).toMatchObject({
      sampleCount: 100,
      independentConversations: 100,
      status: 'insufficient_evidence',
      recommendedPolicy: null,
      holdoutRequired: true,
      releaseAuthorized: false
    })
    const status = await privateJson(join(out, 'status.json'))
    expect(status).toMatchObject({
      mode: 'calibration_evaluated',
      modelsCalled: false,
      reviewReceipt: { reviewId: reviewReceipt.reviewId, revision: 1, centralReviewVerified: true },
      centralReceipt: { centralRecordVerified: true },
      candidatePredeclarationVerified: true,
      declarationReceipt: {
        candidatePredeclarationVerified: true,
        settingsHash: status.calibrationSettingsHash
      },
      monetaryBudgetVerified: false,
      releaseAuthorized: false
    })
    expect(status.calibrationInputHash).toBe(report.inputHash)
    expect((await counts()).approvals).toBe(0)
    expect(forbiddenNetwork).not.toHaveBeenCalled()
    expect(globalNetwork).not.toHaveBeenCalled()
  })

  it('refuses freezing a synthetic non-recommendation without creating a run or output', async () => {
    const out = join(directory, 'synthetic-holdout-refused')
    const args = calibrationArgs(reviewReceipt.reviewId, labelsPath, out)
    args[0] = 'freeze-holdout'
    args.push(
      '--policy-version',
      'synthetic-holdout-policy',
      '--config-version',
      'synthetic-holdout-config'
    )
    await expect(runJevReplayCommand(args, dependencies)).rejects.toThrow(
      'jev_holdout_recommendation_required'
    )
    await expect(lstat(out)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(
      (
        await pg.db.transaction('A', (db) =>
          db.query('SELECT count(*)::int AS n FROM evaluation_runs')
        )
      ).rows[0].n
    ).toBe(1)
    expect(
      (
        await pg.db.transaction('A', (db) =>
          db.query('SELECT count(*)::int AS n FROM jev_holdout_lineages')
        )
      ).rows[0].n
    ).toBe(0)
    expect((await counts()).approvals).toBe(0)
    expect(forbiddenNetwork).not.toHaveBeenCalled()
    expect(globalNetwork).not.toHaveBeenCalled()
  })

  it('submits reviewer-only labels without administrator or model configuration and cannot read execution or blind mapping tables', async () => {
    const packet = PrivateBlindReviewPacketSchema.parse(await privateJson(packetPath))
    expect(reviewReceipt).toMatchObject({
      packetId: packet.packetId,
      packetHash: packet.packetHash,
      reviewerId: 'reviewer-A',
      revision: 1,
      centralReviewVerified: true,
      releaseAuthorized: false
    })
    expect(Number.isFinite(Date.parse(reviewReceipt.reviewedAt))).toBe(true)
    await switchLogin(reviewerLogin)
    try {
      const authority = (
        await pg.db.pool.query(`SELECT session_user AS login,r.rolsuper,r.rolbypassrls,
        pg_has_role(session_user,'autoreply_admin','MEMBER') AS admin,
        pg_has_role(session_user,'autoreply_app','MEMBER') AS app,
        pg_has_role(session_user,'autoreply_learning_worker','MEMBER') AS worker
        FROM pg_roles r WHERE r.rolname=session_user`)
      ).rows[0]
      expect(authority).toEqual({
        login: reviewerLogin,
        rolsuper: false,
        rolbypassrls: false,
        admin: false,
        app: false,
        worker: false
      })
      await expect(
        pg.db.pool.query('SELECT input_json,publication_json FROM jev_replay_executions')
      ).rejects.toThrow('permission denied')
      await expect(
        pg.db.pool.query('SELECT case_id,arm FROM jev_replay_assignments')
      ).rejects.toThrow('permission denied')
      await expect(pg.db.pool.query('SELECT * FROM jev_blind_packet_seals')).rejects.toThrow(
        'permission denied'
      )
    } finally {
      await switchLogin()
    }
    // A fresh output recovers the same already committed latest review rather than incrementing it.
    const retry = join(directory, 'review-retry')
    expect(await submitReview(labelsPath, retry)).toBe(0)
    expect(await privateJson(join(retry, 'review-receipt.private.json'))).toEqual(reviewReceipt)
    expect(await privateJson(join(retry, 'status.json'))).toMatchObject({
      mode: 'independent_labels_recorded',
      revision: 1,
      modelsCalled: false,
      releaseAuthorized: false
    })
    await verifyPrivatePaths(retry, [
      join(retry, 'review-receipt.private.json'),
      join(retry, 'status.json')
    ])
    expect(connect).toHaveBeenCalledWith(reviewerEnvironment.REVIEW_DATABASE_URL)
    expect(await counts()).toMatchObject({
      attempts: 0,
      tasks: 0,
      permits: 0,
      approvals: 0,
      leases: 0
    })
    expect(forbiddenNetwork).not.toHaveBeenCalled()
    expect(globalNetwork).not.toHaveBeenCalled()
  })

  it('rejects adjudicator-name-only forgery under the actual reviewer login before output exists', async () => {
    const forgedPath = join(directory, 'name-only-labels.private.json'),
      out = join(directory, 'name-only-review')
    await writePrivateJson(forgedPath, { ...labels, adjudicatedBy: 'admin-A' })
    await expect(submitReview(forgedPath, out)).rejects.toThrow(
      'jev_blind_labels_identity_or_count_invalid'
    )
    await expect(lstat(out)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(forbiddenNetwork).not.toHaveBeenCalled()
    expect(globalNetwork).not.toHaveBeenCalled()
  })

  it('rejects unauthenticated imports in the parser before connecting or creating output', async () => {
    const noConnect = vi.fn(() => {
      throw new Error('connection_forbidden')
    })
    const out = join(directory, 'no-review-import')
    await expect(
      runJevReplayCommand(
        [
          ...scoped('import'),
          '--packet',
          packetPath,
          '--artifacts',
          artifactsPath,
          '--labels',
          labelsPath,
          '--out',
          out
        ],
        { ...dependencies, connect: noConnect }
      )
    ).rejects.toThrow('review-id')
    expect(noConnect).not.toHaveBeenCalled()
    await expect(lstat(out)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(globalNetwork).not.toHaveBeenCalled()
  })

  it.each(['unknown-review', 'changed-label', 'changed-adjudicator'] as const)(
    'rejects %s before artifact reads or output creation',
    async (kind) => {
      const path = join(directory, `${kind}-labels.private.json`),
        out = join(directory, `${kind}-import`),
        unreadArtifacts = join(directory, `${kind}-must-not-read.private.json`)
      const changed = structuredClone(labels)
      if (kind === 'changed-label') changed.labels[0].incorrectlyBlocked = true
      if (kind === 'changed-adjudicator') changed.adjudicatedBy = 'admin-A'
      await writePrivateJson(path, changed)
      await expect(lstat(unreadArtifacts)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(
        runJevReplayCommand(
          importArgs(
            kind === 'unknown-review' ? randomUUID() : reviewReceipt.reviewId,
            path,
            out,
            unreadArtifacts
          ),
          dependencies
        )
      ).rejects.toThrow('jev_blind_review_changed')
      await expect(lstat(out)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(forbiddenNetwork).not.toHaveBeenCalled()
      expect(globalNetwork).not.toHaveBeenCalled()
    }
  )

  it('rejects an old review receipt after a separately authenticated newer revision before reading artifacts', async () => {
    const revised = structuredClone(labels)
    revised.labels[0].incorrectlyBlocked = true
    const revisedPath = join(directory, 'revised-labels.private.json'),
      revisedOut = join(directory, 'revised-review'),
      out = join(directory, 'stale-review-import'),
      unreadArtifacts = join(directory, 'stale-must-not-read.private.json')
    await writePrivateJson(revisedPath, revised)
    expect(await submitReview(revisedPath, revisedOut)).toBe(0)
    const next = await privateJson<typeof reviewReceipt>(
      join(revisedOut, 'review-receipt.private.json')
    )
    expect(next).toMatchObject({
      packetId: reviewReceipt.packetId,
      reviewerId: 'reviewer-A',
      revision: 2
    })
    expect(next.reviewId).not.toBe(reviewReceipt.reviewId)
    expect(next.labelsHash).not.toBe(reviewReceipt.labelsHash)
    await expect(
      runJevReplayCommand(
        importArgs(reviewReceipt.reviewId, labelsPath, out, unreadArtifacts),
        dependencies
      )
    ).rejects.toThrow('jev_blind_review_stale')
    await expect(lstat(out)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(forbiddenNetwork).not.toHaveBeenCalled()
    expect(globalNetwork).not.toHaveBeenCalled()
  })

  it('stops a real-client replay at account quota one and retains the paid receipt and incomplete private output', async () => {
    const mixed = allCases.map((c, i) => ({
      ...c,
      inbound: i < 3 ? ['支持离线阅读吗？'] : c.inbound
    }))
    const published = structuredClone(publication)
    published.evidence[0].accountId = 'account-B'
    const run = (
      await admin.freezeEvaluation('A', 'account-B', {
        publication: published,
        plan: planFor(mixed)
      })
    ).runId
    const mixedPath = join(directory, 'mixed-inputs.private.json'),
      failedPath = join(directory, 'incomplete')
    await writePrivateJson(mixedPath, { ...input, cases: mixed.slice(0, 100) })
    expect(
      await runJevReplayCommand(
        ['limit', '--tenant', 'A', '--account', 'account-B', '--daily-attempt-limit', '1'],
        dependencies
      )
    ).toBe(0)
    const http = vi.fn<typeof fetch>(async () =>
      Response.json({
        model: 'text-resolved',
        usage: { prompt_tokens: 10, completion_tokens: 5 },
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: JSON.stringify({ text: '支持离线阅读。', evidenceIds: ['synthetic-faq'] })
            }
          }
        ]
      })
    )
    const before = close.mock.calls.length
    await expect(
      runJevReplayCommand(
        [
          ...scoped('execute', 'account-B', run),
          '--input',
          mixedPath,
          '--out',
          failedPath,
          '--max-attempts',
          '10'
        ],
        { ...dependencies, fetch: http }
      )
    ).rejects.toThrow('evaluation_incomplete')
    expect(close.mock.calls.length).toBe(before + 1)
    expect(http).toHaveBeenCalledTimes(1)
    expect(String(http.mock.calls[0][0])).toContain('/chat/completions')
    expect(await privateJson(join(failedPath, 'status.json'))).toMatchObject({
      mode: 'execution_incomplete',
      modelsCalled: true,
      monetaryBudgetVerified: false,
      billedCostMicros: null,
      automaticPaidResumeSupported: false,
      releaseAuthorized: false
    })
    const records = (
      await pg.db.transaction('A', (client) =>
        client.query(`SELECT t.start_json,r.result_json FROM jev_replay_attempts t
      LEFT JOIN jev_replay_results r ON (r.tenant_id,r.account_id,r.attempt_id)=(t.tenant_id,t.account_id,t.id)
      WHERE t.account_id='account-B'`)
      )
    ).rows
    expect(records).toHaveLength(1)
    expect(records[0].result_json).toMatchObject({
      outcome: 'response',
      actualModel: 'text-resolved',
      textOutput: { evidenceIds: ['synthetic-faq'] }
    })
    expect(JSON.stringify(records)).not.toMatch(/synthetic-text-key|支持离线阅读/)
    expect(await counts()).toMatchObject({
      attempts: 1,
      tasks: 0,
      permits: 0,
      approvals: 0,
      leases: 0
    })
    expect(globalNetwork).not.toHaveBeenCalled()
    expect(messages.join('')).not.toMatch(/synthetic-text-key|synthetic-jev-key/)
  })

  it.each(['import', 'calibrate'] as const)(
    'rejects a real newer review during %s before successful output exists',
    async (mode) => {
      const latest = (
        await pg.db.transaction('A', (db) =>
          db.query(
            `SELECT id,revision,labels_json FROM jev_blind_label_reviews
          WHERE account_id='account-A' AND packet_id=$1 ORDER BY revision DESC LIMIT 1`,
            [reviewReceipt.packetId]
          )
        )
      ).rows[0]
      const current = BlindLabelsSchema.parse(latest.labels_json),
        changed = structuredClone(current)
      expect(current.labels).toHaveLength(300)
      changed.labels[0].incorrectlyBlocked = !current.labels[0].incorrectlyBlocked
      const currentPath = join(directory, `race-${mode}-current-labels.private.json`),
        changedPath = join(directory, `race-${mode}-new-labels.private.json`),
        newReviewOut = join(directory, `race-${mode}-new-review`),
        out = join(directory, `race-${mode}-output`)
      await writePrivateJson(currentPath, current)
      await writePrivateJson(changedPath, changed)
      const actualVerify = JevBlindPacketSeals.prototype.verify
      const verification = vi
        .spyOn(JevBlindPacketSeals.prototype, 'verify')
        .mockImplementationOnce(async function (this: JevBlindPacketSeals, request) {
          // Preserve actual full packet/artifact SQL verification. Only the timing of a
          // separately authenticated real SQL revision is controlled by this wrapper.
          const central = await actualVerify.call(this, request)
          expect(central.centralRecordVerified).toBe(true)
          expect(await submitReview(changedPath, newReviewOut)).toBe(0)
          const next = await privateJson<typeof reviewReceipt>(
            join(newReviewOut, 'review-receipt.private.json')
          )
          expect(next.revision).toBe(Number(latest.revision) + 1)
          expect(next.reviewId).not.toBe(latest.id)
          return central
        })
      try {
        await expect(
          runJevReplayCommand(
            mode === 'import'
              ? importArgs(String(latest.id), currentPath, out, artifactsPath)
              : calibrationArgs(String(latest.id), currentPath, out, artifactsPath),
            dependencies
          )
        ).rejects.toThrow('jev_blind_review_stale')
        expect(verification).toHaveBeenCalledTimes(1)
        await expect(lstat(out)).rejects.toMatchObject({ code: 'ENOENT' })
        expect(await counts()).toMatchObject({ tasks: 0, permits: 0, approvals: 0, leases: 0 })
        expect(forbiddenNetwork).not.toHaveBeenCalled()
        expect(globalNetwork).not.toHaveBeenCalled()
      } finally {
        verification.mockRestore()
      }
    }
  )
})
