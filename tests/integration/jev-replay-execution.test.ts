import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { embeddedPostgres } from '../fixtures/embedded-postgres'
import { evaluationPlan } from '../fixtures/evaluation-data'
import { Administration } from '../../server/src/admin/administration'
import { PublicationSchema, type Publication } from '../../server/src/generation/publication'
import { JevReplayJournal } from '../../server/src/generation/jev-replay-journal'
import { textGeneratorVersion } from '../../server/src/generation/text-generator'
import { createJevReplayProviderFactory } from '../../evals/jev/replay-providers'
import {
  executeJevReplayArm,
  type ReplayAssignment,
  type JevReplayArmArtifact
} from '../../evals/jev/replay'
import { replayCaseInputHash } from '../../evals/jev/replay-input'
import type { JevRequest } from '../../src/shared/contracts/decision'
import { hashContext, hashDraft } from '../../src/core/reply/hashes'

let pg: Awaited<ReturnType<typeof embeddedPostgres>>,
  admin: Administration,
  publication: Publication
const text = {
  apiKey: 'synthetic-text-key',
  baseUrl: 'https://text.invalid/v1/',
  model: 'text-request',
  expectedModel: 'text-resolved'
}
const generatorVersion = textGeneratorVersion(text)
const plan = evaluationPlan()
plan.replayProtocol = 'jev-abc-v1'
const cases = plan.assignments.map((a) => ({
  caseId: a.caseId,
  conversationGroup: a.conversationGroup,
  split: a.split,
  conversationId: 'customer-A',
  inbound: ['支持离线阅读吗？']
}))
plan.assignments.forEach((a, i) => {
  a.inputHash = replayCaseInputHash(cases[i])
})
const input = {
  datasetId: plan.datasetId,
  split: 'calibration',
  cases: cases.filter((c) => c.split === 'calibration')
}

async function login(): Promise<void> {
  await pg.sql.exec(
    'SET SESSION AUTHORIZATION postgres; RESET ROLE; SET SESSION AUTHORIZATION jev_execution_admin'
  )
}
beforeAll(async () => {
  pg = await embeddedPostgres()
  const migration = await readFile('server/migrations/045-jev-replay-journal.sql', 'utf8')
  await pg.sql.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE')
  await pg.sql.exec(migration)
  await pg.sql.exec(migration)
  const seals = await readFile('server/migrations/046-jev-replay-artifact-seals.sql', 'utf8')
  await pg.sql.exec(seals)
  await pg.sql.exec(seals)
  await pg.sql.exec(`CREATE ROLE jev_execution_admin LOGIN NOSUPERUSER NOBYPASSRLS;
    GRANT autoreply_admin TO jev_execution_admin;
    INSERT INTO tenants(id,name) VALUES('A','synthetic execution only');
    INSERT INTO employees(tenant_id,id,role) VALUES('A','admin-A','admin');
    INSERT INTO admin_database_principals(login_name,tenant_id,employee_id) VALUES('jev_execution_admin','A','admin-A');`)
  await login()
  admin = new Administration(pg.db, generatorVersion)
  await admin.provision('A', {
    accountId: 'account-A',
    employeeId: 'employee-A',
    platform: 'wework'
  })
  publication = PublicationSchema.parse(
    JSON.parse(await readFile('server/admin/publication.example.json', 'utf8'))
  )
  publication.configuration = {
    ...publication.configuration,
    automaticEnabled: true,
    modelResolved: 'jev-resolved'
  }
  publication.policy = {
    ...publication.policy,
    mode: 'enforced',
    evaluationApproved: true,
    modelAlias: 'jev-alias',
    modelResolved: 'jev-resolved'
  }
  publication.textGeneratorVersion = generatorVersion
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
      source: 'synthetic protocol test only',
      approvedBy: 'synthetic-author',
      validFrom: 0,
      expiresAt: Date.now() + 3600000
    }
  ]
}, 20000)
afterAll(async () => {
  if (pg) await pg.db.close()
})
beforeEach(async ({ task }) => {
  await pg.sql.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE')
  await pg.sql.exec(
    'TRUNCATE jev_replay_results,jev_replay_attempts,jev_replay_assignments,jev_replay_executions,jev_replay_limits,evaluation_runs CASCADE'
  )
  await login()
  completeFixture = undefined
  if (task.name.startsWith('complete frozen split:')) completeFixture = await prepareCompleteCut()
})

function simulatedFetch(failAudit = false): typeof fetch {
  return vi.fn(async (_url, init) => {
    const raw = JSON.parse(String(init?.body))
    if (raw.questions) {
      const request = raw as JevRequest
      return new Response(
        JSON.stringify({
          model: 'jev-resolved',
          usage: { input_tokens: 10, output_tokens: 5 },
          answers: Object.fromEntries(
            Object.entries(request.questions).map(([id, question]) => [
              id,
              question.type === 'choice'
                ? {
                    type: 'choice',
                    choice: 'faq',
                    confidence: 1,
                    probabilities: { faq: 1, price: 0, order: 0, aftersales: 0, other: 0 }
                  }
                : {
                    type: 'noul',
                    noul:
                      failAudit && id === 'supported'
                        ? 0.2
                        : id === 'human_requested' || (id.startsWith('has_') && id !== 'has_faq')
                          ? 0
                          : 1
                  }
            ])
          )
        }),
        { status: 200, headers: { 'x-typesafe-request-id': `jev-${randomUUID()}` } }
      )
    }
    return new Response(
      JSON.stringify({
        model: 'text-resolved',
        usage: { prompt_tokens: 100, completion_tokens: 50 },
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: JSON.stringify({
                text: publication.evidence[0].content,
                evidenceIds: ['synthetic-faq']
              })
            }
          }
        ]
      }),
      { status: 200, headers: { 'x-request-id': `text-${randomUUID()}` } }
    )
  }) as typeof fetch
}
async function prepare(dailyAttemptLimit = 20, humanOnly = false) {
  const selectedInput = humanOnly
    ? {
        ...input,
        cases: input.cases.map((c) => ({ ...c, inbound: ['请转人工客服'] }))
      }
    : input
  const selectedPlan = humanOnly
    ? {
        ...plan,
        assignments: plan.assignments.map((a) => {
          const c = selectedInput.cases.find((c) => c.caseId === a.caseId)
          return c ? { ...a, inputHash: replayCaseInputHash(c) } : a
        })
      }
    : plan
  const run = await admin.freezeEvaluation('A', 'account-A', { publication, plan: selectedPlan })
  const journal = new JevReplayJournal(pg.db, generatorVersion)
  await journal.setLimit('A', 'account-A', { dailyAttemptLimit })
  const prepared = await journal.begin({
    tenantId: 'A',
    accountId: 'account-A',
    runId: run.runId,
    fullRawCases: selectedInput,
    maxRunAttempts: 20
  })
  const identity = {
    ...prepared.source.authenticatedScope,
    agentId: 'evaluation-only-no-enrollment',
    loginEpoch: 0,
    clientInstanceId: 'synthetic-evaluation'
  }
  return { prepared, journal, identity, run, selectedInput }
}

function artifactBinding(
  source: Awaited<ReturnType<typeof prepare>>['prepared']['source'],
  a: JevReplayArmArtifact
) {
  return {
    ...source.authenticatedScope,
    runId: a.runId,
    caseId: a.caseId,
    arm: a.arm,
    assignmentId: a.assignmentId,
    inputHash: a.inputHash,
    executionPlanHash: a.executionPlanHash,
    snapshotHash: a.snapshotHash
  }
}
async function persistedCounts() {
  return pg.db.transaction('A', (db) =>
    db.query(`SELECT
    (SELECT count(*)::int FROM jev_replay_attempts) AS attempts,
    (SELECT count(*)::int FROM jev_replay_results) AS results,
    (SELECT count(*)::int FROM generation_tasks) AS tasks,
    (SELECT count(*)::int FROM account_leases) AS leases,
    (SELECT count(*)::int FROM execution_permits) AS permits,
    (SELECT count(*)::int FROM evaluation_approvals) AS approvals,
    (SELECT paused FROM accounts WHERE tenant_id='A' AND id='account-A') AS paused`)
  )
}

let completeFixture: Awaited<ReturnType<typeof prepareCompleteCut>> | undefined
async function prepareCompleteCut() {
  const { prepared, identity, selectedInput } = await prepare(20, true)
  const transport = vi.fn(async () => {
    throw new Error('model_calls_forbidden')
  }) as typeof fetch
  const factory = createJevReplayProviderFactory(
    prepared.source,
    { jevApiKey: 'synthetic', text, fetch: transport },
    {
      reserve: async () => {
        throw new Error('model_calls_forbidden')
      },
      readAttempts: async () => []
    }
  )
  const templates: JevReplayArmArtifact[] = []
  const item = selectedInput.cases[0]
  for (const arm of ['A', 'B', 'C'] as const) {
    const assignment: ReplayAssignment = {
      runId: prepared.source.runId,
      caseId: item.caseId,
      arm,
      assignmentId: randomUUID()
    }
    const a = await executeJevReplayArm(
      arm,
      { frozen: prepared.source, caseInput: item, identity },
      factory(assignment),
      undefined,
      assignment.assignmentId
    )
    templates.push(a)
  }
  // Synthetic protocol fixtures, not 300 measured executions: copy the three
  // real zero-call templates and bind each frozen case's exact hash/identity.
  const artifacts = selectedInput.cases.flatMap((item) =>
    templates.map((template) => ({
      ...structuredClone(template),
      caseId: item.caseId,
      assignmentId: randomUUID(),
      inputHash: replayCaseInputHash(item)
    }))
  )
  // Full-cut fixtures use ordinary administrator bulk inserts, with no HTTP.
  // The preceding cases exercise sealArtifact against actual production clients.
  await pg.db.transaction('A', async (db) => {
    await db.query(
      `INSERT INTO jev_replay_assignments(tenant_id,account_id,execution_id,id,case_id,arm,input_hash)
        SELECT 'A','account-A',$1,x.id,x.case_id,x.arm,x.input_hash FROM jsonb_to_recordset($2::jsonb) AS x(id uuid,case_id text,arm text,input_hash text)`,
      [
        prepared.executionId,
        JSON.stringify(
          artifacts.map((a) => ({
            id: a.assignmentId,
            case_id: a.caseId,
            arm: a.arm,
            input_hash: a.inputHash
          }))
        )
      ]
    )
    await db.query(
      `INSERT INTO jev_replay_artifact_seals(tenant_id,account_id,assignment_id,artifact_hash,ledger_hash,attempt_count)
        SELECT 'A','account-A',x.id,x.artifact_hash,$1,0 FROM jsonb_to_recordset($2::jsonb) AS x(id uuid,artifact_hash text)`,
      [
        hashContext([]),
        JSON.stringify(
          artifacts.map((a) => ({ id: a.assignmentId, artifact_hash: hashContext(a) }))
        )
      ]
    )
  })
  return { prepared, selectedInput, artifacts, transport }
}

describe('authenticated Jev A/B/C HTTP execution with durable SQL receipts', () => {
  it('runs independent clients through six recorded HTTP attempts while the employee account stays paused', async () => {
    const { prepared, journal, identity } = await prepare()
    const transport = simulatedFetch(true)
    const blockedNetwork = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('network_forbidden'))
    try {
      const factory = createJevReplayProviderFactory(
        prepared.source,
        { jevApiKey: 'synthetic-jev-key', text, fetch: transport },
        journal
      )
      const outputs = []
      for (const arm of ['A', 'B', 'C'] as const) {
        const assignment: ReplayAssignment = {
          runId: prepared.source.runId,
          caseId: input.cases[0].caseId,
          arm,
          assignmentId: randomUUID()
        }
        await journal.bindAssignment(assignment)
        const artifact = await executeJevReplayArm(
          arm,
          { frozen: prepared.source, caseInput: input.cases[0], identity },
          factory(assignment),
          undefined,
          assignment.assignmentId
        )
        const sealed = await journal.sealArtifact(
          artifactBinding(prepared.source, artifact),
          artifact
        )
        expect(sealed.artifactHash).toBe(hashContext(artifact))
        expect(
          await journal.sealArtifact(artifactBinding(prepared.source, artifact), artifact)
        ).toEqual(sealed)
        outputs.push(artifact)
      }
      expect(transport).toHaveBeenCalledTimes(6)
      expect(blockedNetwork).not.toHaveBeenCalled()
      expect(outputs.map((o) => o.wouldRelease)).toEqual([true, true, false])
      expect(outputs[2].reasons).toEqual(['audit_supported'])
      expect(outputs.map((o) => o.usage)).toEqual([
        { inputTokens: 100, outputTokens: 50 },
        { inputTokens: 110, outputTokens: 55 },
        { inputTokens: 120, outputTokens: 60 }
      ])
      expect(outputs.every((o) => !o.releaseAuthorized && o.billedCostMicros === null)).toBe(true)
      const attempts = outputs.flatMap((output) => output.attempts ?? [])
      expect(attempts).toHaveLength(6)
      expect(new Set(attempts.map((a) => a.result?.providerRequestId?.value)).size).toBe(6)
      for (const attempt of attempts)
        expect(attempt.result?.providerRequestId).toEqual({
          header: attempt.start.provider === 'jev' ? 'x-typesafe-request-id' : 'x-request-id',
          value: expect.stringMatching(attempt.start.provider === 'jev' ? /^jev-/ : /^text-/)
        })
      const stored = await pg.db.transaction('A', (db) =>
        db.query('SELECT result_json FROM jev_replay_results ORDER BY attempt_id')
      )
      expect(stored.rows.map((row) => row.result_json.providerRequestId.value).sort()).toEqual(
        attempts.map((a) => a.result!.providerRequestId!.value).sort()
      )
      expect((await persistedCounts()).rows[0]).toEqual({
        attempts: 6,
        results: 6,
        tasks: 0,
        leases: 0,
        permits: 0,
        approvals: 0,
        paused: true
      })
    } finally {
      blockedNetwork.mockRestore()
    }
  })

  it('stops the next HTTP request when the actual SQL account limit is exhausted', async () => {
    const { prepared, journal, identity } = await prepare(1)
    const transport = simulatedFetch()
    const assignment: ReplayAssignment = {
      runId: prepared.source.runId,
      caseId: input.cases[0].caseId,
      arm: 'C',
      assignmentId: randomUUID()
    }
    await journal.bindAssignment(assignment)
    const factory = createJevReplayProviderFactory(
      prepared.source,
      { jevApiKey: 'synthetic-jev-key', text, fetch: transport },
      journal
    )
    const result = await executeJevReplayArm(
      'C',
      { frozen: prepared.source, caseInput: input.cases[0], identity },
      factory(assignment),
      undefined,
      assignment.assignmentId
    )
    expect(transport).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      status: 'handoff',
      wouldRelease: false,
      releaseAuthorized: false,
      usage: null
    })
    expect(result.reasons).toContain('model_call_limit_reached')
    await expect(
      journal.sealArtifact(artifactBinding(prepared.source, result), result)
    ).rejects.toThrow()
    expect((await persistedCounts()).rows[0]).toMatchObject({
      attempts: 1,
      results: 1,
      tasks: 0,
      leases: 0,
      permits: 0,
      approvals: 0,
      paused: true
    })
  })

  it('binds text, ordered evidence, Jev answers and every attempt before sealing; later file edits cannot replace the original', async () => {
    const { prepared, journal, identity } = await prepare()
    const transport = simulatedFetch(true)
    const assignment: ReplayAssignment = {
      runId: prepared.source.runId,
      caseId: input.cases[0].caseId,
      arm: 'C',
      assignmentId: randomUUID()
    }
    const binding = await journal.bindAssignment(assignment)
    const factory = createJevReplayProviderFactory(
      prepared.source,
      { jevApiKey: 'synthetic', text, fetch: transport },
      journal
    )
    const artifact = await executeJevReplayArm(
      'C',
      { frozen: prepared.source, caseInput: input.cases[0], identity },
      factory(assignment),
      undefined,
      assignment.assignmentId
    )
    for (const edit of [
      (a: JevReplayArmArtifact) => {
        a.draft!.text = '已获准退款。'
        a.draft!.draftHash = hashDraft(a.draft!.text)
      },
      (a: JevReplayArmArtifact) => {
        a.draft!.evidenceIds = ['another-source']
      },
      (a: JevReplayArmArtifact) => {
        a.post!.answers.supported = { type: 'noul', noul: 1 }
      },
      (a: JevReplayArmArtifact) => {
        a.pre!.usage.input_tokens += 1
      },
      (a: JevReplayArmArtifact) => {
        a.attempts!.shift()
      },
      (a: JevReplayArmArtifact) => {
        a.attempts![0].start.requestHash = 'a'.repeat(64)
      },
      (a: JevReplayArmArtifact) => {
        const requestId = a.attempts![0].result!.providerRequestId
        if (!requestId) throw new Error('request_id_fixture_missing')
        requestId.value = 'rewritten-provider-request'
      }
    ]) {
      const changed = structuredClone(artifact)
      edit(changed)
      await expect(journal.sealArtifact(binding, changed)).rejects.toThrow()
    }
    expect(
      (
        await pg.db.transaction('A', (db) =>
          db.query('SELECT count(*)::int AS n FROM jev_replay_artifact_seals')
        )
      ).rows[0].n
    ).toBe(0)
    await journal.sealArtifact(binding, artifact)
    const changed = { ...artifact, wouldRelease: true, reasons: [] }
    await expect(journal.sealArtifact(binding, changed)).rejects.toThrow('RECORD_UNAVAILABLE')
    await expect(
      journal.reserve(binding, 'post', artifact.attempts!.at(-1)!.start)
    ).rejects.toThrow()
    await expect(
      pg.db.transaction('A', (db) =>
        db.query('UPDATE jev_replay_artifact_seals SET artifact_hash=$1', ['b'.repeat(64)])
      )
    ).rejects.toThrow()
    await expect(
      pg.db.transaction('A', (db) => db.query('DELETE FROM jev_replay_artifact_seals'))
    ).rejects.toThrow()
    expect(transport).toHaveBeenCalledTimes(3)
  })

  it('complete frozen split: verifies every arm against central seals', async () => {
    if (!completeFixture) throw new Error('fixture_missing')
    const { prepared, selectedInput, artifacts, transport } = completeFixture
    const request = {
      tenantId: 'A',
      accountId: 'account-A',
      runId: prepared.source.runId,
      fullRawCases: selectedInput,
      artifacts
    }
    const fresh = new JevReplayJournal(pg.db, generatorVersion)
    const receipt = await fresh.verifyArtifacts(request)
    expect(receipt).toMatchObject({
      centralRecordVerified: true,
      sealedAssignments: 300,
      releaseAuthorized: false,
      executionId: prepared.executionId
    })
    expect(transport).not.toHaveBeenCalled()
    expect((await persistedCounts()).rows[0]).toMatchObject({
      attempts: 0,
      results: 0,
      tasks: 0,
      permits: 0,
      approvals: 0,
      paused: true
    })
  })

  it('complete frozen split: verifies stable ordering against central seals', async () => {
    if (!completeFixture) throw new Error('fixture_missing')
    const { prepared, selectedInput, artifacts } = completeFixture
    const receipt = await new JevReplayJournal(pg.db, generatorVersion).verifyArtifacts({
      tenantId: 'A',
      accountId: 'account-A',
      runId: prepared.source.runId,
      fullRawCases: selectedInput,
      artifacts: [...artifacts].reverse()
    })
    const expected = artifacts
      .map((artifact) => ({
        assignmentId: artifact.assignmentId,
        artifactHash: hashContext(artifact)
      }))
      .sort((left, right) => left.assignmentId.localeCompare(right.assignmentId))
    expect(receipt.artifactSetHash).toBe(hashContext(expected))
    expect(receipt.sealedAssignments).toBe(300)
  })

  it('complete frozen split: rejects missing and duplicate results', async () => {
    if (!completeFixture) throw new Error('fixture_missing')
    const { prepared, selectedInput, artifacts } = completeFixture
    const request = {
      tenantId: 'A',
      accountId: 'account-A',
      runId: prepared.source.runId,
      fullRawCases: selectedInput,
      artifacts
    }
    const fresh = new JevReplayJournal(pg.db, generatorVersion)
    await expect(
      fresh.verifyArtifacts({ ...request, artifacts: artifacts.slice(1) })
    ).rejects.toThrow()
    await expect(
      fresh.verifyArtifacts({ ...request, artifacts: [artifacts[0], ...artifacts.slice(0, -1)] })
    ).rejects.toThrow()
  })

  it('complete frozen split: rejects modified and unrelated results', async () => {
    if (!completeFixture) throw new Error('fixture_missing')
    const { prepared, selectedInput, artifacts } = completeFixture
    const request = {
      tenantId: 'A',
      accountId: 'account-A',
      runId: prepared.source.runId,
      fullRawCases: selectedInput,
      artifacts
    }
    const fresh = new JevReplayJournal(pg.db, generatorVersion)
    const altered = structuredClone(artifacts)
    altered[0].latencyMs += 2
    altered[0].otherProcessingMs += 2
    await expect(fresh.verifyArtifacts({ ...request, artifacts: altered })).rejects.toThrow(
      'RECORD_UNAVAILABLE'
    )
    await expect(fresh.verifyArtifacts({ ...request, runId: randomUUID() })).rejects.toThrow()
  })

  it('complete frozen split: rechecks account identity, enabled states and run expiry after the initial database read', async () => {
    if (!completeFixture) throw new Error('fixture_missing')
    const { prepared, selectedInput, artifacts } = completeFixture
    const request = {
      tenantId: 'A',
      accountId: 'account-A',
      runId: prepared.source.runId,
      fullRawCases: selectedInput,
      artifacts
    }
    const original = Administration.prototype.readFrozenEvaluation
    for (const mutation of [
      "UPDATE accounts SET enabled=false WHERE tenant_id='A' AND id='account-A'",
      "UPDATE accounts SET platform='wechat' WHERE tenant_id='A' AND id='account-A'",
      "UPDATE accounts SET employee_id='admin-A' WHERE tenant_id='A' AND id='account-A'",
      "UPDATE employees SET enabled=false WHERE tenant_id='A' AND id='employee-A'"
    ]) {
      const spy = vi
        .spyOn(Administration.prototype, 'readFrozenEvaluation')
        .mockImplementation(async function (this: Administration, tenant, account, run) {
          const source = await original.call(this, tenant, account, run)
          await pg.db.transaction('A', (db) => db.query(mutation))
          return source
        })
      try {
        await expect(
          new JevReplayJournal(pg.db, generatorVersion).verifyArtifacts(request)
        ).rejects.toThrow('CONTEXT_UNAVAILABLE')
      } finally {
        spy.mockRestore()
        await pg.db.transaction('A', async (db) => {
          await db.query(
            "UPDATE accounts SET enabled=true,platform='wework',employee_id='employee-A' WHERE tenant_id='A' AND id='account-A'"
          )
          await db.query(
            "UPDATE employees SET enabled=true WHERE tenant_id='A' AND id='employee-A'"
          )
        })
      }
    }
    const expired = vi
      .spyOn(Administration.prototype, 'readFrozenEvaluation')
      .mockImplementation(async function (this: Administration, tenant, account, run) {
        const source = await original.call(this, tenant, account, run)
        await pg.sql.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE')
        await pg.sql.query(
          "UPDATE evaluation_runs SET expires_at=clock_timestamp()-INTERVAL '1 second' WHERE tenant_id='A' AND account_id='account-A' AND id=$1",
          [run]
        )
        await login()
        return source
      })
    try {
      await expect(
        new JevReplayJournal(pg.db, generatorVersion).verifyArtifacts(request)
      ).rejects.toThrow()
    } finally {
      expired.mockRestore()
    }
  })
})
