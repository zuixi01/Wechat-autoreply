import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { Pool } from 'pg'
import { expect } from 'vitest'
import { z } from 'zod'
import type { Postgres } from '../../server/src/database/postgres'
import { AccountAuthority, tokenHash } from '../../server/src/auth/account-authority'
import { Administration } from '../../server/src/admin/administration'
import { ExecutionAuthority } from '../../server/src/execution/execution-authority'
import { TypeSafeClient } from '../../server/src/decision/typesafe-client'
import { HttpTextGenerator } from '../../server/src/generation/text-generator'
import { GenerationService } from '../../server/src/generation/generation-service'
import { ModelCallAuthority } from '../../server/src/generation/model-call-authority'
import { loadPublication, type Publication } from '../../server/src/generation/publication'
import { JevReplyPipeline } from '../../server/src/reply/jev-pipeline'
import { createApplication } from '../../server/src/http/application'
import { EnterpriseLearningManagement } from '../../server/src/learning/learning-service'
import { EnterpriseLearningWorkerAuthority } from '../../server/src/learning/learning-worker-authority'
import { EnterpriseLearningRepository } from '../../server/src/learning/learning-repository'
import {
  createEnterpriseLearningReviewer,
  assertEnterpriseLearningWorkerRole
} from '../../server/src/learning/learning-reviewer-service'
import { EnterpriseLearningProductValidation } from '../../server/src/learning/learning-product-validation'
import { EnterpriseLearningValidatorWorker } from '../../server/src/learning/learning-validator-worker'
import { HttpLearningReviewTransport } from '../../src/core/memory/learning-transport'
import { hashContext } from '../../src/core/reply/hashes'
import { enterpriseDraftSource } from '../../server/src/learning/learning-generation-context'
import type { GenerationInput, GenerationResult } from '../../src/shared/contracts/generation'
import type { ReplyTask } from '../../src/shared/contracts/task'
import type { JevRequest, JevResponse } from '../../src/shared/contracts/decision'
import type { LearningWorkbenchSnapshot } from '../../src/shared/contracts/learning-desktop'
import { taskFixture } from './task'
import { seedSyntheticApproval } from './evaluation-approval'
import {
  ITERATION_V1,
  ITERATION_V2,
  iterationCalibration
} from '../../scripts/learning-iteration-fixture'

/** Synthetic engineering only. Dedicated SQL logins, actual HTTP and production
 * services exercise iteration. The privileged synthetic admission fixture is
 * explicit; it cannot establish independent business evaluation or send consent. */
export async function* enterpriseAutomaticIteration(
  root: Pool,
  appDb: Postgres,
  adminDb: Postgres,
  workerDb: Postgres,
  credential: string,
  workerLogin = 'concurrency_learning'
): AsyncGenerator<string, true, unknown> {
  const requests: { kind: 'review' | 'risk' | 'text' | 'jev'; body: string }[] = []
  const outcomes: string[] = []
  const model = createServer(async (request, response) => {
    try {
      let raw = ''
      for await (const chunk of request) raw += String(chunk)
      let output: unknown
      if (request.url === '/jev') {
        requests.push({ kind: 'jev', body: raw })
        const input = JSON.parse(raw) as JevRequest
        const answers: JevResponse['answers'] = {}
        for (const [id, question] of Object.entries(input.questions))
          answers[id] =
            question.type === 'choice'
              ? {
                  type: 'choice',
                  choice: 'faq',
                  confidence: 0.99,
                  probabilities: { faq: 1, price: 0, order: 0, aftersales: 0, other: 0 }
                }
              : {
                  type: 'noul',
                  noul:
                    id === 'human_requested' || (id.startsWith('has_') && id !== 'has_faq') ? 0 : 1
                }
        output = { model: 'synthetic-jev', answers, usage: { input_tokens: 10, output_tokens: 5 } }
      } else {
        const envelope = z
          .object({ messages: z.array(z.object({ content: z.string() })).length(2) })
          .parse(JSON.parse(raw))
        const [system, user] = envelope.messages.map((entry) => entry.content)
        let content: unknown
        if (system.includes('loadedMemoryRefs')) {
          requests.push({ kind: 'review', body: user })
          const digest = z
            .object({
              episodes: z.array(
                z.object({ episodeId: z.string(), correction: z.string().optional() })
              ),
              memories: z.array(z.object({ memoryId: z.string(), expectedRevision: z.number() }))
            })
            .parse(JSON.parse(user))
          const episode = [...digest.episodes].reverse().find((entry) => entry.correction)
          if (!episode) throw new Error('synthetic_correction_missing')
          const memory = digest.memories[0]
          content = {
            operations: [
              {
                ...(memory
                  ? {
                      action: 'revise',
                      memoryId: memory.memoryId,
                      expectedRevision: memory.expectedRevision
                    }
                  : { action: 'create' }),
                proposal: {
                  content: {
                    kind: 'lesson',
                    scenario: '设备询价',
                    guidance: episode.correction,
                    rationale: '合成员工明确纠正',
                    steps: [],
                    pitfalls: [],
                    verification: []
                  },
                  evidence: [{ episodeId: episode.episodeId }],
                  reason: '合成纠正来源'
                }
              }
            ]
          }
        } else if (system.includes('逐项核对外部记忆的语义')) {
          requests.push({ kind: 'risk', body: user })
          const assessment = z
            .object({ contentHash: z.string(), units: z.array(z.object({ path: z.string() })) })
            .parse(JSON.parse(user))
          content = {
            contentHash: assessment.contentHash,
            units: assessment.units.map((unit) => ({
              path: unit.path,
              category: 'method',
              reason: '合成处理方法'
            }))
          }
        } else {
          requests.push({ kind: 'text', body: user })
          const input = z
            .object({ process_reference: z.string().optional() })
            .parse(JSON.parse(user))
          // Read only the active method section. Historical corrections cannot masquerade as activated methods.
          const active = input.process_reference?.split('工作记忆：')[1]?.split('\n')[1]
          const methods = active
            ? z.array(z.object({ guidance: z.string() })).parse(JSON.parse(active))
            : []
          const version = methods.some((entry) => entry.guidance === ITERATION_V2)
            ? 2
            : methods.some((entry) => entry.guidance === ITERATION_V1)
              ? 1
              : 0
          content = {
            text: ['请确认型号。', '请确认型号和数量。', '请确认型号、数量和用途。'][version],
            evidenceIds: [`synthetic-faq-${version}`]
          }
        }
        output = {
          model: 'synthetic-text',
          choices: [
            {
              finish_reason: 'stop',
              message: { role: 'assistant', content: JSON.stringify(content) }
            }
          ],
          usage: { prompt_tokens: 20, completion_tokens: 10 }
        }
      }
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(output))
    } catch {
      response.writeHead(500)
      response.end('synthetic_model_invalid_request')
    }
  })
  await new Promise<void>((done) => model.listen(0, '127.0.0.1', done))
  const base = `http://127.0.0.1:${(model.address() as AddressInfo).port}`
  // Fixed production HTTPS configuration is preserved; the fixture redirects
  // only these two trusted provider origins to its actual loopback HTTP server.
  const upstream: typeof fetch = (url, init) => {
    const value = String(url)
    if (value.startsWith('https://api.typesafe.ai/')) return fetch(`${base}/jev`, init)
    if (value === 'https://synthetic.invalid/v1/chat/completions')
      return fetch(`${base}/text`, init)
    throw new Error('external_network_forbidden_in_iteration_fixture')
  }
  const textConfiguration = {
    apiKey: 'synthetic-key',
    baseUrl: 'https://synthetic.invalid/v1/',
    model: 'synthetic-text',
    expectedModel: 'synthetic-text'
  }
  const authority = new AccountAuthority(appDb)
  const meter = new ModelCallAuthority(appDb, authority)
  const generator = new HttpTextGenerator({
    ...textConfiguration,
    fetch: meter.transport('text', upstream, 'synthetic-text')
  })
  const pipeline = new JevReplyPipeline(
    new TypeSafeClient({
      apiKey: 'synthetic-key',
      fetch: meter.transport('jev', upstream),
      maxAttempts: 1
    }),
    generator
  )
  const execution = new ExecutionAuthority(authority, async (db, scope) => {
    await loadPublication(db, scope)
  })
  const generation = new GenerationService(
    authority,
    execution,
    pipeline,
    generator.version,
    10,
    meter
  )
  const management = new EnterpriseLearningManagement(appDb, authority)
  const application = createServer(
    createApplication(authority, { generation, learning: management })
  )
  const reviewer = await createEnterpriseLearningReviewer(workerDb, {
    models: [
      {
        id: 'reply-main',
        model: 'synthetic-review',
        baseURL: `${base}/v1`,
        apiKey: 'synthetic-key'
      }
    ],
    fallbackModelId: 'reply-main',
    pollIntervalMs: 250,
    monitorIntervalMs: 500
  })
  await assertEnterpriseLearningWorkerRole(workerDb)
  const workerAuthority = new EnterpriseLearningWorkerAuthority(workerDb)
  const repository = new EnterpriseLearningRepository(workerAuthority)
  const product = new EnterpriseLearningProductValidation(workerDb, workerAuthority, {
    text: textConfiguration,
    jevApiKey: 'synthetic-key',
    riskTransport: new HttpLearningReviewTransport({
      baseURL: `${base}/v1`,
      model: 'synthetic-review',
      apiKey: 'synthetic-key'
    }),
    validatorVersion: 'synthetic-enterprise-iteration-human-origin-v2',
    workerId: 'synthetic-iteration-validator',
    monitorIntervalMs: 500,
    fetch: upstream
  })
  const validator = new EnterpriseLearningValidatorWorker(product, {
    references: () => workerAuthority.references(),
    pollIntervalMs: 250,
    onOutcome: (outcome) => outcomes.push(outcome)
  })
  const reference = randomUUID()
  const admin = new Administration(adminDb, generator.version)
  try {
    await root.query(
      "UPDATE generation_tasks SET status='failed' WHERE tenant_id='company' AND account_id='account-A'"
    )
    await root.query(
      'INSERT INTO learning_worker_bindings(id,login_name,tenant_id,account_id,employee_id,agent_id,agent_token_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        reference,
        workerLogin,
        'company',
        'account-A',
        'employee-A',
        'agent-A',
        tokenHash(credential)
      ]
    )
    await new Promise<void>((done) => application.listen(0, '127.0.0.1', done))
    const serviceUrl = `http://127.0.0.1:${(application.address() as AddressInfo).port}`
    const post = async (path: string, input: unknown): Promise<unknown> => {
      const result = await fetch(`${serviceUrl}/v1/${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(input)
      })
      const body = await result.json()
      expect(result.status, JSON.stringify(body)).toBe(200)
      return body
    }
    const snapshot = async (): Promise<LearningWorkbenchSnapshot> =>
      (await post('learning/snapshot', {
        conversationId: 'customer-A'
      })) as LearningWorkbenchSnapshot
    const state = async (): Promise<
      { current_revision: number; active_revision: number | null } | undefined
    > =>
      (
        await root.query(
          "SELECT current_revision,active_revision FROM learning_memories WHERE tenant_id='company' AND account_id='account-A' AND conversation_id='customer-A'"
        )
      ).rows[0]
    const wait = async (condition: () => Promise<boolean>, calibration = false): Promise<void> => {
      const end = Date.now() + (calibration ? 20000 : 9000)
      while (Date.now() < end) {
        if (await condition()) return
        await delay(50)
      }
      throw new Error(
        JSON.stringify({
          code: 'enterprise_automatic_iteration_timeout',
          snapshot: await snapshot(),
          reports: await post('learning/reports', { conversationId: 'customer-A' }),
          runs: (
            await root.query(
              "SELECT state,source_id,finished_at FROM learning_validation_runs WHERE tenant_id='company' AND account_id='account-A'"
            )
          ).rows,
          outcomes,
          requestCounts: Object.fromEntries(
            ['review', 'risk', 'text', 'jev'].map((kind) => [
              kind,
              requests.filter((request) => request.kind === kind).length
            ])
          )
        })
      )
    }
    const at = Date.now()
    const template: Publication = {
      configuration: {
        configVersion: 'synthetic-template',
        knowledgeVersion: 'knowledge-1',
        decisionPolicyVersion: 'policy-1',
        questionSetVersion: 'questions-1',
        modelResolved: 'synthetic-jev',
        automaticEnabled: true
      },
      policy: {
        version: 'policy-1',
        knowledgeVersion: 'knowledge-1',
        questionSetVersion: 'questions-1',
        mode: 'enforced',
        modelAlias: 'synthetic-jev',
        modelResolved: 'synthetic-jev',
        evaluationApproved: true,
        automaticIntents: ['faq'],
        minimumChoiceProbability: 0.9,
        minimumChoiceConfidence: 0.8,
        minimumChoiceMargin: 0.3,
        presentIntentProbability: 0.9,
        humanRequestThreshold: 0.2,
        minimumAuditProbability: 0.95,
        reviewValidityMs: 5000,
        preBudgetMs: 1000,
        postBudgetMs: 1000
      },
      textGeneratorVersion: generator.version,
      evidence: ['请确认型号。', '请确认型号和数量。', '请确认型号、数量和用途。'].map(
        (content, index) => ({
          evidenceId: `synthetic-faq-${index}`,
          tenantId: 'company',
          accountId: 'account-A',
          knowledgeVersion: 'knowledge-1',
          intent: 'faq',
          kind: 'approved_faq',
          content,
          source: '合成已审核问答',
          approvedBy: 'synthetic-reviewer',
          validFrom: at - 1000,
          expiresAt: at + 600000
        })
      )
    }
    const publish = async (): Promise<void> => {
      const prepared = await admin.prepareLearningPublication('company', 'account-A', template)
      // No fabricated business labels: reuse the clearly marked privileged
      // engineering admission helper in this fresh isolated test database only.
      const publication = await seedSyntheticApproval(
        {
          adminQuery: async (text, values) => {
            const result = await root.query(text, values)
            return { ...result, rowCount: result.rowCount ?? result.rows.length }
          }
        },
        prepared.publication
      )
      await admin.publish('company', 'account-A', publication)
    }
    const generate = async (): Promise<GenerationResult> => {
      const cfg = await generation.configuration(credential)
      const context: GenerationInput['context'] = [
        {
          sequence: 1,
          sourceMessageId: randomUUID(),
          direction: 'inbound',
          kind: 'text',
          text: '设备询价'
        }
      ]
      const input: GenerationInput = {
        task: {
          ...taskFixture().task,
          configVersion: cfg.configVersion,
          knowledgeVersion: cfg.knowledgeVersion,
          decisionPolicyVersion: cfg.decisionPolicyVersion,
          questionSetVersion: cfg.questionSetVersion,
          taskId: randomUUID(),
          conversationId: 'customer-A',
          inboundRange: { from: 1, to: 1 },
          contextHash: hashContext(context),
          createdAt: Date.now(),
          expiresAt: Date.now() + 60000
        },
        context,
        inbound: ['设备询价']
      }
      input.task = (await post('replies/prepare', input)) as ReplyTask
      return (await post('replies/generate', input)) as GenerationResult
    }
    const correct = async (result: GenerationResult, text: string): Promise<void> => {
      const episode = (await repository.episodes(reference, 'customer-A')).find(
        (item) => item.sourceId === enterpriseDraftSource(result.task)
      )
      expect(episode).toBeDefined()
      await post('learning/episode-correction', {
        conversationId: 'customer-A',
        episodeId: episode!.id,
        sourceId: randomUUID(),
        text,
        reason: '合成员工明确纠正'
      })
    }
    await post('learning/settings', {
      conversationId: 'customer-A',
      patch: { mode: 'auto', idleDelayMs: 1000 }
    })
    await admin.setModelLimits('company', 'account-A', { dailyAttemptLimit: 100 })
    await publish()
    reviewer.start()
    validator.start()
    const baseline = await generate()
    expect(baseline, JSON.stringify({ baseline, requests })).toMatchObject({
      automaticAllowed: true,
      draft: { text: '请确认型号。' }
    })
    await correct(baseline, ITERATION_V1)
    await wait(async () => (await state())?.current_revision === 1)
    await reviewer.stop()
    expect((await snapshot()).memories[0].record.activeRevision).toBeNull()
    yield 'pending-v1'
    await post('learning/calibration', {
      conversationId: 'customer-A',
      input: { cases: iterationCalibration(1), humanConfirmed: true }
    })
    await wait(async () => (await state())?.active_revision === 1, true)
    expect((await snapshot()).publication?.state).toBe('outdated')
    await expect(generate()).rejects.toThrow('CONFIGURATION_CHANGED')
    yield 'validated-v1'
    await publish()
    const v1 = await generate()
    expect(v1).toMatchObject({ automaticAllowed: true, draft: { text: '请确认型号和数量。' } })
    await post('learning/settings', { conversationId: 'customer-A', patch: { mode: 'suggest' } })
    reviewer.start()
    await correct(v1, ITERATION_V2)
    await wait(async () => (await state())?.current_revision === 2)
    await reviewer.stop()
    expect((await snapshot()).memories[0].record.activeRevision).toBe(1)
    const pending = await generate()
    expect(pending.draft?.text).toBe('请确认型号和数量。')
    await post('learning/calibration', {
      conversationId: 'customer-A',
      input: { cases: iterationCalibration(2), humanConfirmed: true }
    })
    await post('learning/settings', { conversationId: 'customer-A', patch: { mode: 'auto' } })
    yield 'pending-v2'
    await wait(async () => (await state())?.active_revision === 2, true)
    await expect(generate()).rejects.toThrow('CONFIGURATION_CHANGED')
    yield 'validated-v2'
    await publish()
    const v2 = await generate()
    expect(v2).toMatchObject({
      automaticAllowed: true,
      draft: { text: '请确认型号、数量和用途。' }
    })
    const memory = (await snapshot()).memories[0].record
    await post('learning/action', {
      conversationId: 'customer-A',
      command: { action: 'rollback', id: memory.id, expectedRevision: 2, targetRevision: 1 }
    })
    expect((await snapshot()).memories[0].record.activeRevision).toBe(3)
    await expect(generate()).rejects.toThrow('CONFIGURATION_CHANGED')
    yield 'rollback-v3'
    await publish()
    const restored = await generate()
    expect(restored).toMatchObject({
      automaticAllowed: true,
      draft: { text: '请确认型号和数量。' }
    })
    expect(requests.filter((item) => item.kind === 'review')).toHaveLength(2)
    expect(
      requests
        .filter((item) => item.kind === 'text')
        .every((item) => !item.body.includes('human-only-rubric'))
    ).toBe(true)
    const final = await snapshot()
    expect(final.memories).toHaveLength(1)
    expect(final.publication?.state).toBe('current')
    expect(final.usage).toMatchObject({ requests: 64, reportedRequests: 64, estimatedRequests: 0 })
    for (const [result, revision] of [
      [v1, 1],
      [pending, 1],
      [v2, 2],
      [restored, 3]
    ] as const) {
      const saved = await root.query(
        'SELECT refs_json FROM learning_generations WHERE tenant_id=$1 AND account_id=$2 AND generation_id=$3',
        ['company', 'account-A', enterpriseDraftSource(result.task)]
      )
      expect(saved.rows[0]?.refs_json).toEqual([{ id: memory.id, revision }])
    }
    expect(final.memories[0].metrics.adopted).toBe(0)
    expect(
      Number(
        (
          await root.query(
            "SELECT count(*) AS n FROM execution_permits WHERE tenant_id='company' AND account_id='account-A'"
          )
        ).rows[0].n
      )
    ).toBe(0)
    return true
  } finally {
    await reviewer.shutdown()
    await validator.shutdown()
    application.closeAllConnections()
    model.closeAllConnections()
    await Promise.all([
      new Promise<void>((done) => application.close(() => done())),
      new Promise<void>((done) => model.close(() => done()))
    ])
  }
}
