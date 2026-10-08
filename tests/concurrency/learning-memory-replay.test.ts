import { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, readdir, writeFile, appendFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Postgres } from '../../server/src/database/postgres'
import { AccountAuthority, tokenHash } from '../../server/src/auth/account-authority'
import { ExecutionAuthority } from '../../server/src/execution/execution-authority'
import { EnterpriseLearningWorkerAuthority } from '../../server/src/learning/learning-worker-authority'
import {
  EnterpriseLearningRepository,
  enterpriseMemoryScope
} from '../../server/src/learning/learning-repository'
import {
  EnterpriseLearningValidationBudget,
  type EnterpriseValidationRun
} from '../../server/src/learning/learning-validation-budget'
import { EnterpriseEvaluationCheckpoint } from '../../server/src/learning/learning-evaluation-checkpoint'
import { EnterpriseEvaluationEvidence } from '../../server/src/learning/learning-evaluation-evidence'
import type { VerifiedForegroundObservation } from '../../server/src/learning/learning-foreground-evidence'
import { withLearningAccount } from '../../server/src/learning/learning-account'
import { loadEnterpriseMemoryCatalog } from '../../server/src/learning/learning-publication'
import {
  EnterpriseMemoryReplay,
  adjudicateEnterpriseMemoryReplay,
  type EnterpriseMemoryReplayPacket
} from '../../server/src/learning/learning-memory-replay'
import {
  savePublication,
  loadPublication,
  type Publication
} from '../../server/src/generation/publication'
import { textGeneratorVersion } from '../../server/src/generation/text-generator'
import type { JevRequest, JevResponse } from '../../src/shared/contracts/decision'
import { seedSyntheticApproval } from '../fixtures/evaluation-approval'
import { evaluateMemoryDataset } from '../../evals/memory/metrics'
import { verifyPrivatePaths } from '../../src/core/persistence/private-backup-directory'
import { hashContext } from '../../src/core/reply/hashes'
import { protectPrivateDirectory } from '../../src/core/persistence/private-backup-directory'

const execute = promisify(execFile)
let cluster: Pool, root: Pool, appDb: Postgres, workerDb: Postgres
let database: string, workerUrl: string
let authority: EnterpriseLearningWorkerAuthority
let collector: EnterpriseMemoryReplay | undefined
let input: Record<string, unknown>
let baseUrl: string
let completedEvidence:
  | { runId: string; packet: EnterpriseMemoryReplayPacket; directory: string }
  | undefined
let completedForeground:
  | {
      directory: string
      runId: string
      sessionId: string
      observations: VerifiedForegroundObservation[]
    }
  | undefined
const credential = 'R'.repeat(43),
  reference = randomUUID()
const requests: string[] = []
const modelServer = createServer(async (request, response) => {
  try {
    let body = ''
    for await (const chunk of request) body += String(chunk)
    requests.push(body)
    let result: unknown
    if (request.url === '/jev') {
      const request = JSON.parse(body) as JevRequest
      const answers: JevResponse['answers'] = {}
      for (const [id, q] of Object.entries(request.questions))
        answers[id] =
          q.type === 'choice'
            ? {
                type: 'choice',
                choice: 'price',
                confidence: 0.99,
                probabilities: { faq: 0, price: 1, order: 0, aftersales: 0, other: 0 }
              }
            : {
                type: 'noul',
                noul:
                  id === 'human_requested' || (id.startsWith('has_') && id !== 'has_price') ? 0 : 1
              }
      result = { model: 'synthetic-jev', answers, usage: { input_tokens: 10, output_tokens: 5 } }
    } else
      result = {
        model: 'synthetic-text',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: JSON.stringify({
                text: '请提供型号和数量。',
                evidenceIds: ['synthetic-price']
              })
            }
          }
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 }
      }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(result))
  } catch {
    response.statusCode = 500
    response.end('{}')
  }
})
const text = (): { apiKey: string; baseUrl: string; model: string; expectedModel: string } => ({
  apiKey: 'synthetic-text-key',
  baseUrl: 'https://synthetic.invalid/v1/',
  model: 'synthetic-text',
  expectedModel: 'synthetic-text'
})
const counts = async (): Promise<Record<string, unknown>> =>
  (
    await root.query(
      'SELECT (SELECT count(*) FROM learning_episodes)::int AS episodes,(SELECT count(*) FROM learning_preparations)::int AS preparations,(SELECT count(*) FROM generation_tasks)::int AS tasks,(SELECT count(*) FROM execution_permits)::int AS permits,(SELECT count(*) FROM learning_activation_grants)::int AS grants'
    )
  ).rows[0]

beforeAll(async () => {
  const url = new URL(process.env.AUTOREPLY_POSTGRES_TEST_URL ?? 'about:blank')
  const password = process.env.AUTOREPLY_POSTGRES_TEST_PASSWORD ?? ''
  if (
    url.hostname !== '127.0.0.1' ||
    url.username !== 'postgres' ||
    !/^\/autoreply_concurrency_[a-f0-9]{32}$/.test(url.pathname) ||
    !/^[a-f0-9]{64}$/.test(password) ||
    !process.env.AUTOREPLY_POSTGRES_TEST_REPORT
  )
    throw new Error('use_isolated_postgres_runner')
  const suffix = randomUUID().replaceAll('-', '')
  database = `replay_${suffix}`
  const appLogin = `replay_app_${suffix}`,
    workerLogin = `replay_worker_${suffix}`
  cluster = new Pool({ connectionString: url.href, max: 1 })
  await cluster.query(`CREATE DATABASE ${database}`)
  const isolated = new URL(url)
  isolated.pathname = `/${database}`
  root = new Pool({
    connectionString: isolated.href,
    max: 5,
    options: '-c search_path=autoreply,public'
  })
  for (const file of (await readdir(resolve('server/migrations')))
    .filter((f) => /^\d{3}-.+\.sql$/.test(f))
    .sort()) {
    const sql = await readFile(resolve('server/migrations', file), 'utf8')
    await root.query(sql)
    await root.query(sql)
  }
  for (const [login, role] of [
    [appLogin, 'autoreply_app'],
    [workerLogin, 'autoreply_learning_worker']
  ])
    await root.query(
      `CREATE ROLE ${login} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB PASSWORD '${password}'; GRANT ${role} TO ${login}`
    )
  await root.query(
    "INSERT INTO tenants(id,name) VALUES('company','合成三组回放'); INSERT INTO employees(tenant_id,id,role) VALUES('company','employee','employee'); INSERT INTO accounts(tenant_id,id,employee_id,platform,paused) VALUES('company','account-A','employee','wework',false)"
  )
  await root.query(
    "INSERT INTO agents(tenant_id,id,account_id,employee_id,token_hash) VALUES('company','agent-A','account-A','employee',$1)",
    [tokenHash(credential)]
  )
  await root.query(
    'INSERT INTO learning_worker_bindings(id,login_name,tenant_id,account_id,employee_id,agent_id,agent_token_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [reference, workerLogin, 'company', 'account-A', 'employee', 'agent-A', tokenHash(credential)]
  )
  const connection = (login: string): string => {
    const copy = new URL(isolated)
    copy.username = login
    copy.password = password
    return copy.href
  }
  appDb = new Postgres(connection(appLogin))
  workerUrl = connection(workerLogin)
  workerDb = new Postgres(workerUrl)
  authority = new EnterpriseLearningWorkerAuthority(workerDb)
  const repository = new EnterpriseLearningRepository(authority)
  const episode = await repository.recordEpisode(reference, null, {
    sourceId: 'synthetic-training',
    topic: '询价',
    startedAt: Date.now(),
    messages: [],
    correction: '先核对型号和数量',
    outcome: 'corrected',
    identityStatus: 'verified'
  })
  const memory = await repository.propose(reference, null, {
    content: {
      kind: 'lesson',
      scenario: '询价',
      guidance: '先核对型号和数量',
      rationale: '',
      steps: [],
      pitfalls: [],
      verification: []
    },
    evidence: [{ episodeId: episode.id }],
    source: 'human',
    reason: '合成手工教学，不能代表业务人工标注'
  })
  await repository.activate(reference, null, memory.id, 1)
  await new Promise<void>((done) => modelServer.listen(0, '127.0.0.1', done))
  baseUrl = `http://127.0.0.1:${(modelServer.address() as AddressInfo).port}/v1/`
  const catalog = await withLearningAccount(authority, reference, null, loadEnterpriseMemoryCatalog)
  const at = Date.now()
  const publication: Publication = {
    configuration: {
      configVersion: 'config-replay',
      knowledgeVersion: 'knowledge-replay',
      decisionPolicyVersion: 'policy-replay',
      questionSetVersion: 'questions-replay',
      modelResolved: 'synthetic-jev',
      automaticEnabled: true,
      memoryCorpusVersion: catalog.memoryCorpusVersion
    },
    policy: {
      version: 'policy-replay',
      knowledgeVersion: 'knowledge-replay',
      questionSetVersion: 'questions-replay',
      mode: 'enforced',
      modelAlias: 'synthetic-alias',
      modelResolved: 'synthetic-jev',
      evaluationApproved: true,
      automaticIntents: ['price'],
      minimumChoiceProbability: 0.8,
      minimumChoiceConfidence: 0.8,
      minimumChoiceMargin: 0.3,
      presentIntentProbability: 0.8,
      humanRequestThreshold: 0.3,
      minimumAuditProbability: 0.9,
      reviewValidityMs: 30000,
      preBudgetMs: 3000,
      postBudgetMs: 3000
    },
    evidence: [
      {
        evidenceId: 'synthetic-price',
        tenantId: 'company',
        accountId: 'account-A',
        intent: 'price',
        knowledgeVersion: 'knowledge-replay',
        kind: 'approved_faq',
        content: '请提供型号和数量。',
        source: 'synthetic-only',
        approvedBy: 'employee',
        validFrom: at - 1000,
        expiresAt: at + 86400000
      }
    ],
    replyRules: '简洁中文',
    textGeneratorVersion: textGeneratorVersion(text()),
    ...catalog
  }
  // Isolated privileged engineering admission, never evidence of real human business approval.
  const approved = await seedSyntheticApproval(
    {
      adminQuery: async (sql, values) => {
        const result = await root.query(sql, values)
        return { ...result, rowCount: result.rowCount ?? result.rows.length }
      }
    },
    publication
  )
  const device = new AccountAuthority(appDb)
  await savePublication(
    device,
    new ExecutionAuthority(device, async (client, scope) => {
      await loadPublication(client, scope)
    }),
    credential,
    approved
  )
  input = {
    version: 1,
    datasetId: 'synthetic-postgres-replay',
    origin: 'synthetic',
    rubricRef: 'human-only-rubric',
    maxRequests: 9,
    backgroundCostUsd: 0,
    legacy: [{ scenario: '询价', guidance: '静态询问型号', rationale: '' }],
    sources: [
      {
        caseId: episode.id,
        conversationId: 'account',
        split: 'learn',
        label: { origin: 'synthetic', blinded: false, labelledAt: at }
      }
    ],
    cases: [
      { caseId: 'held-1', conversationId: 'independent-1', category: 'inquiry', inbound: ['询价'] }
    ]
  }
})

afterAll(async () => {
  await collector?.drain()
  modelServer.closeAllConnections()
  if (modelServer.listening) await new Promise<void>((done) => modelServer.close(() => done()))
  await Promise.allSettled([appDb?.close(), workerDb?.close(), root?.end()])
  if (cluster && /^replay_[a-f0-9]{32}$/.test(database))
    await cluster.query(`DROP DATABASE ${database}`)
  await cluster?.end()
})

describe('actual PostgreSQL and loopback HTTP three-arm memory evidence', () => {
  it('uses dedicated worker authority, nine real HTTP calls and exact fee references without learning or permits', async () => {
    const phase = async (stage: string): Promise<void> => {
      await appendFile(
        join(process.env.AUTOREPLY_POSTGRES_TEST_REPORT!, 'frozen-evidence-phases.jsonl'),
        JSON.stringify({ stage, at: Date.now(), requests: requests.length }) + '\n'
      )
    }
    await phase('started')
    const before = await counts()
    const nativeFetch = fetch
    let runId = ''
    let savedRun: EnterpriseValidationRun | undefined
    let completedArms = 0
    const foregroundInputs: string[] = []
    const foregroundResults: string[] = []
    const foregroundContexts: unknown[] = []
    collector = new EnterpriseMemoryReplay(workerDb, authority, {
      text: text(),
      jevApiKey: 'synthetic-jev-key',
      workerId: 'replay-engineering',
      // Simulated host inputs only. This is not a native platform or human-business proof.
      foregroundTask: async ({ task, item }) => {
        const context = item.inbound.map((value, i) => ({
          sequence: 5 + i,
          sourceMessageId: randomUUID(),
          direction: 'inbound' as const,
          kind: 'text' as const,
          text: value
        }))
        const actual = {
          ...task,
          taskId: randomUUID(),
          identity: {
            ...task.identity,
            loginEpoch: 7,
            clientInstanceId: 'synthetic-host-not-native'
          },
          inboundRange: { from: 5, to: 4 + context.length },
          contextHash: hashContext(context)
        }
        foregroundInputs.push(hashContext(actual))
        foregroundContexts.push(structuredClone(context))
        return { task: actual, context, inbound: item.inbound }
      },
      foregroundResult: async ({ task, result }) => {
        foregroundResults.push(hashContext(task))
        expect(result.draft?.text).toBe('请提供型号和数量。')
        if (result.draft) result.draft.text = 'synthetic-host-mutation-not-authoritative'
      },
      onRun: async (id) => {
        await phase('frozen_before_http')
        runId = id
        savedRun = await withLearningAccount(authority, reference, null, async (client, scope) => {
          const row = (
            await client.query(
              'SELECT claim_token,lease_until FROM learning_validation_runs WHERE id=$1',
              [id]
            )
          ).rows[0]
          return {
            id,
            claimToken: String(row.claim_token),
            leaseUntil: Number(row.lease_until),
            scope: enterpriseMemoryScope(scope, null),
            timeoutMs: 30000
          }
        })
        expect(requests).toHaveLength(0)
        expect(
          (
            await root.query('SELECT state FROM learning_evaluation_checkpoints WHERE run_id=$1', [
              id
            ])
          ).rows
        ).toEqual([{ state: 'collecting' }])
        expect(
          (
            await root.query(
              'SELECT count(*)::int AS n FROM learning_evaluation_arms WHERE run_id=$1 AND state=$2',
              [id, 'pending']
            )
          ).rows[0]
        ).toEqual({ n: 3 })
      },
      fetch: async (url, init) => {
        const taskHash = foregroundInputs.at(-1)!
        expect(
          (
            await root.query(
              'SELECT task_hash FROM learning_evaluation_execution_tasks WHERE run_id=$1 AND task_hash=$2',
              [runId, taskHash]
            )
          ).rows
        ).toEqual([{ task_hash: taskHash }])
        const address = String(url)
        if (address.startsWith('https://api.typesafe.ai/'))
          return nativeFetch(new URL('/jev', baseUrl), init)
        if (!address.startsWith(text().baseUrl)) throw new Error('test_loopback_only')
        const sent = JSON.parse(String(init?.body)) as {
          messages: { role: string; content: string }[]
        }
        const prompt = JSON.parse(sent.messages.find((message) => message.role === 'user')!.content)
        expect(prompt.untrusted_conversation).toEqual(foregroundContexts.at(-1))
        return nativeFetch(new URL('/v1/chat/completions', baseUrl), init)
      }
    })
    const packet = await collector.collect(reference, input, undefined, async () => {
      if (++completedArms !== 3) return
      // New service instances must honor all nine actual admissions already in PostgreSQL.
      const budget = new EnterpriseLearningValidationBudget(workerDb, authority)
      const checkpoint = new EnterpriseEvaluationCheckpoint(authority, budget)
      await expect(
        budget.reserve(reference, savedRun!, 100, 100, (client, scope, at) =>
          checkpoint.assertRequestBudgetWithin(client, scope, savedRun!, at)
        )
      ).rejects.toThrow('evaluation_request_budget_exceeded')
    })
    await phase('nine_http_completed')
    expect(foregroundInputs).toHaveLength(3)
    expect(foregroundResults).toEqual(foregroundInputs)
    expect(
      (
        await root.query(
          'SELECT receipt FROM learning_evaluation_arms WHERE run_id=$1 ORDER BY ordinal',
          [runId]
        )
      ).rows.map((r) => r.receipt)
    ).toEqual(packet.receipts)
    expect(requests).toHaveLength(9)
    expect(requests.every((body) => !body.includes('human-only-rubric'))).toBe(true)
    expect(await counts()).toEqual(before)
    for (const r of packet.receipts) {
      expect(r).toMatchObject({ inputTokens: 30, outputTokens: 15, costUsd: null })
      expect(r.modelCallRefs).toHaveLength(3)
    }
    expect(
      (
        await root.query(
          "SELECT count(*)::int AS n FROM learning_attempts WHERE purpose='evaluation' AND measurement='reported'"
        )
      ).rows[0]
    ).toEqual({ n: 9 })
    expect(
      (await root.query('SELECT count(*)::int AS n FROM learning_background_leases')).rows[0]
    ).toEqual({ n: 0 })
    const evidenceCheckpoint = new EnterpriseEvaluationCheckpoint(
      authority,
      new EnterpriseLearningValidationBudget(workerDb, authority)
    )
    const durableBeforeRead = (
      await root.query(
        'SELECT to_jsonb(c) AS checkpoint,to_jsonb(r) AS run FROM learning_evaluation_checkpoints c JOIN learning_validation_runs r ON r.id=c.run_id WHERE c.run_id=$1',
        [runId]
      )
    ).rows
    const frozenEvidence = await evidenceCheckpoint.readCompleted(reference, runId)
    expect(frozenEvidence.executionTasks.map((value) => value.taskHash).sort()).toEqual(
      [...foregroundInputs].sort()
    )
    for (const receipt of packet.receipts) expect(receipt.executionTaskHashes).toHaveLength(1)
    await phase('readonly_completed')
    expect(frozenEvidence.receipts).toEqual(packet.receipts)
    expect(frozenEvidence.assignments.map((a) => a.assignmentId)).toEqual(
      packet.receipts.map((r) => r.assignmentId)
    )
    expect(requests).toHaveLength(9)
    expect(await counts()).toEqual(before)
    expect(
      (
        await root.query(
          'SELECT to_jsonb(c) AS checkpoint,to_jsonb(r) AS run FROM learning_evaluation_checkpoints c JOIN learning_validation_runs r ON r.id=c.run_id WHERE c.run_id=$1',
          [runId]
        )
      ).rows
    ).toEqual(durableBeforeRead)
    const labels = packet.receipts.map((r) => ({
      assignmentId: r.assignmentId,
      origin: 'synthetic',
      reviewerId: 'synthetic-reviewer',
      evidenceRef: 'synthetic-only',
      labelledAt: Date.now() + 1,
      blinded: true,
      humanReviewed: r.reply !== null,
      substantialCorrection: false,
      severeError: false,
      validAnswer: r.reply !== null,
      costUsd: 0,
      costEvidenceRef: 'synthetic-loopback-no-charge'
    }))
    const report = evaluateMemoryDataset(adjudicateEnterpriseMemoryReplay(packet, labels))
    expect(report.assessment.status).toBe('insufficient')
    const directory = resolve('.local/reports/postgres-memory-replay', randomUUID())
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'packet.private.json'), JSON.stringify(packet))
    await writeFile(join(directory, 'labels.private.json'), JSON.stringify(labels))
    completedEvidence = { runId, packet, directory }
    await phase('evidence_exported')
  })

  it('imports the original enterprise packet in a distinct CLI process with a private output and synthetic verdict', async () => {
    expect(completedEvidence).toBeDefined()
    const { directory } = completedEvidence!
    const imported = await execute(
      process.execPath,
      [
        resolve('node_modules/tsx/dist/cli.mjs'),
        resolve('scripts/memory-replay.ts'),
        'adjudicate',
        join(directory, 'packet.private.json'),
        join(directory, 'labels.private.json'),
        join(directory, 'imported')
      ],
      { timeout: 10000, windowsHide: true }
    )
    expect(imported.stdout).toContain('Adjudication imported')
    const saved = JSON.parse(await readFile(join(directory, 'imported/labelled.json'), 'utf8'))
    expect(evaluateMemoryDataset(saved).assessment.status).toBe('insufficient')
    await verifyPrivatePaths(join(directory, 'imported'), [
      join(directory, 'imported/labelled.json')
    ])
  })

  it('authenticates original frozen evidence read-only, rejects altered exports and fee loss, and uses no provider credentials in the CLI', async () => {
    expect(completedEvidence).toBeDefined()
    const { runId, packet, directory } = completedEvidence!
    const verifier = new EnterpriseEvaluationEvidence(workerDb, authority)
    const before = await counts()
    const httpBefore = requests.length
    const durable = async (): Promise<unknown> =>
      (
        await root.query(
          'SELECT to_jsonb(c) AS checkpoint,to_jsonb(r) AS run FROM learning_evaluation_checkpoints c JOIN learning_validation_runs r ON r.id=c.run_id WHERE c.run_id=$1',
          [runId]
        )
      ).rows
    const initial = await durable()
    const result = await verifier.verify(reference, runId, packet)
    expect(result).toMatchObject({
      runId,
      serverFrozenBatchVerified: true,
      foregroundVerified: false,
      businessVerified: false
    })
    expect(result.assignments).toHaveLength(3)
    await expect(verifier.verify(reference, randomUUID(), packet)).rejects.toThrow(
      'evaluation_checkpoint_unavailable'
    )
    await expect(verifier.verify(randomUUID(), runId, packet)).rejects.toThrow('DENIED')
    await expect(
      new EnterpriseEvaluationEvidence(appDb, new EnterpriseLearningWorkerAuthority(appDb)).verify(
        reference,
        runId,
        packet
      )
    ).rejects.toThrow('DENIED')
    await expect(
      new EnterpriseEvaluationEvidence(appDb, new AccountAuthority(appDb)).verify(
        credential,
        runId,
        packet
      )
    ).rejects.toThrow('permission denied')
    const changed = structuredClone(packet) as { receipts: { reply: string | null }[] }
    changed.receipts[0].reply = '篡改的回复'
    await expect(verifier.verify(reference, runId, changed)).rejects.toThrow(
      'evaluation_server_evidence_conflict'
    )
    const changedBlind = structuredClone(packet) as { blind: { reply: string | null }[] }
    changedBlind.blind[0].reply = '篡改的盲评回复'
    await expect(verifier.verify(reference, runId, changedBlind)).rejects.toThrow(
      'evaluation_server_evidence_conflict'
    )
    const expiry = (
      await root.query('SELECT expires_at FROM learning_evaluation_checkpoints WHERE run_id=$1', [
        runId
      ])
    ).rows[0].expires_at
    await root.query('UPDATE learning_evaluation_checkpoints SET expires_at=0 WHERE run_id=$1', [
      runId
    ])
    try {
      await expect(verifier.verify(reference, runId, packet)).rejects.toThrow(
        'evaluation_checkpoint_unavailable'
      )
    } finally {
      await root.query('UPDATE learning_evaluation_checkpoints SET expires_at=$2 WHERE run_id=$1', [
        runId,
        expiry
      ])
    }
    await root.query(
      "UPDATE learning_evaluation_checkpoints SET state='incomplete' WHERE run_id=$1",
      [runId]
    )
    try {
      await expect(verifier.verify(reference, runId, packet)).rejects.toThrow(
        'evaluation_checkpoint_incomplete'
      )
    } finally {
      await root.query(
        "UPDATE learning_evaluation_checkpoints SET state='completed' WHERE run_id=$1",
        [runId]
      )
    }
    const fee = (
      await root.query(
        'SELECT claim_token::text,input_tokens FROM learning_attempts WHERE validation_run_id=$1 ORDER BY claim_token LIMIT 1',
        [runId]
      )
    ).rows[0]
    await root.query(
      'UPDATE learning_attempts SET input_tokens=input_tokens+1 WHERE claim_token=$1',
      [fee.claim_token]
    )
    try {
      await expect(verifier.verify(reference, runId, packet)).rejects.toThrow(
        'evaluation_checkpoint_fee_conflict'
      )
    } finally {
      await root.query('UPDATE learning_attempts SET input_tokens=$2 WHERE claim_token=$1', [
        fee.claim_token,
        fee.input_tokens
      ])
    }
    const workerEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      MEMORY_REPLAY_DATABASE_URL: workerUrl,
      MEMORY_REPLAY_WORKER_REFERENCE: reference
    }
    for (const name of [
      'MEMORY_REPLAY_TEXT_BASE_URL',
      'MEMORY_REPLAY_TEXT_MODEL',
      'MEMORY_REPLAY_TEXT_EXPECTED_MODEL',
      'MEMORY_REPLAY_TEXT_API_KEY',
      'MEMORY_REPLAY_JEV_API_KEY'
    ])
      delete workerEnvironment[name]
    const verified = await execute(
      process.execPath,
      [
        resolve('node_modules/tsx/dist/cli.mjs'),
        resolve('server/scripts/memory-replay.ts'),
        'verify',
        runId,
        join(directory, 'packet.private.json'),
        join(directory, 'verified')
      ],
      { timeout: 10000, windowsHide: true, env: workerEnvironment }
    )
    expect(verified.stdout).toContain('verified read-only')
    expect(verified.stdout + verified.stderr).not.toContain(workerUrl)
    const saved = JSON.parse(
      await readFile(join(directory, 'verified/frozen-verification.private.json'), 'utf8')
    )
    expect(saved).toEqual(result)
    await verifyPrivatePaths(join(directory, 'verified'), [
      join(directory, 'verified/frozen-verification.private.json')
    ])
    expect(await durable()).toEqual(initial)
    expect(await counts()).toEqual(before)
    expect(requests).toHaveLength(httpBefore)
  })

  it('rejects internally self-consistent execution tasks bound to another frozen case or publication', async () => {
    const { runId } = completedEvidence!
    const checkpoint = new EnterpriseEvaluationCheckpoint(
      authority,
      new EnterpriseLearningValidationBudget(workerDb, authority)
    )
    const saved = (await checkpoint.readCompleted(reference, runId)).executionTasks[0]
    for (const field of [
      'conversationId',
      'configVersion',
      'knowledgeVersion',
      'decisionPolicyVersion',
      'questionSetVersion'
    ] as const) {
      const task = { ...saved.task, taskId: randomUUID(), [field]: 'foreign-frozen-value' }
      const taskHash = hashContext(task)
      await root.query(
        'INSERT INTO learning_evaluation_execution_tasks(tenant_id,account_id,run_id,assignment_id,task_hash,task,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
        ['company', 'account-A', runId, saved.assignmentId, taskHash, task, Date.now()]
      )
      try {
        await expect(checkpoint.readCompleted(reference, runId)).rejects.toThrow(
          'evaluation_checkpoint_execution_conflict'
        )
      } finally {
        await root.query(
          'DELETE FROM learning_evaluation_execution_tasks WHERE run_id=$1 AND task_hash=$2',
          [runId, taskHash]
        )
      }
    }
    expect(requests).toHaveLength(9)
  })

  it('bounds durable execution incarnations and rejects cross-arm fee substitution', async () => {
    const { runId } = completedEvidence!
    const checkpoint = new EnterpriseEvaluationCheckpoint(
      authority,
      new EnterpriseLearningValidationBudget(workerDb, authority)
    )
    const snapshot = await checkpoint.readCompleted(reference, runId)
    const saved = snapshot.executionTasks[0],
      extraHashes: string[] = []
    try {
      for (let i = 0; i < 9; i++) {
        const task = { ...saved.task, taskId: randomUUID() },
          taskHash = hashContext(task)
        await root.query(
          'INSERT INTO learning_evaluation_execution_tasks(tenant_id,account_id,run_id,assignment_id,task_hash,task,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
          ['company', 'account-A', runId, saved.assignmentId, taskHash, task, Date.now()]
        )
        extraHashes.push(taskHash)
      }
      await expect(checkpoint.readCompleted(reference, runId)).rejects.toThrow(
        'evaluation_execution_capacity_exceeded'
      )
    } finally {
      await root.query(
        'DELETE FROM learning_evaluation_execution_tasks WHERE run_id=$1 AND task_hash=ANY($2::text[])',
        [runId, extraHashes]
      )
    }
    const first = snapshot.receipts[0],
      other = snapshot.receipts[1]
    await root.query(
      'UPDATE learning_evaluation_arms SET receipt=$3 WHERE run_id=$1 AND assignment_id=$2',
      [runId, first.assignmentId, { ...first, modelCallRefs: other.modelCallRefs }]
    )
    try {
      await expect(checkpoint.readCompleted(reference, runId)).rejects.toThrow(
        'evaluation_checkpoint_fee_conflict'
      )
    } finally {
      await root.query(
        'UPDATE learning_evaluation_arms SET receipt=$3 WHERE run_id=$1 AND assignment_id=$2',
        [runId, first.assignmentId, first]
      )
    }
    expect(requests).toHaveLength(9)
  })

  it('runs the enterprise CLI with authenticated worker login and zero HTTP deterministic handoff, without leaking credentials', async () => {
    const directory = resolve('.local/reports/postgres-memory-replay', randomUUID())
    await mkdir(directory, { recursive: true })
    const data = {
      ...input,
      datasetId: 'synthetic-cli-handoff',
      cases: [
        {
          caseId: 'handoff-1',
          conversationId: 'independent-2',
          category: 'handoff',
          inbound: ['询价，请转人工客服']
        }
      ]
    }
    const file = join(directory, 'input.private.json'),
      output = join(directory, 'collected')
    await writeFile(file, JSON.stringify(data))
    const before = await counts()
    const result = await execute(
      process.execPath,
      [
        resolve('node_modules/tsx/dist/cli.mjs'),
        resolve('server/scripts/memory-replay.ts'),
        file,
        output
      ],
      {
        timeout: 10000,
        windowsHide: true,
        env: {
          ...process.env,
          MEMORY_REPLAY_DATABASE_URL: workerUrl,
          MEMORY_REPLAY_WORKER_REFERENCE: reference,
          MEMORY_REPLAY_TEXT_BASE_URL: text().baseUrl,
          MEMORY_REPLAY_TEXT_MODEL: 'synthetic-text',
          MEMORY_REPLAY_TEXT_EXPECTED_MODEL: 'synthetic-text',
          MEMORY_REPLAY_TEXT_API_KEY: 'synthetic-text-key',
          MEMORY_REPLAY_JEV_API_KEY: 'synthetic-jev-key'
        }
      }
    )
    expect(result.stdout).toContain('Enterprise replay collected')
    expect(result.stdout + result.stderr).not.toContain(workerUrl)
    expect(await counts()).toEqual(before)
    const packet = JSON.parse(await readFile(join(output, 'packet.private.json'), 'utf8'))
    expect(packet.receipts).toHaveLength(3)
    expect(
      packet.receipts.every(
        (r: { inputTokens: number; outputTokens: number; modelCallRefs: string[] }) =>
          r.inputTokens === 0 && r.outputTokens === 0 && r.modelCallRefs.length === 0
      )
    ).toBe(true)
    expect(JSON.stringify(packet)).not.toContain('synthetic-text-key')
    const status = JSON.parse(await readFile(join(output, 'status.json'), 'utf8'))
    const resumedOutput = join(directory, 'resumed')
    const resumed = await execute(
      process.execPath,
      [
        resolve('node_modules/tsx/dist/cli.mjs'),
        resolve('server/scripts/memory-replay.ts'),
        'resume',
        status.runId,
        resumedOutput
      ],
      {
        timeout: 10000,
        windowsHide: true,
        env: {
          ...process.env,
          MEMORY_REPLAY_DATABASE_URL: workerUrl,
          MEMORY_REPLAY_WORKER_REFERENCE: reference,
          MEMORY_REPLAY_TEXT_BASE_URL: text().baseUrl,
          MEMORY_REPLAY_TEXT_MODEL: 'synthetic-text',
          MEMORY_REPLAY_TEXT_EXPECTED_MODEL: 'synthetic-text',
          MEMORY_REPLAY_TEXT_API_KEY: 'synthetic-text-key',
          MEMORY_REPLAY_JEV_API_KEY: 'synthetic-jev-key'
        }
      }
    )
    expect(resumed.stdout).toContain('Enterprise replay resumed')
    expect(resumed.stdout + resumed.stderr).not.toContain(workerUrl)
    expect(JSON.parse(await readFile(join(resumedOutput, 'packet.private.json'), 'utf8'))).toEqual(
      packet
    )
    expect(
      JSON.parse((await readFile(join(resumedOutput, 'ledger.jsonl'), 'utf8')).trim())
    ).toMatchObject({ runId: status.runId, state: 'evidence_exported', completedArms: 3 })
    await verifyPrivatePaths(resumedOutput, [
      join(resumedOutput, 'packet.private.json'),
      join(resumedOutput, 'blind.json'),
      join(resumedOutput, 'status.json')
    ])
    expect(
      (
        await root.query(
          'SELECT attempt_count FROM learning_evaluation_checkpoints WHERE run_id=$1',
          [status.runId]
        )
      ).rows[0]
    ).toEqual({ attempt_count: 1 })
    expect(requests).toHaveLength(9)
  })

  it('enforces worker login binding despite forged account settings and denies private bodies to device logins', async () => {
    const source = (
      await root.query('SELECT * FROM learning_evaluation_checkpoints ORDER BY created_at LIMIT 1')
    ).rows[0]
    const otherRun = randomUUID()
    await root.query(
      "INSERT INTO accounts(tenant_id,id,employee_id,platform,paused) VALUES('company','account-B','employee','wework',false)"
    )
    await root.query(
      "INSERT INTO learning_validation_runs(tenant_id,account_id,conversation_id,id,claim_token,source_id,worker_id,state,lease_until,created_at,foreground_revision,purpose) VALUES('company','account-B','',$1,$2,'synthetic-other','fixture','completed',0,0,0,'evaluation')",
      [otherRun, randomUUID()]
    )
    await root.query(
      "INSERT INTO learning_evaluation_checkpoints(tenant_id,account_id,run_id,scope,basis,frozen,basis_hash,state,created_at,expires_at) VALUES('company','account-B',$1,$2,$3,$4,$5,'completed',0,$6)",
      [
        otherRun,
        { ...source.scope, account_id: 'account-B' },
        source.basis,
        source.frozen,
        source.basis_hash,
        source.expires_at
      ]
    )
    await workerDb.transaction('company', async (client) => {
      await client.query("SELECT set_config('app.learning_account_id','account-B',true)")
      expect(
        (await client.query('SELECT basis FROM learning_evaluation_checkpoints')).rows
      ).toEqual([])
      expect((await client.query('DELETE FROM learning_evaluation_checkpoints')).rowCount).toBe(0)
      expect((await client.query('SELECT result FROM learning_evaluation_stages')).rows).toEqual([])
      expect(
        (await client.query('SELECT task FROM learning_evaluation_execution_tasks')).rows
      ).toEqual([])
    })
    await expect(
      new EnterpriseEvaluationEvidence(workerDb, authority).verify(
        reference,
        otherRun,
        completedEvidence!.packet
      )
    ).rejects.toThrow('evaluation_checkpoint_unavailable')
    await expect(
      appDb.transaction('company', async (client) => {
        await client.query("SELECT set_config('app.learning_account_id','account-A',true)")
        await client.query('SELECT basis FROM learning_evaluation_checkpoints')
      })
    ).rejects.toThrow('permission denied')
    await expect(
      appDb.transaction('company', async (client) => {
        await client.query("SELECT set_config('app.learning_account_id','account-A',true)")
        await client.query('SELECT task FROM learning_evaluation_execution_tasks')
      })
    ).rejects.toThrow('permission denied')
    await expect(
      appDb.transaction('company', async (client) => {
        await client.query("SELECT set_config('app.learning_account_id','account-A',true)")
        await client.query('SELECT result FROM learning_evaluation_stages')
      })
    ).rejects.toThrow('permission denied')
    await root.query("UPDATE agents SET token_hash=$1 WHERE tenant_id='company' AND id='agent-A'", [
      tokenHash('Z'.repeat(43))
    ])
    try {
      await workerDb.transaction('company', async (client) => {
        await client.query("SELECT set_config('app.learning_account_id','account-A',true)")
        expect(
          (await client.query('SELECT basis FROM learning_evaluation_checkpoints')).rows
        ).toEqual([])
      })
    } finally {
      await root.query(
        "UPDATE agents SET token_hash=$1 WHERE tenant_id='company' AND id='agent-A'",
        [tokenHash(credential)]
      )
    }
    expect(requests).toHaveLength(9)
  })

  it('allows only one live recovery, fences the old claim and resumes exact paid groups over real HTTP', async () => {
    const before = await counts()
    let runId = '',
      oldRun: EnterpriseValidationRun | undefined
    const localFetch: typeof fetch = (url, init) =>
      fetch(
        new URL(
          String(url).startsWith('https://api.typesafe.ai/') ? '/jev' : '/v1/chat/completions',
          baseUrl
        ),
        init
      )
    const options = {
      text: text(),
      jevApiKey: 'synthetic-jev-key',
      workerId: 'replay-recovery',
      fetch: localFetch,
      onRun: async (id: string) => {
        runId = id
        oldRun = await withLearningAccount(authority, reference, null, async (client, scope) => {
          const row = (
            await client.query(
              'SELECT claim_token,lease_until FROM learning_validation_runs WHERE id=$1',
              [id]
            )
          ).rows[0]
          return {
            id,
            claimToken: String(row.claim_token),
            leaseUntil: Number(row.lease_until),
            scope: enterpriseMemoryScope(scope, null),
            timeoutMs: 30000
          }
        })
      }
    }
    const data = { ...input, datasetId: 'synthetic-real-http-restart' }
    collector = new EnterpriseMemoryReplay(workerDb, authority, options)
    await expect(
      collector.collect(reference, data, undefined, async () => {
        throw new Error('synthetic_export_failure')
      })
    ).rejects.toThrow('synthetic_export_failure')
    await collector.drain()
    const saved = (
      await root.query(
        'SELECT receipt FROM learning_evaluation_arms WHERE run_id=$1 AND state=$2',
        [runId, 'completed']
      )
    ).rows[0].receipt
    const assignments = (
      await root.query(
        'SELECT assignment_id::text FROM learning_evaluation_arms WHERE run_id=$1 ORDER BY ordinal',
        [runId]
      )
    ).rows
    expect(requests).toHaveLength(12)
    const staleRun = oldRun!
    await new Promise<void>((resolve) => setTimeout(resolve, 5100)) // Actual failed-attempt backoff, no virtual clock.
    let entered!: () => void,
      release!: () => void,
      delayed = false
    const arrived = new Promise<void>((resolve) => {
      entered = resolve
    })
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    const heldFetch: typeof fetch = async (url, init) => {
      if (!delayed) {
        delayed = true
        entered()
        await released
      }
      return localFetch(url, init)
    }
    const recovered = new EnterpriseMemoryReplay(workerDb, authority, {
      ...options,
      workerId: 'replay-recovered',
      fetch: heldFetch
    })
    const competing = new EnterpriseMemoryReplay(workerDb, authority, {
      ...options,
      workerId: 'replay-competing'
    })
    const pending = recovered.resume(reference, runId)
    try {
      await Promise.race([
        arrived,
        pending.then(() => {
          throw new Error('synthetic_expected_live_request')
        })
      ])
      await expect(competing.resume(reference, runId)).rejects.toThrow('learning_background_busy')
      const budget = new EnterpriseLearningValidationBudget(workerDb, authority)
      await new EnterpriseEvaluationCheckpoint(authority, budget).incomplete(reference, staleRun)
      expect(
        (
          await root.query(
            'SELECT state,attempt_count FROM learning_evaluation_checkpoints WHERE run_id=$1',
            [runId]
          )
        ).rows[0]
      ).toEqual({ state: 'collecting', attempt_count: 2 })
    } finally {
      release()
    }
    const packet = await pending
    expect(packet.receipts[0]).toEqual(saved)
    expect(packet.receipts.map((r) => ({ assignment_id: r.assignmentId }))).toEqual(assignments)
    expect(requests).toHaveLength(18)
    expect(new Set(packet.receipts.flatMap((r) => r.modelCallRefs!)).size).toBe(9)
    expect(
      (
        await root.query(
          'SELECT count(*)::int AS n FROM learning_attempts WHERE validation_run_id=$1',
          [runId]
        )
      ).rows[0]
    ).toEqual({ n: 9 })
    expect(
      (await root.query('SELECT count(*)::int AS n FROM learning_background_leases')).rows[0]
    ).toEqual({ n: 0 })
    expect(await counts()).toEqual(before)
    await recovered.drain()
    await competing.drain()
  }, 20000)

  it('continues an unfinished paid batch in a distinct OS process using the original durable assignments', async () => {
    const before = await counts()
    const directory = resolve('.local/reports/postgres-memory-replay', randomUUID())
    await mkdir(directory, { recursive: true })
    const file = join(directory, 'input.private.json')
    await writeFile(file, JSON.stringify({ ...input, datasetId: 'synthetic-os-process-restart' }))
    const environment = {
      ...process.env,
      AUTOREPLY_REPLAY_FIXTURE_DATABASE_URL: workerUrl,
      AUTOREPLY_REPLAY_FIXTURE_REFERENCE: reference,
      AUTOREPLY_REPLAY_FIXTURE_LOOPBACK: baseUrl
    }
    const start = async (mode: string, source: string, output: string) =>
      execute(
        process.execPath,
        [
          resolve('node_modules/tsx/dist/cli.mjs'),
          resolve('tests/fixtures/enterprise-replay-resume-process.ts'),
          mode,
          source,
          output
        ],
        { timeout: 10000, windowsHide: true, env: environment }
      )
    const first = await start('collect', file, join(directory, 'first'))
    expect(first.stdout + first.stderr).not.toContain(workerUrl)
    const status = JSON.parse(await readFile(join(directory, 'first/status.json'), 'utf8'))
    const saved = JSON.parse(await readFile(join(directory, 'first/receipt.private.json'), 'utf8'))
    expect(status).toMatchObject({ state: 'incomplete', businessVerified: false })
    expect(requests).toHaveLength(21)
    const assignments = (
      await root.query(
        'SELECT assignment_id::text FROM learning_evaluation_arms WHERE run_id=$1 ORDER BY ordinal',
        [status.runId]
      )
    ).rows
    await new Promise<void>((resolve) => setTimeout(resolve, 5100))
    const second = await start('resume', status.runId, join(directory, 'second'))
    expect(second.stdout + second.stderr).not.toContain(workerUrl)
    const recovered = JSON.parse(await readFile(join(directory, 'second/status.json'), 'utf8'))
    const packet = JSON.parse(await readFile(join(directory, 'second/packet.private.json'), 'utf8'))
    expect(recovered).toMatchObject({
      state: 'completed',
      runId: status.runId,
      businessVerified: false
    })
    expect(recovered.processId).not.toBe(status.processId)
    expect(packet.receipts[0]).toEqual(saved)
    expect(
      packet.receipts.map((r: { assignmentId: string }) => ({ assignment_id: r.assignmentId }))
    ).toEqual(assignments)
    expect(requests).toHaveLength(27)
    expect(
      (
        await root.query(
          'SELECT count(*)::int AS n FROM learning_attempts WHERE validation_run_id=$1',
          [status.runId]
        )
      ).rows[0]
    ).toEqual({ n: 9 })
    expect(
      (
        await root.query(
          'SELECT attempt_count FROM learning_evaluation_checkpoints WHERE run_id=$1',
          [status.runId]
        )
      ).rows[0]
    ).toEqual({ attempt_count: 2 })
    expect(
      (await root.query('SELECT count(*)::int AS n FROM learning_background_leases')).rows[0]
    ).toEqual({ n: 0 })
    expect(await counts()).toEqual(before)
  }, 30000)

  it('exports budget waiting from the CLI and resumes a saved paid phase in the next controlled UTC bucket', async () => {
    const before = await counts()
    let runId = '',
      time = Date.now(),
      first = true
    const currentDay = new Date(time).toISOString().slice(0, 10)
    const localFetch: typeof fetch = async (url, init) => {
      const response = await fetch(
        new URL(
          String(url).startsWith('https://api.typesafe.ai/') ? '/jev' : '/v1/chat/completions',
          baseUrl
        ),
        init
      )
      if (first) {
        first = false
        await root.query(
          "INSERT INTO learning_retained_usage VALUES('company','account-A',$1::date,50000,0,0,1,1,0)",
          [currentDay]
        )
      }
      return response
    }
    const options = {
      text: text(),
      jevApiKey: 'synthetic-jev-key',
      workerId: 'replay-utc',
      fetch: localFetch,
      now: () => time,
      onRun: async (id: string) => {
        runId = id
      }
    }
    collector = new EnterpriseMemoryReplay(workerDb, authority, options)
    await expect(
      collector.collect(reference, { ...input, datasetId: 'synthetic-real-http-utc' })
    ).rejects.toThrow('evaluation_budget_waiting')
    await collector.drain()
    expect(requests).toHaveLength(28)
    expect(
      (await root.query('SELECT stage FROM learning_evaluation_stages WHERE run_id=$1', [runId]))
        .rows
    ).toEqual([{ stage: 'pre' }])
    expect(
      (await root.query('SELECT count(*)::int AS n FROM learning_background_leases')).rows[0]
    ).toEqual({ n: 0 })
    const directory = resolve('.local/reports/postgres-memory-replay', randomUUID())
    const output = join(directory, 'waiting')
    let failure: { code?: number; stdout?: string; stderr?: string } | undefined
    try {
      await execute(
        process.execPath,
        [
          resolve('node_modules/tsx/dist/cli.mjs'),
          resolve('server/scripts/memory-replay.ts'),
          'resume',
          runId,
          output
        ],
        {
          timeout: 10000,
          windowsHide: true,
          env: {
            ...process.env,
            MEMORY_REPLAY_DATABASE_URL: workerUrl,
            MEMORY_REPLAY_WORKER_REFERENCE: reference,
            MEMORY_REPLAY_TEXT_BASE_URL: text().baseUrl,
            MEMORY_REPLAY_TEXT_MODEL: 'synthetic-text',
            MEMORY_REPLAY_TEXT_EXPECTED_MODEL: 'synthetic-text',
            MEMORY_REPLAY_TEXT_API_KEY: 'synthetic-text-key',
            MEMORY_REPLAY_JEV_API_KEY: 'synthetic-jev-key'
          }
        }
      )
    } catch (error) {
      failure = error as typeof failure
    }
    expect(failure?.code).toBe(2)
    expect(failure?.stdout).toContain('paused at shared budget')
    expect(String(failure?.stdout) + String(failure?.stderr)).not.toContain(workerUrl)
    expect(JSON.parse(await readFile(join(output, 'status.json'), 'utf8'))).toMatchObject({
      status: 'waiting_budget',
      runId,
      businessVerified: false,
      usageReconciliationRequired: false,
      retryAfterUtc: Date.parse(currentDay) + 86400000
    })
    expect(await readdir(output)).toEqual(['status.json'])
    await verifyPrivatePaths(output, [join(output, 'status.json')])
    time = Date.parse(currentDay) + 86400000 + 1000 // Host-only fixture clock. No production API accepts it.
    const recovered = new EnterpriseMemoryReplay(workerDb, authority, options)
    const packet = await recovered.resume(reference, runId)
    expect(requests).toHaveLength(36)
    expect(new Set(packet.receipts.flatMap((r) => r.modelCallRefs!)).size).toBe(9)
    expect(
      (
        await root.query(
          'SELECT day::text,count(*)::int AS n FROM learning_attempts WHERE validation_run_id=$1 GROUP BY day ORDER BY day',
          [runId]
        )
      ).rows
    ).toEqual([
      { day: currentDay, n: 1 },
      { day: new Date(time).toISOString().slice(0, 10), n: 8 }
    ])
    expect(
      (
        await root.query(
          'SELECT attempt_count FROM learning_evaluation_checkpoints WHERE run_id=$1',
          [runId]
        )
      ).rows[0]
    ).toEqual({ attempt_count: 1 })
    expect(
      (await root.query('SELECT count(*)::int AS n FROM learning_background_leases')).rows[0]
    ).toEqual({ n: 0 })
    expect(await counts()).toEqual(before)
    await recovered.drain()
  }, 20000)
  it('links the actual visible Electron workbench for all three frozen arms to original PostgreSQL task and fee records', async () => {
    const directory = resolve('.local/reports/foreground-evaluation', randomUUID())
    await mkdir(directory, { recursive: true })
    await protectPrivateDirectory(directory)
    await writeFile(
      join(directory, 'input.private.json'),
      JSON.stringify({
        ...input,
        datasetId: 'synthetic-real-electron-three-arms'
      }),
      { flag: 'wx' }
    )
    // Remove only the synthetic quota row deliberately exhausted by the preceding UTC fixture.
    // This isolated database has no production data; production admission limits remain unchanged.
    await root.query(
      "DELETE FROM learning_retained_usage WHERE tenant_id='company' AND account_id='account-A' AND day=$1::date AND charged_tokens=50000 AND input_tokens=0 AND output_tokens=0",
      [new Date().toISOString().slice(0, 10)]
    )
    const httpBefore = requests.length,
      before = await counts()
    const output = await execute(
      process.execPath,
      [resolve('scripts/run-foreground-evaluation-smoke.mjs'), directory],
      {
        timeout: 60000,
        windowsHide: true,
        env: {
          ...process.env,
          AUTOREPLY_FOREGROUND_EVALUATION_FIXTURE: '1',
          AUTOREPLY_REPLAY_FIXTURE_DATABASE_URL: workerUrl,
          AUTOREPLY_REPLAY_FIXTURE_REFERENCE: reference,
          AUTOREPLY_REPLAY_FIXTURE_LOOPBACK: baseUrl
        }
      }
    )
    expect(output.stdout).toContain('Verified actual foreground three-arm engineering')
    expect(output.stdout + output.stderr).not.toContain(workerUrl)
    const result = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'))
    expect(result).toMatchObject({
      passed: true,
      presentations: 3,
      http: 9,
      sends: 0,
      actualForegroundPresentation: true,
      nativePlatformVerified: false,
      businessEffectVerified: false,
      original: { serverFrozenBatchVerified: true },
      linked: { foregroundVerified: true, businessVerified: false }
    })
    expect(result.linked.observations).toHaveLength(3)
    expect(
      new Set(
        result.linked.observations.map(
          (value: { runtimeInstanceId: string }) => value.runtimeInstanceId
        )
      ).size
    ).toBe(3)
    expect(requests).toHaveLength(httpBefore + 9)
    expect(await counts()).toEqual(before)
    const runner = JSON.parse(await readFile(join(directory, 'runner-result.json'), 'utf8'))
    expect(runner).toMatchObject({ exitCode: 0, timedOut: false })
    await verifyPrivatePaths(directory, [join(directory, 'packet.private.json')])
    completedForeground = {
      directory,
      runId: result.runId,
      sessionId: result.sealed.sessionId,
      observations: result.linked.observations
    }
  }, 65000)
  it('imports original foreground timing through authenticated independent CLIs without changing frozen replies or fees', async () => {
    expect(completedForeground).toBeDefined()
    const { directory, runId, sessionId, observations } = completedForeground!,
      httpBefore = requests.length,
      before = await counts()
    const packet = JSON.parse(
        await readFile(join(directory, 'packet.private.json'), 'utf8')
      ) as EnterpriseMemoryReplayPacket,
      vault = join(directory, 'host/timing-vault'),
      session = sessionId,
      packetPath = join(directory, 'packet.private.json'),
      cli = async (args: string[]): Promise<{ stdout: string; stderr: string }> =>
        execute(
          process.execPath,
          [
            resolve('node_modules/tsx/dist/cli.mjs'),
            resolve('server/scripts/memory-replay.ts'),
            ...args
          ],
          {
            timeout: 10000,
            windowsHide: true,
            env: {
              ...process.env,
              MEMORY_REPLAY_DATABASE_URL: workerUrl,
              MEMORY_REPLAY_WORKER_REFERENCE: reference,
              MEMORY_REPLAY_TEXT_API_KEY: '',
              MEMORY_REPLAY_JEV_API_KEY: ''
            }
          }
        )
    const verified = await cli([
      'verify-foreground',
      runId,
      packetPath,
      vault,
      session,
      join(directory, 'verified')
    ])
    expect(verified.stdout).toContain('Foreground evidence verified read-only')
    expect(verified.stdout + verified.stderr).not.toContain(workerUrl)
    await verifyPrivatePaths(join(directory, 'verified'), [
      join(directory, 'verified/foreground-verification.private.json')
    ])
    const labels = packet.receipts.map((receipt) => ({
      assignmentId: receipt.assignmentId,
      origin: 'synthetic',
      reviewerId: 'synthetic-reviewer',
      evidenceRef: 'synthetic-only',
      labelledAt: Date.now() + 1,
      blinded: true,
      humanReviewed: receipt.reply !== null,
      substantialCorrection: false,
      severeError: false,
      validAnswer: receipt.reply !== null,
      costUsd: 0,
      costEvidenceRef: 'synthetic-loopback-no-charge'
    }))
    const labelsPath = join(directory, 'labels.private.json')
    await writeFile(labelsPath, JSON.stringify(labels), { flag: 'wx' })
    await verifyPrivatePaths(directory, [labelsPath])
    const imported = await cli([
      'adjudicate-foreground',
      runId,
      packetPath,
      labelsPath,
      vault,
      session,
      join(directory, 'imported')
    ])
    expect(imported.stdout).toContain('Foreground adjudication imported')
    expect(imported.stdout + imported.stderr).not.toContain(workerUrl)
    const dataset = JSON.parse(await readFile(join(directory, 'imported/labelled.json'), 'utf8'))
    expect(dataset.origin).toBe(packet.input.origin)
    expect(dataset.frozen).toEqual({ ...packet.frozen, latencyScope: 'foreground_end_to_end' })
    expect(evaluateMemoryDataset(dataset).assessment.status).toBe('insufficient')
    for (const observation of observations) {
      const outcome = dataset.cases.find(
        (item: { caseId: string }) => item.caseId === observation.caseId
      )[observation.arm]
      const receipt = packet.receipts.find(
        (item) => item.assignmentId === observation.assignmentId
      )!
      expect(outcome).toMatchObject({
        latencyMs: observation.latencyMs,
        latencyComplete: true,
        latencyEvidenceRef: observation.evidenceRef,
        reply: receipt.reply,
        inputTokens: receipt.inputTokens,
        outputTokens: receipt.outputTokens,
        costUsd: 0
      })
    }
    await verifyPrivatePaths(join(directory, 'imported'), [
      join(directory, 'imported/labelled.json'),
      join(directory, 'imported/foreground-verification.private.json')
    ])
    await expect(
      cli([
        'verify-foreground',
        runId,
        packetPath,
        vault,
        session,
        join(directory, 'unsent'),
        'confirmed_sent'
      ])
    ).rejects.toMatchObject({ code: 1 })
    expect(await readFile(packetPath, 'utf8')).toBe(JSON.stringify(packet, null, 2) + '\n')
    expect(requests).toHaveLength(httpBefore)
    expect(await counts()).toEqual(before)
  }, 35000)
})
