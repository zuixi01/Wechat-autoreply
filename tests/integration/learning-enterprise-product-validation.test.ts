import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { embeddedPostgres } from '../fixtures/embedded-postgres'
import { seedSyntheticApproval } from '../fixtures/evaluation-approval'
import { AccountAuthority, tokenHash } from '../../server/src/auth/account-authority'
import { ExecutionAuthority } from '../../server/src/execution/execution-authority'
import { EnterpriseLearningWorkerAuthority } from '../../server/src/learning/learning-worker-authority'
import { EnterpriseLearningRepository } from '../../server/src/learning/learning-repository'
import { EnterpriseLearningQueue } from '../../server/src/learning/learning-queue'
import { recordLearningForegroundWithin } from '../../server/src/learning/learning-account'
import { EnterpriseLearningValidationStore } from '../../server/src/learning/learning-validation-store'
import { EnterpriseLearningProductValidation } from '../../server/src/learning/learning-product-validation'
import { EnterpriseLearningValidatorWorker } from '../../server/src/learning/learning-validator-worker'
import { textGeneratorVersion } from '../../server/src/generation/text-generator'
import {
  loadPublication,
  savePublication,
  type Publication
} from '../../server/src/generation/publication'
import { memorySemanticUnits } from '../../src/core/memory/learning-risk'
import type { LearningReviewTransport } from '../../src/core/memory/learning-reviewer'
import type {
  LearningValidationCase,
  MemoryProposal
} from '../../src/shared/contracts/learning-memory'
import { withLearningAccount } from '../../server/src/learning/learning-account'
import { loadEnterpriseMemoryCatalog } from '../../server/src/learning/learning-publication'
import type { JevRequest, JevResponse } from '../../src/shared/contracts/decision'
import * as generationMemory from '../../server/src/learning/learning-generation-context'
import { ReplyTaskSchema } from '../../src/shared/contracts/task'
import { hashContext } from '../../src/core/reply/hashes'
import {
  EnterpriseLearningValidationBudget,
  type EnterpriseValidationRun
} from '../../server/src/learning/learning-validation-budget'
import * as enterpriseReplay from '../../server/src/learning/learning-memory-replay'
import { EnterpriseEvaluationCheckpoint } from '../../server/src/learning/learning-evaluation-checkpoint'
import { evaluateMemoryDataset } from '../../evals/memory/metrics'

const deployment = vi.hoisted(() => ({ changed: false, file: '/learning-generation-context.ts' }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      const result = actual.readFileSync(...args)
      // Simulate a different deployed selector without writing to shared source files.
      return deployment.changed &&
        String(args[0]).endsWith(deployment.file) &&
        typeof result === 'string'
        ? result + '\n// synthetic deployed version change\n'
        : result
    }
  }
})

const reference = randomUUID(),
  credential = 'V'.repeat(43)
const textConfiguration = {
  apiKey: 'synthetic-text-key',
  baseUrl: 'https://provider.example/v1/',
  model: 'synthetic-text',
  expectedModel: 'synthetic-text'
}
let db: Awaited<ReturnType<typeof embeddedPostgres>>, now: number
let authority: EnterpriseLearningWorkerAuthority
let repository: EnterpriseLearningRepository<EnterpriseLearningWorkerAuthority>
let store: EnterpriseLearningValidationStore, queue: EnterpriseLearningQueue
let requests: { provider: 'text' | 'jev' | 'risk'; body: string }[]
let badAudit: boolean
let unavailable: boolean
const cases = (): LearningValidationCase[] =>
  Array.from({ length: 5 }, (_, index) => ({
    caseId: `calibration-${index}`,
    conversationId: `independent-${index}`,
    input: '我想询价',
    expectedMethod: 'HUMAN_RUBRIC_DO_NOT_SEND',
    requiredTerms: ['型号', '数量'],
    forbiddenClaims: ['FORBIDDEN_LABEL_DO_NOT_SEND'],
    humanLabelled: true,
    labelOrigin: 'human' as const // Simulated human declaration for engineering tests only.
  }))
function decision(request: JevRequest): JevResponse {
  const answers: JevResponse['answers'] = {}
  for (const [id, question] of Object.entries(request.questions))
    answers[id] =
      question.type === 'choice'
        ? {
            type: 'choice',
            choice: 'price',
            confidence: 0.99,
            probabilities: { faq: 0, price: 1, order: 0, aftersales: 0, other: 0 }
          }
        : {
            type: 'noul',
            noul:
              id === 'human_requested' ||
              (id.startsWith('has_') && id !== 'has_price') ||
              (badAudit && id === 'supported')
                ? 0
                : 1
          }
  return { model: 'synthetic-jev', answers, usage: { input_tokens: 10, output_tokens: 5 } }
}
const upstream: typeof fetch = async (url, options) => {
  const body = String(options?.body)
  if (String(url).startsWith('https://api.typesafe.ai/')) {
    requests.push({ provider: 'jev', body })
    if (unavailable) throw new Error('synthetic_network_failure')
    return Response.json(decision(JSON.parse(body)))
  }
  requests.push({ provider: 'text', body })
  return Response.json({
    model: 'synthetic-text',
    choices: [
      {
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: JSON.stringify({ text: '请提供型号和数量。', evidenceIds: ['faq-price'] })
        }
      }
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 }
  })
}
const riskTransport: LearningReviewTransport = {
  complete: async (request) => {
    requests.push({ provider: 'risk', body: request.user })
    const raw = JSON.parse(request.user) as {
      contentHash: string
      units: ReturnType<typeof memorySemanticUnits>
    }
    return {
      text: JSON.stringify({
        contentHash: raw.contentHash,
        units: raw.units.map((unit) => ({
          path: unit.path,
          category: 'method',
          reason: '处理方法'
        }))
      }),
      usage: { inputTokens: 10, outputTokens: 5 }
    }
  }
}
function service(transport = riskTransport, text = textConfiguration) {
  return new EnterpriseLearningProductValidation(db.db, authority, {
    text,
    jevApiKey: 'synthetic-jev-key',
    riskTransport: transport,
    validatorVersion: 'enterprise-validator-1',
    workerId: 'synthetic-worker',
    fetch: upstream,
    now: () => Math.max(now, Date.now())
  })
}
beforeAll(async () => {
  db = await embeddedPostgres('autoreply_learning_worker')
  authority = new EnterpriseLearningWorkerAuthority(db.db)
  repository = new EnterpriseLearningRepository(authority, { now: () => now })
  store = new EnterpriseLearningValidationStore(authority, {
    now: () => now,
    validatorVersion: 'enterprise-validator-1'
  })
  queue = new EnterpriseLearningQueue(db.db, authority, { now: () => now })
}, 20000)
afterAll(async () => {
  if (db) await db.db.close()
})
beforeEach(async () => {
  deployment.changed = false
  now = Date.now()
  requests = []
  badAudit = false
  unavailable = false
  await db.adminExec(
    "TRUNCATE tenants CASCADE; INSERT INTO tenants(id,name) VALUES('company','合成企业'); INSERT INTO employees(tenant_id,id,role) VALUES('company','employee','employee'); INSERT INTO accounts(tenant_id,id,employee_id,platform,paused) VALUES('company','account-A','employee','wework',false)"
  )
  await db.adminQuery(
    "INSERT INTO agents(tenant_id,id,account_id,employee_id,token_hash) VALUES('company','agent-A','account-A','employee',$1)",
    [tokenHash(credential)]
  )
  const login = ((await db.adminQuery('SELECT session_user AS login')).rows[0] as { login: string })
    .login
  await db.adminQuery(
    'INSERT INTO learning_worker_bindings(id,login_name,tenant_id,account_id,employee_id,agent_id,agent_token_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [reference, login, 'company', 'account-A', 'employee', 'agent-A', tokenHash(credential)]
  )
  const publication: Publication = {
    configuration: {
      configVersion: 'config-1',
      knowledgeVersion: 'knowledge-1',
      decisionPolicyVersion: 'policy-1',
      questionSetVersion: 'questions-1',
      modelResolved: 'synthetic-jev',
      automaticEnabled: true
    },
    textGeneratorVersion: textGeneratorVersion(textConfiguration),
    policy: {
      version: 'policy-1',
      knowledgeVersion: 'knowledge-1',
      questionSetVersion: 'questions-1',
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
        evidenceId: 'faq-price',
        tenantId: 'company',
        accountId: 'account-A',
        intent: 'price',
        knowledgeVersion: 'knowledge-1',
        kind: 'approved_faq',
        content: '请提供型号和数量。',
        source: 'synthetic-approved-FAQ',
        approvedBy: 'employee',
        validFrom: now - 1000,
        expiresAt: now + 86400000
      }
    ],
    replyRules: '使用简洁中文。'
  }
  const approved = await seedSyntheticApproval(db, publication)
  const device = new AccountAuthority(db.db)
  await savePublication(
    device,
    new ExecutionAuthority(device, async (client, scope) => {
      await loadPublication(client, scope)
    }),
    credential,
    approved
  )
})
async function candidate(calibration = cases(), guidance = '先询问型号和数量，再查询有效资料') {
  const episode = await repository.recordEpisode(reference, 'training', {
    sourceId: randomUUID(),
    topic: '询价',
    startedAt: now,
    messages: [],
    correction: '先确认型号和数量',
    outcome: 'corrected',
    identityStatus: 'verified'
  })
  const memory = await repository.propose(reference, 'training', {
    content: {
      kind: 'skill',
      scenario: '询价',
      guidance,
      rationale: '',
      steps: ['确认需求'],
      pitfalls: ['不要猜价格'],
      verification: ['需求完整']
    },
    evidence: [{ episodeId: episode.id }],
    source: 'review',
    reason: '员工纠正'
  })
  if (calibration.length)
    await store.importCalibration(reference, 'training', {
      cases: calibration,
      humanConfirmed: true
    })
  return memory
}
async function mergedCandidate() {
  const originals = [
    await candidate(cases(), 'OLD_FIRST 先核对型号'),
    await candidate(cases(), 'OLD_SECOND 再核对数量')
  ]
  for (const original of originals) await repository.activate(reference, 'training', original.id, 1)
  const catalog = await withLearningAccount(
    authority,
    reference,
    'training',
    loadEnterpriseMemoryCatalog,
    () => now
  )
  const published = (
    await db.adminQuery(
      "SELECT config_json,policy_json,evidence_json,text_generator_version FROM generation_publications WHERE config_version='config-1'"
    )
  ).rows[0] as {
    config_json: Publication['configuration']
    policy_json: Publication['policy']
    evidence_json: Publication['evidence']
    text_generator_version: string
  }
  const publication: Publication = {
    configuration: {
      ...published.config_json,
      configVersion: 'config-merge-baseline',
      memoryCorpusVersion: catalog.memoryCorpusVersion
    },
    policy: Object.fromEntries(
      Object.entries(published.policy_json).filter(
        ([key]) => !['retrieval', 'replyRules'].includes(key)
      )
    ) as Publication['policy'],
    evidence: published.evidence_json,
    textGeneratorVersion: published.text_generator_version,
    replyRules: '使用简洁中文。',
    ...catalog
  }
  const approved = await seedSyntheticApproval(db, publication)
  const device = new AccountAuthority(db.db)
  await savePublication(
    device,
    new ExecutionAuthority(device, async (client, scope) => {
      await loadPublication(client, scope)
    }),
    credential,
    approved
  )
  const histories = await Promise.all(
    originals.map((original) => repository.history(reference, 'training', original.id))
  )
  const proposal: MemoryProposal = {
    content: { ...originals[0].content, guidance: 'MERGED_ONLY 合并核对型号与数量' },
    source: 'curator',
    reason: '合成合并',
    evidence: histories.flatMap((history) => history[0].evidence)
  }
  const merged = await withLearningAccount(
    authority,
    reference,
    'training',
    (client, scope, conversation, at) =>
      repository.proposeCurationWithin(
        client,
        scope,
        conversation,
        proposal,
        originals.map((original) => ({ memoryId: original.id, revision: 1 })),
        at
      ),
    () => now
  )
  return { merged, originals }
}
async function enterpriseHoldout() {
  const episode = await repository.recordEpisode(reference, null, {
    sourceId: 'synthetic-account-training',
    topic: '询价',
    startedAt: now,
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
    reason: '合成工程手工教导，不是业务证据'
  })
  await repository.activate(reference, null, memory.id, 1)
  // Real publication binding; the existing helper explicitly seeds synthetic business admission
  // in this isolated test database. It must never be counted as a real business approval.
  const publication = await withLearningAccount(
    authority,
    reference,
    null,
    async (client, scope) => {
      const current = (
        await client.query(
          "SELECT config_json,policy_json,evidence_json,text_generator_version FROM generation_publications WHERE tenant_id=$1 AND account_id=$2 AND config_version='config-1'",
          [scope.tenant_id, scope.account_id]
        )
      ).rows[0]
      const catalog = await loadEnterpriseMemoryCatalog(client, scope)
      return {
        configuration: {
          ...current.config_json,
          configVersion: 'config-replay',
          memoryCorpusVersion: catalog.memoryCorpusVersion
        },
        policy: Object.fromEntries(
          Object.entries(current.policy_json).filter(
            ([key]) => !['retrieval', 'replyRules'].includes(key)
          )
        ),
        evidence: current.evidence_json,
        textGeneratorVersion: current.text_generator_version,
        ...(current.policy_json.replyRules ? { replyRules: current.policy_json.replyRules } : {}),
        ...(current.policy_json.retrieval ? { retrieval: current.policy_json.retrieval } : {}),
        memoryCorpusVersion: catalog.memoryCorpusVersion,
        memoryManifest: catalog.memoryManifest
      } as Publication
    }
  )
  const device = new AccountAuthority(db.db)
  await savePublication(
    device,
    new ExecutionAuthority(device, async (client, scope) => {
      await loadPublication(client, scope)
    }),
    credential,
    await seedSyntheticApproval(db, publication)
  )
  const input = enterpriseReplay.EnterpriseMemoryReplayInputSchema.parse({
    version: 1,
    datasetId: 'synthetic-enterprise-replay',
    origin: 'synthetic',
    rubricRef: 'HUMAN_RUBRIC_DO_NOT_SEND',
    maxRequests: 9,
    backgroundCostUsd: 0,
    legacy: [{ scenario: '询价', guidance: '静态先问型号', rationale: '' }],
    sources: [
      {
        caseId: episode.id,
        conversationId: 'account',
        split: 'learn',
        label: { origin: 'synthetic', blinded: false, labelledAt: now }
      }
    ],
    cases: [
      {
        caseId: 'holdout-1',
        conversationId: 'independent-customer',
        category: 'inquiry',
        inbound: ['我想询价']
      }
    ]
  })
  return { episode, memory, input }
}
// Five paired cases run 31 real HTTP contracts; recovery exercises 38 calls plus database transactions.
// This suite timeout does not alter provider-stage deadlines or cancellation/lease assertions.
describe('actual enterprise paired validation pipeline', { timeout: 15000 }, () => {
  it('keeps a verified merge grant unused and both old methods active if archiving fails during activation', async () => {
    const { merged, originals } = await mergedCandidate()
    expect(await service().validate(reference, 'training', merged.id, 1)).toMatchObject({
      status: 'passed',
      activated: false
    })
    await repository.settings(reference, 'training', { mode: 'auto' })
    await db.adminExec(
      `CREATE OR REPLACE FUNCTION fail_granted_merge() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='curator_replaced' THEN RAISE EXCEPTION 'synthetic_granted_merge_failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_granted_merge BEFORE INSERT ON learning_mutations FOR EACH ROW EXECUTE FUNCTION fail_granted_merge()`
    )
    try {
      expect(await service().validate(reference, 'training', merged.id, 1)).toMatchObject({
        status: 'failed',
        activated: false
      })
      expect((await store.grants(reference, 'training', merged.id))[0].usedAt).toBe(null)
      expect((await repository.get(reference, 'training', merged.id)).activeRevision).toBe(null)
      for (const original of originals)
        expect((await repository.get(reference, 'training', original.id)).state).toBe('active')
      expect(
        (await db.adminQuery('SELECT applied_at FROM learning_memory_replacements')).rows
      ).toEqual([{ applied_at: null }, { applied_at: null }])
      expect(await queue.usage(reference)).toMatchObject({ requests: 31 })
    } finally {
      await db.adminExec(
        'DROP TRIGGER fail_granted_merge ON learning_mutations; DROP FUNCTION fail_granted_merge()'
      )
    }
  })
  it('replays a merge against all old methods without leaking them into the candidate and atomically consumes its grant and replacement references', async () => {
    const { merged, originals } = await mergedCandidate()
    await repository.settings(reference, 'training', { mode: 'auto' })
    const result = await service().validate(reference, 'training', merged.id, 1)
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'passed', activated: true })
    const prompts = requests
      .filter((request) => request.provider === 'text')
      .map((request) => request.body)
    expect(prompts).toHaveLength(10)
    for (let index = 0; index < prompts.length; index++) {
      expect(prompts[index].includes('OLD_FIRST')).toBe(index % 2 === 0)
      expect(prompts[index].includes('OLD_SECOND')).toBe(index % 2 === 0)
      expect(prompts[index].includes('MERGED_ONLY')).toBe(index % 2 === 1)
    }
    for (const original of originals)
      expect((await repository.get(reference, 'training', original.id)).state).toBe('archived')
    expect((await store.grants(reference, 'training', merged.id))[0].usedAt).not.toBe(null)
    expect(
      (
        await db.adminQuery(
          'SELECT count(*)::int AS n FROM learning_memory_replacements WHERE applied_at IS NOT NULL'
        )
      ).rows[0]
    ).toEqual({ n: 2 })
    expect(
      (await db.adminQuery('SELECT count(*)::int AS n FROM generation_tasks')).rows[0]
    ).toEqual({ n: 0 })
  })
  it('lets another candidate proceed while an earlier model failure is waiting for its retry window', async () => {
    const first = await candidate(cases(), '暂不可用的方法：先询问型号和数量')
    const hash = (await repository.history(reference, 'training', first.id))[0].contentHash
    now++
    const second = await candidate()
    await repository.settings(reference, 'training', { mode: 'auto' })
    const transport: LearningReviewTransport = {
      complete: (request, signal) => {
        if (JSON.parse(request.user).contentHash === hash)
          return Promise.reject(new Error('review_unavailable'))
        return riskTransport.complete(request, signal)
      }
    }
    const worker = new EnterpriseLearningValidatorWorker(service(transport), {
      references: async () => [reference]
    })
    try {
      expect(await worker.runOnce(reference)).toBe('failed')
      expect(await worker.runOnce(reference)).toBe('completed')
      expect(await repository.get(reference, 'training', first.id)).toMatchObject({
        activeRevision: null
      })
      expect(await repository.get(reference, 'training', second.id)).toMatchObject({
        activeRevision: 1
      })
    } finally {
      await worker.stop()
    }
  })
  it('retries an actual decision-provider outage after backoff without mistaking it for a rejected method', async () => {
    const memory = await candidate()
    await repository.settings(reference, 'training', { mode: 'auto' })
    const worker = new EnterpriseLearningValidatorWorker(service(), {
      references: async () => [reference]
    })
    try {
      unavailable = true
      expect(await worker.runOnce(reference)).toBe('failed')
      unavailable = false
      now = Date.now() + 5000
      expect(await worker.runOnce(reference)).toBe('completed')
      expect(await repository.get(reference, 'training', memory.id)).toMatchObject({
        activeRevision: 1
      })
      expect(await store.grants(reference, 'training', memory.id)).toHaveLength(1)
    } finally {
      await worker.stop()
    }
  })
  it('consumes a still-current suggest-mode grant after switching to auto without repeating model calls', async () => {
    const memory = await candidate()
    expect(await service().validate(reference, 'training', memory.id, 1)).toMatchObject({
      status: 'passed',
      activated: false
    })
    await repository.settings(reference, 'training', { mode: 'auto' })
    const worker = new EnterpriseLearningValidatorWorker(service(), {
      references: async () => [reference]
    })
    try {
      expect(await worker.runOnce(reference)).toBe('completed')
      expect(await repository.get(reference, 'training', memory.id)).toMatchObject({
        activeRevision: 1
      })
      expect(await queue.usage(reference)).toMatchObject({ requests: 31, reservedTokens: 465 })
    } finally {
      await worker.stop()
    }
  })
  it('discovers durable auto candidates after restart and stops without revalidating the active revision', async () => {
    const memory = await candidate()
    const options = { references: async () => [reference], pollIntervalMs: 5 }
    const first = new EnterpriseLearningValidatorWorker(service(), options)
    expect(await first.runOnce(reference)).toBe('idle')
    expect(requests).toHaveLength(0)
    await first.stop()
    await repository.settings(reference, 'training', { mode: 'auto' })
    const restarted = new EnterpriseLearningValidatorWorker(service(), options)
    try {
      restarted.start()
      await expect
        .poll(async () => (await repository.get(reference, 'training', memory.id)).activeRevision, {
          timeout: 10000
        })
        .toBe(1)
    } finally {
      await restarted.stop()
    }
    expect(await restarted.runOnce(reference)).toBe('idle')
    expect(await queue.usage(reference)).toMatchObject({ requests: 31, reservedTokens: 465 })
    expect(await new EnterpriseLearningValidatorWorker(service(), options).runOnce(reference)).toBe(
      'idle'
    )
  })
  it('does not repeatedly charge a rejected candidate until its bound evidence or calibration changes', async () => {
    const memory = await candidate()
    await repository.settings(reference, 'training', { mode: 'auto' })
    const worker = new EnterpriseLearningValidatorWorker(service(), {
      references: async () => [reference]
    })
    badAudit = true
    expect(await worker.runOnce(reference)).toBe('failed')
    expect(await worker.runOnce(reference)).toBe('idle')
    expect(await queue.usage(reference)).toMatchObject({ requests: 7, reservedTokens: 105 })
    badAudit = false
    await store.importCalibration(reference, 'training', {
      cases: cases().map((entry) => ({ ...entry, input: '请询价并确认我的需求' })),
      humanConfirmed: true
    })
    expect(await worker.runOnce(reference)).toBe('completed')
    expect(await repository.get(reference, 'training', memory.id)).toMatchObject({
      activeRevision: 1
    })
    expect(await queue.usage(reference)).toMatchObject({ requests: 38, reservedTokens: 570 })
    await worker.stop()
  })
  it('worker shutdown aborts the active calibration and prevents a late grant or activation', async () => {
    const memory = await candidate()
    await repository.settings(reference, 'training', { mode: 'auto' })
    let entered!: () => void,
      release!: (value: Awaited<ReturnType<LearningReviewTransport['complete']>>) => void
    let observed: AbortSignal | undefined
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const transport: LearningReviewTransport = {
      complete: (_request, signal) => {
        observed = signal
        entered()
        return new Promise((resolve) => {
          release = resolve
        })
      }
    }
    const worker = new EnterpriseLearningValidatorWorker(service(transport), {
      references: async () => [reference]
    })
    worker.start()
    await started
    let shutdown: Promise<void> | undefined
    try {
      await worker.stop()
      let drained = false
      shutdown = worker.shutdown().then(() => {
        drained = true
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(drained).toBe(false)
      expect(observed?.aborted).toBe(true)
      expect(await store.grants(reference, 'training', memory.id)).toEqual([])
      expect(await repository.get(reference, 'training', memory.id)).toMatchObject({
        activeRevision: null
      })
    } finally {
      release({ text: '{}', usage: { inputTokens: 5, outputTokens: 4 } })
      await shutdown
    }
    await expect.poll(async () => (await queue.usage(reference)).reservedTokens).toBe(9)
  })
  it('replays both arms through real clients, bills every call and never leaks human rubrics or creates send authority', async () => {
    const memory = await candidate()
    const result = await service().validate(reference, 'training', memory.id, 1)
    expect(result, JSON.stringify(result)).toMatchObject({
      status: 'passed',
      activated: false,
      caseCount: 5,
      candidateCovered: 5
    })
    expect((await store.grants(reference, 'training', memory.id))[0]).toMatchObject({
      usedAt: null
    })
    expect(await repository.get(reference, 'training', memory.id)).toMatchObject({
      state: 'pending',
      activeRevision: null
    })
    expect(await queue.usage(reference)).toMatchObject({
      reservedTokens: 465,
      requests: 31,
      reportedRequests: 31
    })
    const textBodies = requests
      .filter((request) => request.provider === 'text')
      .map((request) => JSON.parse(request.body))
    expect(textBodies).toHaveLength(10)
    for (let index = 0; index < textBodies.length; index++) {
      const prompt = textBodies[index].messages
        .map((message: { content: string }) => message.content)
        .join('\n')
      expect(prompt).toContain('synthetic-approved-FAQ')
      expect(prompt).toContain('使用简洁中文')
      expect(prompt.includes(memory.id)).toBe(index % 2 === 1)
    }
    expect(JSON.stringify(requests)).not.toContain('HUMAN_RUBRIC_DO_NOT_SEND')
    expect(JSON.stringify(requests)).not.toContain('FORBIDDEN_LABEL_DO_NOT_SEND')
    for (const table of ['generation_tasks', 'reviewed_replies', 'execution_permits'])
      expect(
        (await db.adminQuery(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]
      ).toMatchObject({ n: 0 })
    expect((await db.adminQuery('SELECT state FROM learning_validation_runs')).rows).toEqual([
      { state: 'completed' }
    ])
    expect(
      (await db.adminQuery('SELECT count(*)::int AS n FROM learning_validation_reports')).rows[0]
    ).toMatchObject({ n: 1 })
  })
  it('consumes an auto grant once but requires a new formal publication for subsequent production generation', async () => {
    const memory = await candidate()
    await repository.settings(reference, 'training', { mode: 'auto' })
    expect(await service().validate(reference, 'training', memory.id, 1)).toMatchObject({
      status: 'passed',
      activated: true
    })
    expect(await repository.get(reference, 'training', memory.id)).toMatchObject({
      state: 'active',
      activeRevision: 1
    })
    expect((await store.grants(reference, 'training', memory.id))[0].usedAt).toBeGreaterThanOrEqual(
      now
    )
    await expect(
      authority.withLockedAccount(
        reference,
        (client, scope) => loadPublication(client, scope),
        true
      )
    ).rejects.toThrow('CONFIGURATION_CHANGED')
  })
  it('does not reserve or dispatch without independent human cases, or when a case overlaps training', async () => {
    const memory = await candidate([])
    expect(await service().validate(reference, 'training', memory.id, 1)).toMatchObject({
      status: 'insufficient',
      activated: false
    })
    await store.importCalibration(reference, 'training', {
      cases: cases().map((entry, index) => ({
        ...entry,
        conversationId: index ? entry.conversationId : 'training'
      })),
      humanConfirmed: true
    })
    expect(await service().validate(reference, 'training', memory.id, 1)).toMatchObject({
      status: 'insufficient',
      reasons: ['calibration_training_overlap']
    })
    expect(requests).toHaveLength(0)
    expect(await queue.usage(reference)).toMatchObject({ reservedTokens: 0, requests: 0 })
    expect(
      (await db.adminQuery('SELECT count(*)::int AS n FROM learning_validation_runs')).rows[0]
    ).toMatchObject({ n: 0 })
  })
  it('captures a read-only replay basis and selects exactly the same context as the production preparation', async () => {
    expect(generationMemory.captureEnterpriseLearningReplayState).toBeTypeOf('function')
    const memory = await candidate([])
    await repository.activate(reference, 'training', memory.id, 1)
    await withLearningAccount(authority, reference, 'training', async (client, scope) => {
      const task = ReplyTaskSchema.parse({
        taskId: randomUUID(),
        identity: {
          tenantId: scope.tenant_id,
          employeeId: scope.employee_id,
          accountId: scope.account_id,
          agentId: scope.agent_id,
          platform: scope.platform,
          loginEpoch: 0,
          clientInstanceId: randomUUID()
        },
        conversationId: 'training',
        bindingVersion: 1,
        conversationRevision: 1,
        runEpoch: 1,
        inboundRange: { from: 1, to: 1 },
        contextHash: hashContext('询价'),
        configVersion: 'config-1',
        knowledgeVersion: 'knowledge-1',
        decisionPolicyVersion: 'policy-1',
        questionSetVersion: 'questions-1',
        createdAt: Date.now(),
        expiresAt: Date.now() + 60000
      })
      const counts = async () =>
        (
          await client.query(
            'SELECT (SELECT count(*) FROM learning_preparations)::int AS preparations,(SELECT count(*) FROM generation_tasks)::int AS tasks,(SELECT count(*) FROM learning_episodes)::int AS episodes,(SELECT count(*) FROM execution_permits)::int AS permits'
          )
        ).rows[0]
      const before = await counts()
      const state = await generationMemory.captureEnterpriseLearningReplayState(client, scope, task)
      const selected = generationMemory.selectEnterpriseLearningContext(state, '询价')
      expect(selected.methodRefs).toEqual([
        { id: memory.id, revision: 1, contentHash: state.methods[0].contentHash }
      ])
      expect(selected.text).toContain('先询问型号和数量')
      expect(await counts()).toEqual(before)
      const prepared = await generationMemory.prepareEnterpriseLearningTask(
        client,
        scope,
        task,
        '询价'
      )
      const actual = await generationMemory.assertEnterpriseLearningTaskCurrent(
        client,
        scope,
        prepared
      )
      expect(actual).toEqual(selected)
      expect(await counts()).toMatchObject({ ...before, preparations: before.preparations + 1 })
    })
    expect(requests).toHaveLength(0)
  })

  it('binds three-arm evaluation to the shared ledger and holds one background slot without creating a grant', async () => {
    const budget = new EnterpriseLearningValidationBudget(db.db, authority)
    const run = await budget.begin(
      reference,
      null,
      'synthetic-holdout-run',
      'evaluator',
      1800,
      'evaluation'
    )
    const call = await budget.reserve(reference, run, 100, 100)
    expect(await call.settleUsage({ inputTokens: 12, outputTokens: 4 })).toBe(true)
    const row = (
      await db.adminQuery(
        'SELECT purpose,input_tokens,output_tokens,measurement FROM learning_attempts WHERE claim_token=$1',
        [call.id]
      )
    ).rows[0]
    expect(row).toMatchObject({
      purpose: 'evaluation',
      input_tokens: 12,
      output_tokens: 4,
      measurement: 'reported'
    })
    await expect(budget.begin(reference, null, 'blocked-parallel', 'other', 1)).rejects.toThrow(
      'learning_background_busy'
    )
    expect(
      (await db.adminQuery('SELECT count(*)::int AS n FROM learning_activation_grants')).rows[0]
    ).toMatchObject({ n: 0 })
    await budget.end(reference, run, 'completed')
    expect(
      (await db.adminQuery('SELECT count(*)::int AS n FROM learning_background_leases')).rows[0]
    ).toMatchObject({ n: 0 })
    await expect(
      budget.begin(reference, null, 'too-large-calibration', 'validator', 1800)
    ).rejects.toThrow()
  })

  it('durably freezes the input and all assignments before its first provider request', async () => {
    const { input } = await enterpriseHoldout()
    let runId = ''
    const collector = new enterpriseReplay.EnterpriseMemoryReplay(db.db, authority, {
      text: textConfiguration,
      jevApiKey: 'synthetic-jev-key',
      workerId: 'evaluation-worker',
      onRun: async (id) => {
        runId = id
        expect(requests).toHaveLength(0)
        const row = (
          await db.adminQuery(
            'SELECT basis,frozen,state FROM learning_evaluation_checkpoints WHERE run_id=$1',
            [id]
          )
        ).rows[0] as { basis: { input: unknown }; frozen: unknown; state: string }
        expect(row.basis.input).toEqual(input)
        expect(row.state).toBe('collecting')
        expect(JSON.stringify(row)).not.toContain(textConfiguration.apiKey)
        expect(
          (
            await db.adminQuery(
              'SELECT count(*)::int AS n FROM learning_evaluation_arms WHERE run_id=$1 AND state=$2',
              [id, 'pending']
            )
          ).rows[0]
        ).toEqual({ n: 3 })
      },
      fetch: upstream
    })
    const packet = await collector.collect(reference, input)
    const stored = (
      await db.adminQuery(
        'SELECT receipt FROM learning_evaluation_arms WHERE run_id=$1 ORDER BY ordinal',
        [runId]
      )
    ).rows.map((r) => (r as { receipt: unknown }).receipt)
    expect(stored).toEqual(packet.receipts)
    expect(
      (
        await db.adminQuery('SELECT state FROM learning_evaluation_checkpoints WHERE run_id=$1', [
          runId
        ])
      ).rows[0]
    ).toEqual({ state: 'completed' })
    await collector.drain()
  })

  it('does not resurrect held-out bodies forgotten between basis capture and run admission', async () => {
    const { input } = await enterpriseHoldout()
    const original = EnterpriseLearningValidationBudget.prototype.begin
    const begin = vi
      .spyOn(EnterpriseLearningValidationBudget.prototype, 'begin')
      .mockImplementationOnce(async function (
        this: EnterpriseLearningValidationBudget,
        ...args: Parameters<typeof original>
      ) {
        await repository.forgetScope(reference, input.cases[0].conversationId)
        return original.apply(this, args)
      })
    const collector = new enterpriseReplay.EnterpriseMemoryReplay(db.db, authority, {
      text: textConfiguration,
      jevApiKey: 'synthetic-jev-key',
      workerId: 'evaluation-worker',
      fetch: upstream
    })
    try {
      await expect(collector.collect(reference, input)).rejects.toThrow(
        'evaluation_environment_changed'
      )
      expect(requests).toHaveLength(0)
      expect(
        (await db.adminQuery('SELECT count(*)::int AS n FROM learning_evaluation_checkpoints'))
          .rows[0]
      ).toEqual({ n: 0 })
      expect(
        (await db.adminQuery('SELECT count(*)::int AS n FROM learning_evaluation_arms')).rows[0]
      ).toEqual({ n: 0 })
      expect(await queue.usage(reference)).toMatchObject({ requests: 0 })
    } finally {
      begin.mockRestore()
      await collector.drain()
    }
  })

  it('isolates export callback mutations from both the durable and returned receipts', async () => {
    const { input } = await enterpriseHoldout()
    const collector = new enterpriseReplay.EnterpriseMemoryReplay(db.db, authority, {
      text: textConfiguration,
      jevApiKey: 'synthetic-jev-key',
      workerId: 'evaluation-worker',
      fetch: upstream
    })
    const packet = await collector.collect(reference, input, undefined, async (receipt) => {
      receipt.reply = 'synthetic-hook-poison'
      receipt.inputTokens = 999999
      receipt.modelCallRefs = []
    })
    expect(
      packet.receipts.every(
        (r) =>
          r.reply !== 'synthetic-hook-poison' &&
          r.inputTokens === 30 &&
          r.modelCallRefs?.length === 3
      )
    ).toBe(true)
    expect(
      (
        await db.adminQuery('SELECT receipt FROM learning_evaluation_arms ORDER BY ordinal')
      ).rows.map((r) => (r as { receipt: unknown }).receipt)
    ).toEqual(packet.receipts)
    await collector.drain()
  })

  it.each(['reported', 'upper_bound', 'not_dispatched'] as const)(
    'uses persisted %s reservations for the frozen request ceiling before sending another HTTP call',
    async (measurement) => {
      const { input } = await enterpriseHoldout()
      let admitted: EnterpriseValidationRun | undefined
      const original = EnterpriseLearningValidationBudget.prototype.begin
      const begin = vi
        .spyOn(EnterpriseLearningValidationBudget.prototype, 'begin')
        .mockImplementationOnce(async function (
          this: EnterpriseLearningValidationBudget,
          ...args: Parameters<typeof original>
        ) {
          admitted = await original.apply(this, args)
          return admitted
        })
      const collector = new enterpriseReplay.EnterpriseMemoryReplay(db.db, authority, {
        text: textConfiguration,
        jevApiKey: 'synthetic-jev-key',
        workerId: 'evaluation-worker',
        fetch: upstream,
        onRun: async () => {
          // Actual durable accounting admissions stand in for a prior process's calls.
          // The collector's new in-memory counter has seen none of these reservations.
          const reconstructedBudget = new EnterpriseLearningValidationBudget(db.db, authority)
          for (let n = 0; n < input.maxRequests; n++) {
            const call = await reconstructedBudget.reserve(reference, admitted!, 100, 100)
            await call.settleUsage(
              measurement === 'upper_bound'
                ? undefined
                : { inputTokens: 0, outputTokens: 0, measurement }
            )
          }
          // A previous UTC accounting bucket must not replenish the batch's call ceiling.
          await db.adminExec('UPDATE learning_attempts SET day=day-1')
        }
      })
      try {
        await expect(collector.collect(reference, input)).rejects.toThrow()
        expect(requests).toHaveLength(0)
        expect(
          (await db.adminQuery('SELECT count(*)::int AS n FROM learning_attempts')).rows[0]
        ).toEqual({ n: input.maxRequests })
        expect(
          (
            await db.adminQuery(
              "SELECT count(*)::int AS n FROM learning_evaluation_arms WHERE state='completed'"
            )
          ).rows[0]
        ).toEqual({ n: 0 })
      } finally {
        begin.mockRestore()
        await collector.drain()
      }
    }
  )

  it('keeps a completed group and its fee references when the export callback fails', async () => {
    const { input } = await enterpriseHoldout()
    let runId = '',
      completed: enterpriseReplay.EnterpriseMemoryReplayPacket['receipts'][number] | undefined
    const collector = new enterpriseReplay.EnterpriseMemoryReplay(db.db, authority, {
      text: textConfiguration,
      jevApiKey: 'synthetic-jev-key',
      workerId: 'evaluation-worker',
      onRun: async (id) => {
        runId = id
      },
      fetch: upstream
    })
    await expect(
      collector.collect(reference, input, undefined, async (receipt) => {
        completed = receipt
        expect(
          (
            await db.adminQuery(
              'SELECT receipt FROM learning_evaluation_arms WHERE run_id=$1 AND state=$2',
              [runId, 'completed']
            )
          ).rows
        ).toEqual([{ receipt }])
        throw new Error('synthetic_checkpoint_export_failure')
      })
    ).rejects.toThrow('synthetic_checkpoint_export_failure')
    expect(completed?.modelCallRefs).toHaveLength(3)
    expect(requests).toHaveLength(3)
    expect(
      (
        await db.adminQuery('SELECT state FROM learning_evaluation_checkpoints WHERE run_id=$1', [
          runId
        ])
      ).rows[0]
    ).toEqual({ state: 'incomplete' })
    expect(await queue.usage(reference)).toMatchObject({ requests: 3, reportedRequests: 3 })
    expect(
      (await db.adminQuery('SELECT count(*)::int AS n FROM learning_background_leases')).rows[0]
    ).toEqual({ n: 0 })
    await collector.drain()
  })

  it('resumes the exact frozen assignments after a failed export without paying for its completed group', async () => {
    const { input } = await enterpriseHoldout()
    let runId = '',
      saved: enterpriseReplay.EnterpriseMemoryReplayPacket['receipts'][number] | undefined
    let time = Date.now()
    const options = {
      text: textConfiguration,
      jevApiKey: 'synthetic-jev-key',
      workerId: 'evaluation-worker',
      fetch: upstream,
      now: () => time,
      onRun: async (id: string) => {
        runId = id
      }
    }
    const first = new enterpriseReplay.EnterpriseMemoryReplay(db.db, authority, options)
    await expect(
      first.collect(reference, input, undefined, async (receipt) => {
        saved = receipt
        throw new Error('synthetic_export_failure')
      })
    ).rejects.toThrow('synthetic_export_failure')
    await first.drain()
    const assignments = (
      await db.adminQuery(
        'SELECT assignment_id::text FROM learning_evaluation_arms ORDER BY ordinal'
      )
    ).rows
    expect(requests).toHaveLength(3)
    time += 5001 // Controlled host clock satisfies the original failed-attempt backoff.
    const restarted = new enterpriseReplay.EnterpriseMemoryReplay(db.db, authority, options)
    const packet = await restarted.resume(reference, runId)
    expect(packet.receipts[0]).toEqual(saved)
    expect(packet.receipts.map((r) => ({ assignment_id: r.assignmentId }))).toEqual(assignments)
    expect(requests).toHaveLength(9)
    expect(
      (await db.adminQuery('SELECT count(*)::int AS n FROM learning_validation_runs')).rows[0]
    ).toEqual({ n: 1 })
    expect(
      (await db.adminQuery('SELECT attempt_count FROM learning_evaluation_checkpoints')).rows[0]
    ).toEqual({ attempt_count: 2 })
    expect(
      (await db.adminQuery('SELECT count(*)::int AS n FROM learning_background_leases')).rows[0]
    ).toEqual({ n: 0 })
    const exportedAgain = await new enterpriseReplay.EnterpriseMemoryReplay(
      db.db,
      authority,
      options
    ).resume(reference, runId)
    expect(exportedAgain).toEqual(packet)
    expect(requests).toHaveLength(9)
    await restarted.drain()
  })

  it('requires recovery of an existing frozen source instead of paying again through a replacement collect', async () => {
    const { input } = await enterpriseHoldout()
    let runId = '',
      time = Date.now()
    const options = {
      text: textConfiguration,
      jevApiKey: 'synthetic-jev-key',
      workerId: 'evaluation-worker',
      fetch: upstream,
      now: () => time,
      onRun: async (id: string) => {
        runId = id
      }
    }
    const first = new enterpriseReplay.EnterpriseMemoryReplay(db.db, authority, options)
    await expect(
      first.collect(reference, input, undefined, async () => {
        throw new Error('synthetic_export_failure')
      })
    ).rejects.toThrow('synthetic_export_failure')
    await first.drain()
    const originalRunId = runId
    time += 5001
    const restarted = new enterpriseReplay.EnterpriseMemoryReplay(db.db, authority, options)
    await expect(restarted.collect(reference, input)).rejects.toThrow('evaluation_resume_required')
    expect(requests).toHaveLength(3)
    expect(
      (await db.adminQuery('SELECT count(*)::int AS n FROM learning_validation_runs')).rows[0]
    ).toEqual({ n: 1 })
    const packet = await restarted.resume(reference, originalRunId)
    expect(packet.receipts).toHaveLength(3)
    expect(requests).toHaveLength(9)
    await expect(restarted.collect(reference, input)).rejects.toThrow('evaluation_resume_required')
    expect(requests).toHaveLength(9)
    await restarted.drain()
  })

  it('exports all durably completed groups after the final callback fails without another attempt', async () => {
    const { input } = await enterpriseHoldout()
    let runId = '',
      completed = 0
    const options = {
      text: textConfiguration,
      jevApiKey: 'synthetic-jev-key',
      workerId: 'evaluation-worker',
      fetch: upstream,
      onRun: async (id: string) => {
        runId = id
      }
    }
    const first = new enterpriseReplay.EnterpriseMemoryReplay(db.db, authority, options)
    await expect(
      first.collect(reference, input, undefined, async () => {
        if (++completed === 3) throw new Error('synthetic_final_export_failure')
      })
    ).rejects.toThrow('synthetic_final_export_failure')
    await first.drain()
    await db.adminExec('UPDATE learning_evaluation_checkpoints SET attempt_count=3')
    const restarted = new enterpriseReplay.EnterpriseMemoryReplay(db.db, authority, options)
    const packet = await restarted.resume(reference, runId)
    expect(packet.receipts).toHaveLength(3)
    expect(requests).toHaveLength(9)
    expect(
      (await db.adminQuery('SELECT state,attempt_count FROM learning_evaluation_checkpoints'))
        .rows[0]
    ).toEqual({ state: 'completed', attempt_count: 3 })
    expect((await db.adminQuery('SELECT state FROM learning_validation_runs')).rows[0]).toEqual({
      state: 'completed'
    })
    expect(
      (await db.adminQuery('SELECT count(*)::int AS n FROM learning_background_leases')).rows[0]
    ).toEqual({ n: 0 })
    await restarted.drain()
  })

  it('requires fee reconciliation instead of repeating a paid stage whose durable result was lost', async () => {
    const { input } = await enterpriseHoldout()
    let runId = '',
      time = Date.now()
    const options = {
      text: textConfiguration,
      jevApiKey: 'synthetic-jev-key',
      workerId: 'evaluation-worker',
      fetch: upstream,
      now: () => time,
      onRun: async (id: string) => {
        runId = id
      }
    }
    const save = vi
      .spyOn(EnterpriseEvaluationCheckpoint.prototype, 'saveStage')
      .mockRejectedValueOnce(new Error('synthetic_stage_disk_failure'))
    const first = new enterpriseReplay.EnterpriseMemoryReplay(db.db, authority, options)
    try {
      await expect(first.collect(reference, input)).rejects.toThrow()
    } finally {
      save.mockRestore()
      await first.drain()
    }
    expect(requests).toHaveLength(1)
    expect(
      (await db.adminQuery('SELECT count(*)::int AS n FROM learning_evaluation_stages')).rows[0]
    ).toEqual({ n: 0 })
    expect(await queue.usage(reference)).toMatchObject({ requests: 1, reportedRequests: 1 })
    time += 5001
    const restarted = new enterpriseReplay.EnterpriseMemoryReplay(db.db, authority, options)
    await expect(restarted.resume(reference, runId)).rejects.toThrow(
      'evaluation_usage_reconciliation_required'
    )
    expect(requests).toHaveLength(1)
    expect(
      (await db.adminQuery('SELECT attempt_count FROM learning_evaluation_checkpoints')).rows[0]
    ).toEqual({ attempt_count: 1 })
    await restarted.drain()
  })

  it('shares the three-attempt ceiling across restarts and rejects creating a replacement batch', async () => {
    const { input } = await enterpriseHoldout()
    input.maxRequests = 18
    input.cases.push({ ...input.cases[0], caseId: 'holdout-second' })
    let runId = '',
      time = Date.now()
    const options = {
      text: textConfiguration,
      jevApiKey: 'synthetic-jev-key',
      workerId: 'evaluation-worker',
      fetch: upstream,
      now: () => time,
      onRun: async (id: string) => {
        runId = id
      }
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const instance = new enterpriseReplay.EnterpriseMemoryReplay(db.db, authority, options)
      const stop = async (): Promise<void> => {
        throw new Error('synthetic_export_failure')
      }
      await expect(
        attempt
          ? instance.resume(reference, runId, undefined, stop)
          : instance.collect(reference, input, undefined, stop)
      ).rejects.toThrow('synthetic_export_failure')
      await instance.drain()
      time += 20001
    }
    expect(requests).toHaveLength(9)
    const restarted = new enterpriseReplay.EnterpriseMemoryReplay(db.db, authority, options)
    await expect(restarted.resume(reference, runId)).rejects.toThrow('attempt_limit')
    await expect(restarted.collect(reference, input)).rejects.toThrow('attempt_limit')
    expect(requests).toHaveLength(9)
    expect(
      (await db.adminQuery('SELECT count(*)::int AS n FROM learning_validation_runs')).rows[0]
    ).toEqual({ n: 1 })
    expect(
      (await db.adminQuery('SELECT attempt_count FROM learning_evaluation_checkpoints')).rows[0]
    ).toEqual({ attempt_count: 3 })
    await restarted.drain()
  })

  it('waits on the actual shared UTC budget mid-group and resumes saved paid stages in the next bucket', async () => {
    const { input } = await enterpriseHoldout()
    let runId = '',
      time = Date.now(),
      admissions = 0
    const options = {
      text: textConfiguration,
      jevApiKey: 'synthetic-jev-key',
      workerId: 'evaluation-worker',
      fetch: upstream,
      now: () => time,
      onRun: async (id: string) => {
        runId = id
      }
    }
    const original = EnterpriseLearningValidationBudget.prototype.reserve
    const reserve = vi
      .spyOn(EnterpriseLearningValidationBudget.prototype, 'reserve')
      .mockImplementation(async function (
        this: EnterpriseLearningValidationBudget,
        ...args: Parameters<typeof original>
      ) {
        if (++admissions === 2)
          await db.adminQuery(
            "INSERT INTO learning_retained_usage VALUES('company','account-A',$1::date,50000,0,0,1,1,0)",
            [new Date(time).toISOString().slice(0, 10)]
          )
        return original.apply(this, args)
      })
    const first = new enterpriseReplay.EnterpriseMemoryReplay(db.db, authority, options)
    try {
      await expect(first.collect(reference, input)).rejects.toThrow('evaluation_budget_waiting')
    } finally {
      reserve.mockRestore()
      await first.drain()
    }
    expect(requests).toHaveLength(1)
    expect(
      (await db.adminQuery('SELECT state,attempt_count FROM learning_evaluation_checkpoints'))
        .rows[0]
    ).toEqual({ state: 'waiting_budget', attempt_count: 1 })
    expect((await db.adminQuery('SELECT stage FROM learning_evaluation_stages')).rows).toEqual([
      { stage: 'pre' }
    ])
    expect(
      (await db.adminQuery('SELECT count(*)::int AS n FROM learning_background_leases')).rows[0]
    ).toEqual({ n: 0 })
    const restarted = new enterpriseReplay.EnterpriseMemoryReplay(db.db, authority, options)
    await expect(restarted.resume(reference, runId)).rejects.toThrow('evaluation_budget_waiting')
    expect(requests).toHaveLength(1)
    time = Date.parse(new Date(time).toISOString().slice(0, 10)) + 86400000 + 1000
    const packet = await restarted.resume(reference, runId)
    expect(packet.receipts).toHaveLength(3)
    expect(new Set(packet.receipts.flatMap((r) => r.modelCallRefs!)).size).toBe(9)
    expect(requests).toHaveLength(9)
    expect(
      (await db.adminQuery('SELECT attempt_count FROM learning_evaluation_checkpoints')).rows[0]
    ).toEqual({ attempt_count: 1 })
    expect(
      (
        await db.adminQuery(
          'SELECT day::text,count(*)::int AS n FROM learning_attempts GROUP BY day ORDER BY day'
        )
      ).rows
    ).toEqual([
      { day: new Date(time - 86400000).toISOString().slice(0, 10), n: 1 },
      { day: new Date(time).toISOString().slice(0, 10), n: 8 }
    ])
    await restarted.drain()
  })

  it.each([
    'publication',
    'model',
    'deployment',
    'forget',
    'expiry',
    'revoked',
    'settings',
    'missing_fee'
  ] as const)(
    'rejects recovering the old frozen batch after %s changes without another paid request',
    async (change) => {
      const { input } = await enterpriseHoldout()
      let runId = '',
        time = Date.now()
      const options = {
        text: textConfiguration,
        jevApiKey: 'synthetic-jev-key',
        workerId: 'evaluation-worker',
        fetch: upstream,
        now: () => time,
        onRun: async (id: string) => {
          runId = id
        }
      }
      const first = new enterpriseReplay.EnterpriseMemoryReplay(db.db, authority, options)
      await expect(
        first.collect(reference, input, undefined, async () => {
          throw new Error('synthetic_export_failure')
        })
      ).rejects.toThrow('synthetic_export_failure')
      await first.drain()
      time += 5001
      if (change === 'publication')
        await db.adminExec(
          "UPDATE generation_publications SET evidence_json=jsonb_set(evidence_json,'{0,content}','\"synthetic changed fact\"')"
        )
      if (change === 'deployment') deployment.changed = true
      if (change === 'forget')
        await repository.forgetScope(reference, input.cases[0].conversationId)
      if (change === 'expiry')
        await db.adminExec('UPDATE learning_evaluation_checkpoints SET expires_at=0')
      if (change === 'revoked')
        await db.adminQuery("UPDATE agents SET token_hash=$1 WHERE id='agent-A'", [
          tokenHash('Z'.repeat(43))
        ])
      if (change === 'settings') await repository.settings(reference, null, { mode: 'off' })
      if (change === 'missing_fee') await db.adminExec('DELETE FROM learning_attempts')
      const restarted = new enterpriseReplay.EnterpriseMemoryReplay(db.db, authority, {
        ...options,
        ...(change === 'model'
          ? { text: { ...textConfiguration, model: 'synthetic-changed-model' } }
          : {})
      })
      await expect(restarted.resume(reference, runId)).rejects.toThrow()
      expect(requests).toHaveLength(3)
      expect(
        (await db.adminQuery('SELECT count(*)::int AS n FROM learning_background_leases')).rows[0]
      ).toEqual({ n: 0 })
      await restarted.drain()
    }
  )

  it('recovers saved stages after an abandoned claim but marks the lost timing interval incomplete', async () => {
    const { input } = await enterpriseHoldout()
    let runId = '',
      time = Date.now()
    const options = {
      text: textConfiguration,
      jevApiKey: 'synthetic-jev-key',
      workerId: 'evaluation-worker',
      fetch: upstream,
      now: () => time,
      onRun: async (id: string) => {
        runId = id
      }
    }
    const original = EnterpriseEvaluationCheckpoint.prototype.saveStage
    const saved = vi
      .spyOn(EnterpriseEvaluationCheckpoint.prototype, 'saveStage')
      .mockImplementationOnce(async function (
        this: EnterpriseEvaluationCheckpoint,
        ...args: Parameters<typeof original>
      ) {
        await original.apply(this, args)
        throw new Error('synthetic_process_abandoned_after_saved_stage')
      })
    const first = new enterpriseReplay.EnterpriseMemoryReplay(db.db, authority, options)
    try {
      await expect(first.collect(reference, input)).rejects.toThrow()
    } finally {
      saved.mockRestore()
      await first.drain()
    }
    expect(requests).toHaveLength(1)
    await db.adminExec(
      "UPDATE learning_evaluation_checkpoints SET state='collecting'; UPDATE learning_evaluation_arms SET active_ms=0"
    )
    time += 5001
    const restarted = new enterpriseReplay.EnterpriseMemoryReplay(db.db, authority, options)
    const packet = await restarted.resume(reference, runId)
    expect(packet.receipts[0].latencyComplete).toBe(false)
    expect(packet.receipts.slice(1).every((r) => r.latencyComplete === true)).toBe(true)
    expect(requests).toHaveLength(9)
    expect(new Set(packet.receipts.flatMap((r) => r.modelCallRefs!)).size).toBe(9)
    await restarted.drain()
  })

  it('erases held-out checkpoint bodies on customer forgetting while keeping account fees', async () => {
    const { input } = await enterpriseHoldout()
    const collector = new enterpriseReplay.EnterpriseMemoryReplay(db.db, authority, {
      text: textConfiguration,
      jevApiKey: 'synthetic-jev-key',
      workerId: 'evaluation-worker',
      fetch: upstream
    })
    await collector.collect(reference, input)
    const before = await queue.usage(reference)
    await repository.forgetScope(reference, input.cases[0].conversationId)
    expect(
      (await db.adminQuery('SELECT count(*)::int AS n FROM learning_evaluation_checkpoints'))
        .rows[0]
    ).toEqual({ n: 0 })
    expect(
      (await db.adminQuery('SELECT count(*)::int AS n FROM learning_evaluation_arms')).rows[0]
    ).toEqual({ n: 0 })
    expect(await queue.usage(reference)).toEqual(before)
    await collector.drain()
  })

  it('denies device reads of held-out bodies but permits scoped privacy deletion', async () => {
    const { input } = await enterpriseHoldout()
    const collector = new enterpriseReplay.EnterpriseMemoryReplay(db.db, authority, {
      text: textConfiguration,
      jevApiKey: 'synthetic-jev-key',
      workerId: 'evaluation-worker',
      fetch: upstream
    })
    await collector.collect(reference, input)
    await expect(
      db.db.transaction('company', async (client) => {
        await client.query('SET LOCAL ROLE autoreply_app')
        await client.query("SELECT set_config('app.learning_account_id','account-A',true)")
        await client.query('SELECT basis FROM learning_evaluation_checkpoints')
      })
    ).rejects.toThrow('permission denied')
    await db.db.transaction('company', async (client) => {
      await client.query('SET LOCAL ROLE autoreply_app')
      await client.query("SELECT set_config('app.learning_account_id','account-A',true)")
      expect(
        (
          await client.query(
            'DELETE FROM learning_evaluation_checkpoints WHERE tenant_id=$1 AND account_id=$2',
            ['company', 'account-A']
          )
        ).rowCount
      ).toBe(1)
    })
    expect(
      (await db.adminQuery('SELECT count(*)::int AS n FROM learning_evaluation_arms')).rows[0]
    ).toEqual({ n: 0 })
    expect(await queue.usage(reference)).toMatchObject({ requests: 9 })
    await collector.drain()
  })

  it('purges expired held-out checkpoints through actual account retention', async () => {
    const { input } = await enterpriseHoldout()
    const collector = new enterpriseReplay.EnterpriseMemoryReplay(db.db, authority, {
      text: textConfiguration,
      jevApiKey: 'synthetic-jev-key',
      workerId: 'evaluation-worker',
      fetch: upstream
    })
    await collector.collect(reference, input)
    await db.adminExec('UPDATE learning_evaluation_checkpoints SET expires_at=0')
    await repository.pruneExpired(reference, null)
    expect(
      (await db.adminQuery('SELECT count(*)::int AS n FROM learning_evaluation_checkpoints'))
        .rows[0]
    ).toEqual({ n: 0 })
    expect(
      (await db.adminQuery('SELECT count(*)::int AS n FROM learning_evaluation_arms')).rows[0]
    ).toEqual({ n: 0 })
    expect(await queue.usage(reference)).toMatchObject({ requests: 9 })
    await collector.drain()
  })

  it('collects all three arms through enterprise Jev/text/audit without creating holdout episodes or send authority', async () => {
    expect(enterpriseReplay.EnterpriseMemoryReplay).toBeTypeOf('function')
    const { episode, memory, input } = await enterpriseHoldout()
    const counts = async () =>
      (
        await db.adminQuery(
          'SELECT (SELECT count(*) FROM learning_episodes)::int AS episodes,(SELECT count(*) FROM learning_preparations)::int AS preparations,(SELECT count(*) FROM generation_tasks)::int AS tasks,(SELECT count(*) FROM execution_permits)::int AS permits,(SELECT count(*) FROM learning_activation_grants)::int AS grants'
        )
      ).rows[0]
    const before = await counts()
    const collector = new enterpriseReplay.EnterpriseMemoryReplay(db.db, authority, {
      text: textConfiguration,
      jevApiKey: 'synthetic-jev-key',
      workerId: 'evaluation-worker',
      fetch: upstream
    })
    const packet = await collector.collect(reference, input)
    expect(packet.receipts).toHaveLength(3)
    expect(requests.filter((r) => r.provider === 'jev')).toHaveLength(6)
    expect(requests.filter((r) => r.provider === 'text')).toHaveLength(3)
    expect(requests.every((r) => !r.body.includes('HUMAN_RUBRIC_DO_NOT_SEND'))).toBe(true)
    const learned = packet.receipts.find((r) => r.arm === 'learned')!
    expect(learned.loadedMethodRefs).toEqual([
      { id: memory.id, revision: 1, contentHash: packet.frozen.methods[0].contentHash }
    ])
    expect(learned.loadedCaseRefs).toEqual([
      { id: episode.id, hash: learned.loadedCaseRefs![0].hash }
    ])
    expect(
      packet.receipts.every(
        (r) =>
          r.modelCallRefs?.length === 3 &&
          r.inputTokens === 30 &&
          r.outputTokens === 15 &&
          r.costUsd === null
      )
    ).toBe(true)
    expect(await counts()).toEqual(before)
    expect(await queue.usage(reference)).toMatchObject({
      requests: 9,
      reportedRequests: 9,
      estimatedRequests: 0
    })
    expect(
      (await db.adminQuery('SELECT count(*)::int AS n FROM learning_background_leases')).rows[0]
    ).toMatchObject({ n: 0 })
    const labels = packet.receipts.map((r) => ({
      assignmentId: r.assignmentId,
      origin: 'synthetic',
      reviewerId: 'fake-reviewer',
      evidenceRef: 'synthetic-only',
      labelledAt: Date.now() + 1,
      blinded: true,
      humanReviewed: r.reply !== null,
      substantialCorrection: false,
      severeError: false,
      validAnswer: r.reply !== null,
      costUsd: 0,
      costEvidenceRef: 'fake-provider-no-charge'
    }))
    const judged = enterpriseReplay.adjudicateEnterpriseMemoryReplay(packet, labels)
    expect(judged.version).toBe(2)
    expect(evaluateMemoryDataset(judged).assessment.status).toBe('insufficient')
    const missingCalls = structuredClone(packet)
    missingCalls.receipts[0].modelCallRefs = []
    expect(() => enterpriseReplay.adjudicateEnterpriseMemoryReplay(missingCalls, labels)).toThrow(
      'invalid_model_call_evidence'
    )
    expect(JSON.stringify(packet)).not.toContain(textConfiguration.apiKey)
    await collector.drain()
  })

  it('retains deterministic handoff cases with observed zero requests in all three arms', async () => {
    const { input } = await enterpriseHoldout()
    const collector = new enterpriseReplay.EnterpriseMemoryReplay(db.db, authority, {
      text: textConfiguration,
      jevApiKey: 'synthetic-jev-key',
      workerId: 'evaluation-worker',
      fetch: upstream
    })
    const packet = await collector.collect(reference, {
      ...input,
      maxRequests: 18,
      cases: [
        ...input.cases,
        {
          caseId: 'holdout-human',
          conversationId: 'second-independent-customer',
          category: 'handoff',
          inbound: ['请转人工客服']
        }
      ]
    })
    const handoffs = packet.receipts.filter((r) => r.caseId === 'holdout-human')
    expect(handoffs).toHaveLength(3)
    for (const r of handoffs)
      expect(r).toMatchObject({
        reply: null,
        pipelineStatus: 'handoff',
        pipelineReasons: ['explicit_human_request'],
        modelCallRefs: [],
        inputTokens: 0,
        outputTokens: 0
      })
    expect(requests).toHaveLength(9)
    const judged = enterpriseReplay.adjudicateEnterpriseMemoryReplay(
      packet,
      packet.receipts.map((r) => ({
        assignmentId: r.assignmentId,
        origin: 'synthetic',
        reviewerId: 'fake-reviewer',
        evidenceRef: 'synthetic-only',
        labelledAt: Date.now() + 1,
        blinded: true,
        humanReviewed: r.reply !== null,
        substantialCorrection: false,
        severeError: false,
        validAnswer: r.reply !== null,
        costUsd: 0,
        costEvidenceRef: 'synthetic-zero-not-a-real-bill'
      }))
    )
    expect(judged.cases.filter((c) => c.split === 'evaluate')).toHaveLength(2)
    expect(evaluateMemoryDataset(judged).assessment.status).toBe('insufficient')
    await collector.drain()
  })

  it('rejects a host reply-model fingerprint that differs from the actual publication before charging', async () => {
    const memory = await candidate()
    expect(
      await service(riskTransport, {
        ...textConfiguration,
        expectedModel: 'different-model'
      }).validate(reference, 'training', memory.id, 1)
    ).toMatchObject({
      status: 'failed',
      reasons: ['validation_reply_model_changed'],
      activated: false
    })
    expect(requests).toHaveLength(0)
    expect(await queue.usage(reference)).toMatchObject({ reservedTokens: 0, requests: 0 })
  })
  it('rejects missing learn sources, conversation leakage, request underbudget and host model drift before replay HTTP', async () => {
    const { input } = await enterpriseHoldout()
    const collector = new enterpriseReplay.EnterpriseMemoryReplay(db.db, authority, {
      text: textConfiguration,
      jevApiKey: 'synthetic-jev-key',
      workerId: 'evaluation-worker',
      fetch: upstream
    })
    await expect(
      collector.collect(reference, {
        ...input,
        sources: [{ ...input.sources[0], caseId: randomUUID() }]
      })
    ).rejects.toThrow('evaluation_source_not_in_learn_split')
    await expect(
      collector.collect(reference, {
        ...input,
        cases: [{ ...input.cases[0], conversationId: input.sources[0].conversationId }]
      })
    ).rejects.toThrow('conversation_split_overlap')
    await expect(collector.collect(reference, { ...input, maxRequests: 8 })).rejects.toThrow(
      'request_budget_exceeded'
    )
    const drift = new enterpriseReplay.EnterpriseMemoryReplay(db.db, authority, {
      text: { ...textConfiguration, expectedModel: 'drifted-provider' },
      jevApiKey: 'synthetic-jev-key',
      workerId: 'evaluation-worker',
      fetch: upstream
    })
    await expect(drift.collect(reference, input)).rejects.toThrow('evaluation_reply_model_changed')
    expect(requests).toEqual([])
    expect(await queue.usage(reference)).toMatchObject({ requests: 0, reservedTokens: 0 })
    await Promise.all([collector.drain(), drift.drain()])
  })

  it.each([
    'foreground',
    'settings',
    'revocation',
    'deployment',
    'baseline-renderer',
    'forget',
    'retention'
  ] as const)(
    'stops a held noncooperative evaluation after %s change and preserves its unknown charge without a packet',
    async (change) => {
      const { input } = await enterpriseHoldout()
      let entered!: () => void
      const started = new Promise<void>((resolve) => {
        entered = resolve
      })
      let release!: (response: Response) => void
      const held = new Promise<Response>((resolve) => {
        release = resolve
      })
      const collector = new enterpriseReplay.EnterpriseMemoryReplay(db.db, authority, {
        text: textConfiguration,
        jevApiKey: 'synthetic-jev-key',
        workerId: 'evaluation-worker',
        monitorIntervalMs: 5,
        fetch: async (url, init) => {
          requests.push({ provider: 'jev', body: String(init?.body) })
          expect(String(url)).toMatch(/^https:\/\/api\.typesafe\.ai\//)
          entered()
          return held
        }
      })
      const observed = collector.collect(reference, input).then(
        () => 'unexpected_complete_packet',
        () => 'incomplete'
      )
      try {
        await started
        if (change === 'foreground')
          await withLearningAccount(authority, reference, null, (client, scope) =>
            recordLearningForegroundWithin(client, scope)
          )
        else if (change === 'settings')
          await repository.settings(reference, null, { memoryEnabled: false })
        else if (change === 'forget')
          await repository.forgetScope(reference, input.cases[0].conversationId)
        else if (change === 'retention') {
          await db.adminExec('UPDATE learning_evaluation_checkpoints SET expires_at=0')
          await repository.pruneExpired(reference, null)
        } else if (change === 'deployment' || change === 'baseline-renderer') {
          deployment.file =
            change === 'deployment' ? '/learning-generation-context.ts' : '/src/core/ai-client.ts'
          deployment.changed = true
        } else await db.adminQuery('DELETE FROM learning_worker_bindings WHERE id=$1', [reference])
        let deadline: ReturnType<typeof setTimeout> | undefined
        try {
          expect(
            await Promise.race([
              observed,
              new Promise<string>((resolve) => {
                deadline = setTimeout(() => resolve('still_running'), 1000)
              })
            ])
          ).toBe('incomplete')
        } finally {
          clearTimeout(deadline)
        }
        expect(requests).toHaveLength(1)
        const ledger = (
          await db.adminQuery(
            'SELECT purpose,measurement,reserved_tokens,input_tokens,output_tokens FROM learning_attempts'
          )
        ).rows
        expect(ledger).toHaveLength(1)
        expect(ledger[0]).toMatchObject({ purpose: 'evaluation', measurement: 'upper_bound' })
        expect(Number((ledger[0] as { reserved_tokens: string }).reserved_tokens)).toBeGreaterThan(
          0
        )
        if (change === 'forget' || change === 'retention') {
          expect(
            (await db.adminQuery('SELECT count(*)::int AS n FROM learning_evaluation_checkpoints'))
              .rows[0]
          ).toEqual({ n: 0 })
          expect(
            (await db.adminQuery('SELECT count(*)::int AS n FROM learning_evaluation_arms')).rows[0]
          ).toEqual({ n: 0 })
          expect((await db.adminQuery('SELECT state FROM learning_attempts')).rows[0]).toEqual({
            state: 'cancelled'
          })
        }
        expect(
          (await db.adminQuery('SELECT count(*)::int AS n FROM generation_tasks')).rows[0]
        ).toMatchObject({ n: 0 })
        expect(
          (await db.adminQuery('SELECT count(*)::int AS n FROM execution_permits')).rows[0]
        ).toMatchObject({ n: 0 })
        expect(
          (await db.adminQuery('SELECT count(*)::int AS n FROM learning_activation_grants')).rows[0]
        ).toMatchObject({ n: 0 })
      } finally {
        deployment.changed = false
        release(Response.json(decision(JSON.parse(requests[0].body))))
        await collector.drain()
      }
      expect(requests).toHaveLength(1)
    }
  )
  it('rejects an actual pipeline audit failure even when text matches the human coverage terms', async () => {
    const memory = await candidate()
    badAudit = true
    expect(await service().validate(reference, 'training', memory.id, 1)).toMatchObject({
      status: 'failed',
      reasons: ['candidate_severe_error']
    })
    expect(await store.grants(reference, 'training', memory.id)).toEqual([])
    expect(await repository.get(reference, 'training', memory.id)).toMatchObject({
      state: 'pending'
    })
    expect(await queue.usage(reference)).toMatchObject({ reservedTokens: 105, requests: 7 })
  })
  it('preempts a noncooperating risk request and permits its late response to settle fees only', async () => {
    const memory = await candidate()
    await repository.settings(reference, 'training', { mode: 'auto' })
    let release!: (value: Awaited<ReturnType<LearningReviewTransport['complete']>>) => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const transport: LearningReviewTransport = {
      complete: () => {
        entered()
        return new Promise((resolve) => {
          release = resolve
        })
      }
    }
    const resultPromise = service(transport).validate(reference, 'training', memory.id, 1)
    await started
    await authority.withLockedAccount(
      reference,
      (client, scope) => recordLearningForegroundWithin(client, scope, now),
      true
    )
    expect(await resultPromise).toMatchObject({ status: 'failed', activated: false })
    expect(await store.grants(reference, 'training', memory.id)).toEqual([])
    expect(
      (await db.adminQuery('SELECT count(*)::int AS n FROM learning_background_leases')).rows[0]
    ).toMatchObject({ n: 0 })
    release({ text: '{}', usage: { inputTokens: 5, outputTokens: 4 } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(await queue.usage(reference)).toMatchObject({ reservedTokens: 9, reportedRequests: 1 })
    expect(await repository.get(reference, 'training', memory.id)).toMatchObject({
      state: 'pending',
      activeRevision: null
    })
  })
})
