import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { LearningStore } from '../../src/core/memory/learning-store'
import { KnowledgeStore } from '../../src/core/knowledge/knowledge-store'
import { HttpLearningReviewTransport } from '../../src/core/memory/learning-transport'
import { LearningProductValidation } from '../../src/main/services/learning-product-validation'
import { LearningService } from '../../src/main/services/learning-service'
import { LearningCurator } from '../../src/core/memory/learning-curator'
import type { LearningValidationCase } from '../../src/shared/contracts/learning-memory'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
const scope = { workspaceId: 'profile', platform: 'generic' as const, conversationId: 'customer' }
const cases: LearningValidationCase[] = Array.from({ length: 5 }, (_, i) => ({
  caseId: `human-${i}`,
  conversationId: `independent-${i}`,
  input: '设备报价',
  expectedMethod: '先问型号和数量',
  requiredTerms: ['型号', '数量'],
  forbiddenClaims: ['无条件退款'],
  humanLabelled: true,
  labelOrigin: 'human' as const // Simulated human declaration for engineering tests only.
}))
async function setup() {
  const store = new LearningStore(':memory:'),
    knowledge = new KnowledgeStore(':memory:')
  cleanup.push(
    () => store.close(),
    () => knowledge.close()
  )
  const doc = knowledge.begin('设备资料', 'txt', '产品')
  knowledge.finish(doc.id, '设备报价需核对产品资料，型号 X 的价格为 100 元。')
  const episode = store.recordEpisode(scope, {
    sourceId: 'training',
    topic: '设备报价',
    startedAt: 1000,
    messages: [],
    outcome: 'corrected',
    identityStatus: 'verified'
  })
  const memory = store.propose(scope, {
    content: {
      kind: 'lesson',
      scenario: '设备报价',
      guidance: '先问型号和数量',
      rationale: '',
      steps: [],
      pitfalls: [],
      verification: []
    },
    evidence: [{ episodeId: episode.id }],
    reason: '员工纠正',
    source: 'review'
  })
  store.settings(scope, { mode: 'auto' })
  const requests: { system: string; user: string }[] = []
  let duringRequest = (): void => {}
  const server: Server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk.toString()
    const parsed = JSON.parse(body) as { messages: { content: string }[] }
    const system = parsed.messages[0].content,
      user = parsed.messages[1].content
    requests.push({ system, user })
    duringRequest()
    const risk = system.includes('逐项核对外部记忆的语义')
    const input = risk
      ? (JSON.parse(user) as { contentHash: string; units: { path: string }[] })
      : null
    const output = input
      ? {
          contentHash: input.contentHash,
          units: input.units.map((unit) => ({
            path: unit.path,
            category: 'method',
            reason: '处理方法'
          }))
        }
      : { text: system.includes('先问型号和数量') ? '请确认型号和数量。' : '请确认型号。' }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(output) } }],
        usage: { prompt_tokens: 20, completion_tokens: 10 }
      })
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test_server_missing')
  const transport = new HttpLearningReviewTransport({
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    apiKey: 'loopback-only',
    model: 'fixture'
  })
  const validation = new LearningProductValidation(store, {
    knowledge: () => knowledge,
    policy: () => ({ rules: '礼貌回复，引用有效资料。', validatorVersion: 'fixture-validator-v1' }),
    transport
  })
  const service = new LearningService(
    store,
    { review: async () => ({ operations: [], usage: { inputTokens: 0, outputTokens: 0 } }) },
    { workspaceId: 'profile', validation }
  )
  return {
    store,
    knowledge,
    memory,
    doc,
    service,
    requests,
    during: (work: () => void) => {
      duringRequest = work
    }
  }
}
describe('production learning calibration through knowledge and HTTP', () => {
  it('validates a merged candidate without borrowing coverage from the methods it will replace', async () => {
    const { store, memory, service, requests } = await setup()
    const original = store.history(scope, memory.id)[0]
    store.revise(scope, memory.id, 1, {
      content: { ...original.content, guidance: '先问型号' },
      source: 'review',
      reason: '拆分前的型号方法',
      evidence: original.evidence
    })
    store.activate(scope, memory.id, 2)
    const second = store.propose(scope, {
      content: { ...original.content, guidance: '先问数量' },
      source: 'review',
      reason: '拆分前的数量方法',
      evidence: original.evidence
    })
    store.activate(scope, second.id, 1)
    store.settings(scope, { curatorMergeEnabled: true })
    const curator = new LearningCurator(store, {
      transport: {
        complete: async () => ({
          text: JSON.stringify({ content: original.content, reason: '合并同场景核对方法' }),
          usage: { inputTokens: 20, outputTokens: 10 }
        })
      }
    })
    const at = Date.now()
    await curator.run(scope, { dryRun: false, now: at })
    const report = await curator.run(scope, { dryRun: false, now: at + 14 * 86400000 })
    const candidateId = report.items[0].proposedId!
    store.validation.importCalibration(scope, { cases, humanConfirmed: true }, 'employee')
    expect(await service.validateCandidate(scope, candidateId, 1)).toMatchObject({
      status: 'passed',
      activated: true
    })
    expect(requests[1].system).toContain(memory.id)
    expect(requests[1].system).toContain(second.id)
    expect(requests[2].system).not.toContain(memory.id)
    expect(requests[2].system).not.toContain(second.id)
    expect(requests[2].system).toContain(candidateId)
    expect(store.get(scope, memory.id).state).toBe('archived')
    expect(store.get(scope, second.id).state).toBe('archived')
  })
  it('has no seeded labels and never calls the model or activates without human cases', async () => {
    const { store, memory, service, requests } = await setup()
    expect(await service.validateCandidate(scope, memory.id, 1)).toMatchObject({
      status: 'insufficient',
      reasons: ['independent_human_cases_required']
    })
    expect(requests).toHaveLength(0)
    expect(store.get(scope, memory.id).state).toBe('pending')
    expect(store.jobs.usage(scope).reservedTokens).toBe(0)
  })
  it('replays with real knowledge and temporary method context, bills every call and activates only after all five pairs', async () => {
    const { store, memory, service, requests, during } = await setup()
    store.validation.importCalibration(scope, { cases, humanConfirmed: true }, 'employee')
    during(() => expect(store.get(scope, memory.id).activeRevision).toBeNull())
    expect(await service.validateCandidate(scope, memory.id, 1)).toMatchObject({
      status: 'passed',
      baselineCovered: 0,
      candidateCovered: 5,
      activated: true
    })
    expect(requests).toHaveLength(11)
    expect(requests[2].system).toContain('知识依据')
    expect(requests[2].system).toContain('100 元')
    expect(requests[2].system).toContain('礼貌回复')
    expect(requests[2].system).toContain('工作记忆')
    expect(requests[2].user).toBe('设备报价')
    expect(requests[2].system).not.toContain('forbiddenClaims')
    expect(store.jobs.usage(scope).reservedTokens).toBe(330)
    expect(store.get(scope, memory.id).activeRevision).toBe(1)
  })
  it('rejects actual knowledge changes during replay and keeps fees without publishing the candidate', async () => {
    const { store, knowledge, doc, memory, service, requests, during } = await setup()
    store.validation.importCalibration(scope, { cases, humanConfirmed: true }, 'employee')
    during(() => {
      if (requests.length === 3) knowledge.finish(doc.id, '设备报价资料已更新，请先核对型号。')
    })
    expect(await service.validateCandidate(scope, memory.id, 1)).toMatchObject({ status: 'failed' })
    expect(store.get(scope, memory.id).state).toBe('pending')
    expect(store.jobs.usage(scope).reservedTokens).toBe(90)
  })
})
