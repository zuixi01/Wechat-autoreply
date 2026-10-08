import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { evaluationPlan } from './evaluation-data'
import { Administration } from '../../server/src/admin/administration'
import { PublicationSchema } from '../../server/src/generation/publication'
import { textGeneratorVersion } from '../../server/src/generation/text-generator'
import { JevReplayJournal } from '../../server/src/generation/jev-replay-journal'
import { JevCalibrationDeclarations } from '../../server/src/generation/jev-calibration-declarations'
import { JevCalibratedHoldouts } from '../../server/src/generation/jev-calibrated-holdouts'
import { JevBlindPacketSeals } from '../../server/src/generation/jev-blind-packet-seals'
import { JevBlindLabelReviews } from '../../server/src/generation/jev-blind-label-reviews'
import { replayCaseInputHash } from '../../evals/jev/replay-input'
import { createJevReplayProviderFactory } from '../../evals/jev/replay-providers'
import { executeJevReplayArm, type JevReplayArmArtifact } from '../../evals/jev/replay'
import { createJevBlindReview, type PrivateBlindReviewPacket } from '../../evals/jev/blind-review'
import { hashContext } from '../../src/core/reply/hashes'
import type { JevRequest } from '../../src/shared/contracts/decision'
import { runJevReplayCommand } from '../../server/scripts/jev-replay'
import { createPrivateOutput, writePrivateJson } from '../../evals/memory/private-files'
import type { Postgres } from '../../server/src/database/postgres'

export interface JevHoldoutTestDatabase {
  db: Postgres
  sql: { exec(statement: string): Promise<unknown> }
}
export interface JevHoldoutReadyContext {
  request: Parameters<JevCalibratedHoldouts['freeze']>[0]
  generatorVersion: string
  holdoutInput: unknown
}
export function registerJevCalibratedHoldoutTests(
  createDatabase: () => Promise<JevHoldoutTestDatabase>,
  registerAdditionalTests?: (context: () => JevHoldoutReadyContext) => void
): void {
  // Complete actual protocol execution through mock HTTP transports and SQL.
  // The business marker exercises selection only; all cases and labels are synthetic.
  let pg: JevHoldoutTestDatabase, admin: Administration, journal: JevReplayJournal
  let prepared: Awaited<ReturnType<JevReplayJournal['begin']>>, packet: PrivateBlindReviewPacket
  let publication: ReturnType<typeof PublicationSchema.parse>, runId: string, reviewId: string
  let labels: {
    adjudicatedBy: string
    annotationSource: 'blinded_business_adjudication'
    labels: {
      reviewId: string
      substantialCorrection: boolean
      severeFactError: boolean
      unauthorizedPromise: boolean
      incorrectlyBlocked: boolean
      coveredIntents: number
    }[]
  }
  const artifacts: JevReplayArmArtifact[] = []
  const directory = resolve('.local', `jev-holdout-command-${randomUUID()}`)
  const text = {
    apiKey: 'synthetic-text-key',
    baseUrl: 'https://text.invalid/v1/',
    model: 'text-request',
    expectedModel: 'text-resolved'
  }
  const version = textGeneratorVersion(text),
    plan = evaluationPlan()
  const cases = plan.assignments.map((a) => ({
    ...a,
    conversationId: 'synthetic-peer',
    inbound: ['支持离线阅读吗？']
  }))
  plan.replayProtocol = 'jev-abc-v1'
  plan.assignments = plan.assignments.map((a, i) => ({
    ...a,
    inputHash: replayCaseInputHash(cases[i])
  }))
  const input = { datasetId: plan.datasetId, split: 'calibration', cases: cases.slice(0, 100) }
  const settings = () => ({
    candidates: [publication.policy],
    targets: {
      maximumErrorReleaseRate: 0.01,
      minimumAutomaticCoverage: 0.5,
      minimumAutomaticReplies: 30
    }
  })
  let network: ReturnType<typeof vi.spyOn>
  const fixtureStartedAt = performance.now()
  const profilePath = resolve('.local', 'reports', `jev-holdout-profile-${randomUUID()}.json`)
  const phases: unknown[] = []
  const queryTimings = new Map<string, { calls: number; totalMs: number; maximumMs: number }>()
  function fixturePhase(phase: string): void {
    const observation = {
      fixturePhase: phase,
      elapsedMs: Math.round(performance.now() - fixtureStartedAt),
      artifacts: artifacts.length,
      simulatedRequests: transport.mock.calls.length,
      queryTimings: [...queryTimings].sort((a, b) => b[1].totalMs - a[1].totalMs).slice(0, 8)
    }
    phases.push(structuredClone(observation))
    mkdirSync(resolve('.local', 'reports'), { recursive: true })
    writeFileSync(profilePath, JSON.stringify({ phases }, null, 2))
    process.stdout.write(
      JSON.stringify({
        fixturePhase: observation.fixturePhase,
        elapsedMs: observation.elapsedMs,
        artifacts: observation.artifacts,
        simulatedRequests: observation.simulatedRequests
      }) + '\n'
    )
  }
  async function login(name = 'holdout_fixture_admin') {
    await pg.sql.exec(
      `SET SESSION AUTHORIZATION postgres; RESET ROLE; SET SESSION AUTHORIZATION ${name}`
    )
  }
  async function privileged(sql: string) {
    await pg.sql.exec('SET SESSION AUTHORIZATION postgres; RESET ROLE')
    await pg.sql.exec(sql)
    await login()
  }
  const transport = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    if (body.questions) {
      const request = body as JevRequest
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
                      id === 'human_requested' || (id.startsWith('has_') && id !== 'has_faq')
                        ? 0
                        : 1
                  }
            ])
          )
        }),
        { status: 200 }
      )
    }
    return new Response(
      JSON.stringify({
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
      }),
      { status: 200 }
    )
  })
  function request() {
    return {
      tenantId: 'A',
      accountId: 'account-A',
      runId,
      packet,
      artifacts,
      labels,
      settings: settings(),
      reviewId,
      policyVersion: 'holdout-policy-2',
      configVersion: 'holdout-config-2'
    }
  }
  async function freeze(raw = request()) {
    return new JevCalibratedHoldouts(pg.db, version).freeze(raw)
  }
  async function begin(run: string, split: 'calibration' | 'holdout' = 'holdout') {
    return new JevReplayJournal(pg.db, version).begin({
      tenantId: 'A',
      accountId: 'account-A',
      runId: run,
      fullRawCases: {
        datasetId: plan.datasetId,
        split,
        cases: cases.filter((c) => c.split === split)
      },
      maxRunAttempts: 1000
    })
  }
  async function refusedBegin(run: string, split: 'calibration' | 'holdout', reason: string) {
    // Public journal errors deliberately hide database details. Independently
    // exercise the SQL guard using the same full frozen plan and raw case split.
    await expect(begin(run, split)).rejects.toThrow('RECORD_UNAVAILABLE')
    const frozen = await admin.readFrozenEvaluation('A', 'account-A', run)
    await expect(
      pg.db.transaction('A', (client) =>
        client.query(
          `
    INSERT INTO jev_replay_executions(tenant_id,account_id,id,run_id,employee_id,platform,split,snapshot_hash,
      plan_hash,input_hash,publication_json,plan_json,input_json,pre_question_hash,post_question_hash,
      max_attempts,initial_paused,actor_id,login_name)
    SELECT tenant_id,account_id,$1,$2,employee_id,platform,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,
      pre_question_hash,post_question_hash,1000,true,actor_id,login_name
    FROM jev_replay_executions WHERE tenant_id='A' AND account_id='account-A' AND id=$10`,
          [
            randomUUID(),
            run,
            split,
            frozen.snapshotHash,
            hashContext(frozen.plan),
            hashContext({
              datasetId: plan.datasetId,
              split,
              cases: cases.filter((c) => c.split === split)
            }),
            JSON.stringify(frozen.publication),
            JSON.stringify(frozen.plan),
            JSON.stringify({
              datasetId: plan.datasetId,
              split,
              cases: cases.filter((c) => c.split === split)
            }),
            prepared.executionId
          ]
        )
      )
    ).rejects.toThrow(reason)
  }
  async function counts() {
    return (
      await pg.db.transaction('A', (db) =>
        db.query(`SELECT
    (SELECT count(*)::int FROM evaluation_runs) AS runs,
    (SELECT count(*)::int FROM jev_holdout_lineages) AS lineages,
    (SELECT count(*)::int FROM jev_replay_attempts) AS attempts,
    (SELECT count(*)::int FROM evaluation_approvals) AS approvals,
    (SELECT count(*)::int FROM execution_permits) AS permits`)
      )
    ).rows[0]
  }
  beforeAll(async () => {
    fixturePhase('schema_start')
    pg = await createDatabase()
    const transaction = pg.db.transaction.bind(pg.db)
    pg.db.transaction = (tenant, operation) =>
      transaction(tenant, async (client) => {
        const originalQuery = client.query
        const query = client.query.bind(client)
        client.query = (async (statement: string, values?: unknown[]) => {
          const startedAt = performance.now()
          try {
            return await query(statement, values)
          } finally {
            const key = statement.replace(/\s+/g, ' ').trim().slice(0, 90)
            const timing = queryTimings.get(key) ?? { calls: 0, totalMs: 0, maximumMs: 0 }
            const elapsed = performance.now() - startedAt
            timing.calls++
            timing.totalMs += elapsed
            timing.maximumMs = Math.max(timing.maximumMs, elapsed)
            queryTimings.set(key, timing)
          }
        }) as typeof client.query
        try {
          return await operation(client)
        } finally {
          client.query = originalQuery
        }
      })
    fixturePhase('base_schema_ready')
    for (const name of [
      '045-jev-replay-journal.sql',
      '046-jev-replay-artifact-seals.sql',
      '047-jev-blind-packet-seals.sql',
      '048-jev-blind-label-reviews.sql',
      '049-jev-calibration-declarations.sql',
      '050-jev-calibrated-holdouts.sql',
      '051-jev-replay-scoped-lookups.sql',
      '052-jev-review-single-digest.sql'
    ]) {
      const sql = await readFile(`server/migrations/${name}`, 'utf8')
      await pg.sql.exec(sql)
      await pg.sql.exec(sql)
    }
    await pg.sql
      .exec(`CREATE ROLE holdout_fixture_admin LOGIN NOSUPERUSER NOBYPASSRLS; GRANT autoreply_admin TO holdout_fixture_admin;
    CREATE ROLE holdout_fixture_reviewer LOGIN NOSUPERUSER NOBYPASSRLS; GRANT autoreply_jev_reviewer TO holdout_fixture_reviewer;
    INSERT INTO tenants(id,name) VALUES('A','Synthetic holdout protocol');
    INSERT INTO employees(tenant_id,id,role) VALUES('A','admin-A','admin'),('A','reviewer-A','employee');
    INSERT INTO admin_database_principals(login_name,tenant_id,employee_id) VALUES('holdout_fixture_admin','A','admin-A');`)
    await login()
    fixturePhase('roles_ready')
    admin = new Administration(pg.db, version)
    await admin.provision('A', {
      accountId: 'account-A',
      employeeId: 'employee-A',
      platform: 'wechat'
    })
    await privileged(
      "INSERT INTO jev_reviewer_database_principals(login_name,tenant_id,account_id,employee_id) VALUES('holdout_fixture_reviewer','A','account-A','reviewer-A')"
    )
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
        conversationId: 'synthetic-peer',
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
    runId = (await admin.freezeEvaluation('A', 'account-A', { publication, plan })).runId
    await new JevCalibrationDeclarations(pg.db, version).declare({
      tenantId: 'A',
      accountId: 'account-A',
      runId,
      settings: settings()
    })
    journal = new JevReplayJournal(pg.db, version)
    await journal.setLimit('A', 'account-A', { dailyAttemptLimit: 1000 })
    prepared = await journal.begin({
      tenantId: 'A',
      accountId: 'account-A',
      runId,
      fullRawCases: input,
      maxRunAttempts: 1000
    })
    fixturePhase('execution_ready')
  }, 20000)
  // Every arm still executes all 100 cases through the real core/clients/journal.
  // Each complete arm retains its original 20-second setup ceiling.
  for (const arm of ['A', 'B', 'C'] as const)
    beforeAll(async () => {
      fixturePhase(`arm_${arm}_start`)
      const blocked = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new Error('real_http_forbidden'))
      try {
        const providers = createJevReplayProviderFactory(
          prepared.source,
          { jevApiKey: 'synthetic-jev-key', text, fetch: transport },
          journal
        )
        for (const caseInput of input.cases) {
          const assignment = { runId, caseId: caseInput.caseId, arm, assignmentId: randomUUID() }
          const binding = await journal.bindAssignment(assignment)
          const artifact = await executeJevReplayArm(
            arm,
            {
              frozen: prepared.source,
              caseInput,
              identity: {
                ...prepared.source.authenticatedScope,
                agentId: 'synthetic-agent',
                loginEpoch: 0,
                clientInstanceId: 'synthetic-evaluation'
              }
            },
            providers(assignment),
            undefined,
            assignment.assignmentId
          )
          expect(artifact.status).toBe('candidate')
          await journal.sealArtifact(binding, artifact)
          artifacts.push(artifact)
        }
        expect(blocked).not.toHaveBeenCalled()
        fixturePhase(`arm_${arm}_complete`)
      } finally {
        blocked.mockRestore()
      }
    }, 20000)
  beforeAll(async () => {
    fixturePhase('blind_review_start')
    expect(artifacts).toHaveLength(300)
    expect(transport).toHaveBeenCalledTimes(600)
    const frozen = await admin.readFrozenEvaluation('A', 'account-A', runId)
    packet = createJevBlindReview({
      frozen,
      rawCases: input,
      artifacts,
      dataKind: 'business',
      rubricRef: 'synthetic-protocol-rubric',
      priorAnnotations: {
        annotatedBy: 'synthetic-prior-author',
        cases: input.cases.map((c) => ({
          caseId: c.caseId,
          category: 'faq',
          eligible: true,
          expectedHandoff: false,
          intentCount: 1
        }))
      }
    }).privatePacket
    await new JevBlindPacketSeals(pg.db, version).seal({
      tenantId: 'A',
      accountId: 'account-A',
      runId,
      packet,
      artifacts
    })
    labels = {
      adjudicatedBy: 'reviewer-A',
      annotationSource: 'blinded_business_adjudication',
      labels: packet.mapping.map((m) => ({
        reviewId: m.reviewId,
        substantialCorrection: false,
        severeFactError: false,
        unauthorizedPromise: false,
        incorrectlyBlocked: false,
        coveredIntents: 1
      }))
    }
    await login('holdout_fixture_reviewer')
    reviewId = (
      await new JevBlindLabelReviews(pg.db).submit({
        tenantId: 'A',
        accountId: 'account-A',
        runId,
        packetId: packet.packetId,
        labels
      })
    ).reviewId
    await login()
    await createPrivateOutput(directory)
    for (const [name, value] of [
      ['packet', packet],
      ['artifacts', artifacts],
      ['labels', labels],
      ['settings', settings()]
    ] as const)
      await writePrivateJson(join(directory, `${name}.private.json`), value)
  }, 20000)
  beforeEach(async () => {
    network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('real_http_forbidden'))
    await privileged(`TRUNCATE jev_holdout_lineages; ALTER TABLE jev_replay_executions DISABLE TRIGGER USER;
    ALTER TABLE jev_replay_assignments DISABLE TRIGGER USER; ALTER TABLE jev_replay_attempts DISABLE TRIGGER USER;
    ALTER TABLE jev_replay_results DISABLE TRIGGER USER; ALTER TABLE jev_replay_artifact_seals DISABLE TRIGGER USER;
    DELETE FROM jev_replay_results WHERE attempt_id IN(SELECT t.id FROM jev_replay_attempts t JOIN jev_replay_assignments b ON b.id=t.assignment_id WHERE b.execution_id<>'${prepared.executionId}');
    DELETE FROM jev_replay_attempts WHERE assignment_id IN(SELECT id FROM jev_replay_assignments WHERE execution_id<>'${prepared.executionId}');
    DELETE FROM jev_replay_artifact_seals WHERE assignment_id IN(SELECT id FROM jev_replay_assignments WHERE execution_id<>'${prepared.executionId}');
    DELETE FROM jev_replay_assignments WHERE execution_id<>'${prepared.executionId}';
    ALTER TABLE jev_replay_assignments ENABLE TRIGGER USER; ALTER TABLE jev_replay_attempts ENABLE TRIGGER USER;
    ALTER TABLE jev_replay_results ENABLE TRIGGER USER; ALTER TABLE jev_replay_artifact_seals ENABLE TRIGGER USER;
    DELETE FROM jev_replay_executions WHERE id<>'${prepared.executionId}'; ALTER TABLE jev_replay_executions ENABLE TRIGGER USER;
    ALTER TABLE jev_blind_label_reviews DISABLE TRIGGER USER;
    DELETE FROM jev_blind_label_reviews WHERE id<>'${reviewId}'; ALTER TABLE jev_blind_label_reviews ENABLE TRIGGER USER;
    DELETE FROM evaluation_runs WHERE id<>'${runId}'; UPDATE employees SET enabled=true;`)
  })
  afterEach(() => {
    expect(network).not.toHaveBeenCalled()
    network.mockRestore()
  })
  afterAll(async () => {
    if (pg) await pg.db.close()
  })

  describe('calibration-derived untouched holdout freeze', () => {
    it.each(['verify-holdout', 'correlate-settlements'] as const)(
      'refuses public %s before output when the supplied target is the source packet',
      async (mode) => {
        await freeze()
        const evidenceFiles = {
          calibration: {
            packet: join(directory, 'packet.private.json'),
            artifacts: join(directory, 'artifacts.private.json'),
            labels: join(directory, 'labels.private.json'),
            settings: join(directory, 'settings.private.json'),
            reviewId,
            policyVersion: 'holdout-policy-2',
            configVersion: 'holdout-config-2'
          },
          holdout: {
            packet: join(directory, 'packet.private.json'),
            artifacts: join(directory, 'artifacts.private.json'),
            labels: join(directory, 'labels.private.json'),
            reviewId
          }
        }
        const file = join(directory, `verify-${randomUUID()}.private.json`),
          out = join(directory, `rejected-${randomUUID()}`),
          claims = join(directory, `claims-${randomUUID()}.private.json`)
        await writePrivateJson(file, evidenceFiles)
        if (mode === 'correlate-settlements')
          await writePrivateJson(claims, {
            declaredBillingAccounts: {
              jev: 'synthetic-jev-account',
              text: 'synthetic-text-account'
            },
            exports: []
          })
        const close = vi.fn(async () => {}),
          stdout = vi.fn()
        await expect(
          runJevReplayCommand(
            [
              mode,
              '--tenant',
              'A',
              '--account',
              'account-A',
              '--run',
              runId,
              '--request',
              file,
              ...(mode === 'correlate-settlements' ? ['--settlements', claims] : []),
              '--out',
              out
            ],
            {
              environment: {
                ADMIN_DATABASE_URL: 'synthetic-embedded-only',
                TEXT_MODEL_BASE_URL: text.baseUrl,
                TEXT_MODEL_ID: text.model,
                TEXT_MODEL_EXPECTED_ID: text.expectedModel
              },
              connect: () => Object.assign(Object.create(pg.db), { close }) as Postgres,
              stdout
            }
          )
        ).rejects.toThrow('jev_holdout_split_required')
        await expect(readFile(join(out, 'status.json'))).rejects.toThrow('ENOENT')
        expect(stdout).not.toHaveBeenCalled()
        expect(close).toHaveBeenCalledOnce()
        expect(await counts()).toMatchObject({
          runs: 2,
          lineages: 1,
          attempts: 600,
          approvals: 0,
          permits: 0
        })
      }
    )
    it('rejects settlement scope overrides before opening a database transaction', async () => {
      const before = await counts()
      const transaction = vi.spyOn(pg.db, 'transaction')
      try {
        await expect(
          new JevCalibratedHoldouts(pg.db, version).correlateSettlements({
            evidence: {
              calibration: request(),
              holdout: { packet, artifacts, labels, reviewId }
            },
            settlements: {
              declaredBillingAccounts: {
                jev: 'synthetic-jev-account',
                text: 'synthetic-text-account'
              },
              exports: [],
              scope: { tenantId: 'other', accountId: 'other' }
            }
          } as unknown as Parameters<JevCalibratedHoldouts['correlateSettlements']>[0])
        ).rejects.toThrow('jev_settlement_request_invalid')
        expect(transaction).not.toHaveBeenCalled()
      } finally {
        transaction.mockRestore()
      }
      expect(await counts()).toEqual(before)
    })
    it('checks the requested account with the real administrator login before settlement correlation', async () => {
      const before = await counts()
      await expect(
        new JevCalibratedHoldouts(pg.db, version).correlateSettlements({
          evidence: {
            calibration: { ...request(), accountId: 'missing-synthetic-account' },
            holdout: {
              packet: { ...packet, input: { ...packet.input, split: 'holdout' } },
              artifacts,
              labels,
              reviewId
            }
          },
          settlements: {
            declaredBillingAccounts: {
              jev: 'synthetic-jev-account',
              text: 'synthetic-text-account'
            },
            exports: []
          }
        })
      ).rejects.toThrow('jev_holdout_context_invalid')
      expect(await counts()).toEqual(before)
    })
    it('refuses calibration packets as holdout evidence without creating a lineage', async () => {
      await expect(
        new JevCalibratedHoldouts(pg.db, version).verify({
          calibration: request(),
          holdout: { packet, artifacts, labels, reviewId }
        })
      ).rejects.toThrow('jev_holdout_split_required')
      expect(await counts()).toMatchObject({
        runs: 1,
        lineages: 0,
        attempts: 600,
        approvals: 0,
        permits: 0
      })
    })
    it('requires an existing lineage before recomputing evidence and never creates a freeze', async () => {
      await expect(
        new JevCalibratedHoldouts(pg.db, version).verify({
          calibration: request(),
          holdout: {
            packet: { ...packet, input: { ...packet.input, split: 'holdout' } },
            artifacts,
            labels,
            reviewId
          }
        })
      ).rejects.toThrow('jev_holdout_lineage_required')
      expect(await counts()).toMatchObject({
        runs: 1,
        lineages: 0,
        attempts: 600,
        approvals: 0,
        permits: 0
      })
    })
    it('refuses source-version packets on an existing target lineage', async () => {
      await freeze()
      await expect(
        new JevCalibratedHoldouts(pg.db, version).verify({
          calibration: request(),
          holdout: {
            packet: { ...packet, input: { ...packet.input, split: 'holdout' } },
            artifacts,
            labels,
            reviewId
          }
        })
      ).rejects.toThrow('database_freeze_mismatch')
      expect(await counts()).toMatchObject({
        runs: 2,
        lineages: 1,
        attempts: 600,
        approvals: 0,
        permits: 0
      })
    })
    it('runs the public freeze command against full private evidence without calls or approval', async () => {
      const close = vi.fn(async () => {}),
        out = join(directory, `output-${randomUUID()}`)
      const args = [
        'freeze-holdout',
        '--tenant',
        'A',
        '--account',
        'account-A',
        '--run',
        runId,
        '--packet',
        join(directory, 'packet.private.json'),
        '--artifacts',
        join(directory, 'artifacts.private.json'),
        '--labels',
        join(directory, 'labels.private.json'),
        '--settings',
        join(directory, 'settings.private.json'),
        '--review-id',
        reviewId,
        '--policy-version',
        'holdout-policy-2',
        '--config-version',
        'holdout-config-2',
        '--out',
        out
      ]
      expect(
        await runJevReplayCommand(args, {
          environment: {
            ADMIN_DATABASE_URL: 'synthetic-embedded-only',
            TEXT_MODEL_BASE_URL: text.baseUrl,
            TEXT_MODEL_ID: text.model,
            TEXT_MODEL_EXPECTED_ID: text.expectedModel
          },
          connect: () => Object.assign(Object.create(pg.db), { close }) as Postgres,
          stdout: () => {}
        })
      ).toBe(0)
      expect(close).toHaveBeenCalledOnce()
      const status = JSON.parse(await readFile(join(out, 'status.json'), 'utf8'))
      expect(status).toMatchObject({
        mode: 'calibrated_holdout_frozen',
        modelsCalled: false,
        monetaryBudgetVerified: false,
        releaseAuthorized: false
      })
      expect(await counts()).toMatchObject({
        runs: 2,
        lineages: 1,
        attempts: 600,
        approvals: 0,
        permits: 0
      })
    })
    it('derives a new policy/version and preserves full original knowledge, model and sample split', async () => {
      const result = await freeze()
      expect(result.calibration).toMatchObject({
        sampleCount: 100,
        status: 'recommended_for_frozen_holdout',
        releaseAuthorized: false
      })
      expect(result.receipt).toMatchObject({
        sourceRunId: runId,
        reviewId,
        calibrationReportHash: hashContext(result.calibration),
        evaluationOnly: true,
        releaseAuthorized: false
      })
      expect(result.receipt.targetRunId).not.toBe(runId)
      expect(result.publication).toEqual({
        ...publication,
        policy: { ...publication.policy, version: 'holdout-policy-2' },
        configuration: {
          ...publication.configuration,
          configVersion: 'holdout-config-2',
          decisionPolicyVersion: 'holdout-policy-2'
        }
      })
      const target = await admin.readFrozenEvaluation('A', 'account-A', result.receipt.targetRunId)
      expect(target.plan).toEqual(plan)
      expect(await counts()).toEqual({
        runs: 2,
        lineages: 1,
        attempts: 600,
        approvals: 0,
        permits: 0
      })
    })
    it('recovers the same freeze and report after holdout starts without creating a second run', async () => {
      const first = await freeze()
      expect((await begin(first.receipt.targetRunId)).input.cases).toHaveLength(200)
      expect(await freeze()).toEqual(first)
      expect(await counts()).toMatchObject({ runs: 2, lineages: 1, attempts: 600, approvals: 0 })
    })
    it('refuses an already-started source holdout even with no requests', async () => {
      await begin(runId)
      await expect(freeze()).rejects.toThrow('jev_holdout_previously_exposed')
      expect(await counts()).toMatchObject({ runs: 1, lineages: 0, attempts: 600 })
    })
    it('detects prior exposure under another run in the same account and dataset', async () => {
      const other = await admin.freezeEvaluation('A', 'account-A', { publication, plan })
      await begin(other.runId)
      await expect(freeze()).rejects.toThrow('jev_holdout_previously_exposed')
      expect(await counts()).toMatchObject({ runs: 2, lineages: 0 })
    })
    it('reserves original holdout groups for the derived target and rejects its calibration split', async () => {
      const result = await freeze()
      await refusedBegin(runId, 'holdout', 'jev_holdout_reserved_for_target')
      await refusedBegin(
        result.receipt.targetRunId,
        'calibration',
        'jev_holdout_target_split_invalid'
      )
      const other = await admin.freezeEvaluation('A', 'account-A', { publication, plan })
      await refusedBegin(other.runId, 'holdout', 'jev_holdout_reserved_for_target')
      expect((await begin(result.receipt.targetRunId)).input.cases).toHaveLength(200)
    })
    it('refuses changed versions on retry and does not overwrite the original freeze', async () => {
      const first = await freeze()
      await expect(freeze({ ...request(), configVersion: 'changed-config' })).rejects.toThrow(
        'jev_holdout_lineage_changed'
      )
      expect(await freeze()).toEqual(first)
      expect(await counts()).toMatchObject({ runs: 2, lineages: 1 })
    })
    it('refuses reused source versions and rolls back all new records', async () => {
      await expect(
        freeze({
          ...request(),
          policyVersion: publication.policy.version,
          configVersion: publication.configuration.configVersion
        })
      ).rejects.toThrow('jev_holdout_publication_changed')
      expect(await counts()).toMatchObject({ runs: 1, lineages: 0 })
    })
    it('rejects changed artifacts or independent labels without a new freeze', async () => {
      const changed = structuredClone(request())
      changed.artifacts[0].latencyMs += 1
      await expect(freeze(changed)).rejects.toThrow()
      const forged = structuredClone(request())
      forged.labels.labels[0].substantialCorrection = true
      await expect(freeze(forged)).rejects.toThrow('jev_blind_review_changed')
      expect(await counts()).toMatchObject({ runs: 1, lineages: 0 })
    })
    it('blocks the target after reviewer disablement while original observations remain intact', async () => {
      const result = await freeze()
      await privileged("UPDATE employees SET enabled=false WHERE id='reviewer-A'")
      await refusedBegin(result.receipt.targetRunId, 'holdout', 'jev_blind_reviewer_denied')
      await expect(freeze()).rejects.toThrow('jev_blind_reviewer_denied')
      expect(await counts()).toMatchObject({ runs: 2, lineages: 1, attempts: 600 })
    })
    it('rejects an obsolete target after a real independent revision and freezes the latest review', async () => {
      const first = await freeze()
      const revised = { ...labels, labels: [...labels.labels].reverse() }
      await login('holdout_fixture_reviewer')
      const next = await new JevBlindLabelReviews(pg.db).submit({
        tenantId: 'A',
        accountId: 'account-A',
        runId,
        packetId: packet.packetId,
        labels: revised
      })
      await login()
      await refusedBegin(first.receipt.targetRunId, 'holdout', 'jev_blind_review_stale')
      await expect(freeze()).rejects.toThrow('jev_blind_review_stale')
      const second = await freeze({
        ...request(),
        reviewId: next.reviewId,
        labels: revised,
        policyVersion: 'holdout-policy-3',
        configVersion: 'holdout-config-3'
      })
      expect(second.receipt.targetRunId).not.toBe(first.receipt.targetRunId)
      expect((await begin(second.receipt.targetRunId)).input.cases).toHaveLength(200)
      expect(await counts()).toMatchObject({
        runs: 3,
        lineages: 2,
        attempts: 600,
        approvals: 0,
        permits: 0
      })
    })
    it('retains login and tenant row isolation on all six ledger tables after the policy upgrade', async () => {
      const tables = [
        'jev_replay_limits',
        'jev_replay_executions',
        'jev_replay_assignments',
        'jev_replay_attempts',
        'jev_replay_results',
        'jev_replay_artifact_seals'
      ]
      const readCounts = (tenant: string) =>
        pg.db.transaction(tenant, async (client) => {
          const found = []
          for (const table of tables)
            found.push(
              (await client.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count
            )
          return found
        })
      expect(await readCounts('A')).toEqual([1, 1, 300, 600, 600, 300])
      expect(await readCounts('unmapped-tenant')).toEqual([0, 0, 0, 0, 0, 0])
      await privileged(
        "UPDATE admin_database_principals SET enabled=false WHERE login_name='holdout_fixture_admin'"
      )
      try {
        expect(await readCounts('A')).toEqual([0, 0, 0, 0, 0, 0])
      } finally {
        await privileged(
          "UPDATE admin_database_principals SET enabled=true WHERE login_name='holdout_fixture_admin'"
        )
      }
      expect(await readCounts('A')).toEqual([1, 1, 300, 600, 600, 300])
    })
    for (const change of ['disablement', 'revision'] as const)
      it(`blocks new calls after holdout starts and reviewer ${change}, but preserves an existing receipt`, async () => {
        const result = await freeze()
        const target = new JevReplayJournal(pg.db, version)
        await target.begin({
          tenantId: 'A',
          accountId: 'account-A',
          runId: result.receipt.targetRunId,
          fullRawCases: { datasetId: plan.datasetId, split: 'holdout', cases: cases.slice(100) },
          maxRunAttempts: 1000
        })
        const bound = []
        for (const c of cases.slice(100, 102))
          bound.push(
            await target.bindAssignment({
              runId: result.receipt.targetRunId,
              caseId: c.caseId,
              arm: 'A',
              assignmentId: randomUUID()
            })
          )
        const start = {
          provider: 'text' as const,
          requestHash: 'a'.repeat(64),
          requestedModel: text.model
        }
        const handle = await target.reserve(bound[0], 'text', start)
        if (change === 'disablement')
          await privileged("UPDATE employees SET enabled=false WHERE id='reviewer-A'")
        else {
          await login('holdout_fixture_reviewer')
          await new JevBlindLabelReviews(pg.db).submit({
            tenantId: 'A',
            accountId: 'account-A',
            runId,
            packetId: packet.packetId,
            labels: { ...labels, labels: [...labels.labels].reverse() }
          })
          await login()
        }
        await expect(target.reserve(bound[1], 'text', start)).rejects.toThrow('RECORD_UNAVAILABLE')
        await expect(
          target.bindAssignment({
            runId: result.receipt.targetRunId,
            caseId: cases[102].caseId,
            arm: 'A',
            assignmentId: randomUUID()
          })
        ).rejects.toThrow('RECORD_UNAVAILABLE')
        await handle.finish({ outcome: 'response', durationMs: 1, actualModel: text.expectedModel })
        expect((await target.readAttempts(bound[0]))[0].result).toMatchObject({
          outcome: 'response'
        })
        expect(await target.readAttempts(bound[1])).toEqual([])
        expect(await counts()).toMatchObject({ attempts: 601, approvals: 0, permits: 0 })
      })
  })
  registerAdditionalTests?.(() => ({
    request: request(),
    generatorVersion: version,
    holdoutInput: { datasetId: plan.datasetId, split: 'holdout', cases: cases.slice(100) }
  }))
}
