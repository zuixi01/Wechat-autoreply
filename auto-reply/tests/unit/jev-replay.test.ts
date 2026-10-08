import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import {
  executeJevReplayArm,
  replayFrozenJevCases,
  type AuthorizedReplaySource,
  type ReplayAttempt,
  type ReplayProviders
} from '../../evals/jev/replay'
import { replayCaseInputHash, type ReplayCaseInput } from '../../evals/jev/replay-input'
import { PublicationSchema, type Publication } from '../../server/src/generation/publication'
import { evaluationSnapshotHash } from '../../server/src/generation/evaluation-authorization'
import { preQuestions, auditQuestions } from '../../server/src/reply/jev-pipeline'
import type { JevRequest, JevResponse } from '../../src/shared/contracts/decision'
import { hashContext } from '../../src/core/reply/hashes'
import { evaluationPlan } from '../fixtures/evaluation-data'
import { taskFixture } from '../fixtures/task'

let publication: Publication
beforeAll(async () => {
  publication = PublicationSchema.parse(
    JSON.parse(await readFile('server/admin/publication.example.json', 'utf8'))
  )
  publication.configuration = {
    ...publication.configuration,
    modelResolved: 'jev-test',
    automaticEnabled: true
  }
  publication.policy = {
    ...publication.policy,
    modelAlias: 'jev-test-alias',
    modelResolved: 'jev-test',
    mode: 'enforced',
    evaluationApproved: true
  }
  publication.textGeneratorVersion = 'synthetic-text-version'
  publication.retrieval = 'lexical-v1'
  publication.replyRules = '简洁回复。'
  publication.evidence = [
    {
      evidenceId: 'faq-A',
      tenantId: 'company',
      accountId: 'account-A',
      conversationId: 'customer-A',
      intent: 'faq',
      knowledgeVersion: 'knowledge-1',
      kind: 'approved_faq',
      content: '本产品支持离线阅读。',
      source: 'synthetic fixture, no business evidence',
      approvedBy: 'synthetic-reviewer',
      validFrom: 0,
      expiresAt: 100000
    }
  ]
})
afterEach(() => vi.useRealTimers())

function response(request: JevRequest): JevResponse {
  return {
    model: 'jev-test',
    usage: { input_tokens: 10, output_tokens: 5 },
    answers: Object.fromEntries(
      Object.entries(request.questions).map(([id, q]) => [
        id,
        q.type === 'choice'
          ? {
              type: 'choice',
              choice: 'faq',
              confidence: 1,
              probabilities: { faq: 1, price: 0, order: 0, aftersales: 0, other: 0 }
            }
          : {
              type: 'noul',
              noul: id === 'human_requested' || (id.startsWith('has_') && id !== 'has_faq') ? 0 : 1
            }
      ])
    )
  }
}
function fixture() {
  const identity = taskFixture().task.identity
  const p = structuredClone(publication)
  const item: ReplayCaseInput = {
    caseId: 'case-0',
    conversationGroup: 'conversation-0',
    split: 'calibration',
    conversationId: 'customer-A',
    inbound: ['支持离线阅读吗？']
  }
  const plan = evaluationPlan()
  plan.replayProtocol = 'jev-abc-v1'
  for (const a of plan.assignments)
    a.inputHash = a.caseId === item.caseId ? replayCaseInputHash(item) : hashContext(a)
  const frozen: AuthorizedReplaySource = {
    authenticatedScope: {
      tenantId: identity.tenantId,
      accountId: identity.accountId,
      employeeId: identity.employeeId,
      platform: identity.platform
    },
    runId: 'synthetic-run',
    publication: p,
    snapshotHash: evaluationSnapshotHash(p),
    plan,
    createdAt: new Date(1000),
    serverNow: new Date(10000),
    expiresAt: new Date(100000)
  }
  const decision = { evaluate: vi.fn(async (r: JevRequest) => response(r)) }
  const generator = {
    generate: vi.fn(async () => ({ text: p.evidence[0].content, evidenceIds: ['faq-A'] }))
  }
  let now = 10000
  const providers: ReplayProviders = {
    decision,
    generator,
    textGeneratorVersion: p.textGeneratorVersion,
    expectedTextModel: 'text-test',
    now: () => now
  }
  const bindCase = () => {
    frozen.plan.assignments[0].inputHash = replayCaseInputHash(item)
  }
  const bindPublication = () => {
    frozen.snapshotHash = evaluationSnapshotHash(p)
  }
  return {
    input: { frozen, caseInput: item, identity },
    p,
    item,
    providers,
    decision,
    generator,
    bindCase,
    bindPublication,
    setTime: (v: number) => {
      now = v
    }
  }
}
function attempt(stage: 'pre' | 'text' | 'post', id: string = stage): ReplayAttempt {
  return {
    attemptId: id,
    stage,
    start: {
      provider: stage === 'text' ? 'text' : 'jev',
      requestedModel: stage === 'text' ? 'text-test' : 'jev-test-alias',
      requestHash: 'a'.repeat(64),
      ...(stage !== 'text'
        ? { questionHash: hashContext(stage === 'pre' ? preQuestions() : auditQuestions()) }
        : {})
    },
    result: {
      outcome: 'response',
      durationMs: 1,
      actualModel: stage === 'text' ? 'text-test' : 'jev-test',
      usage: { inputTokens: stage === 'text' ? 100 : 10, outputTokens: stage === 'text' ? 50 : 5 }
    }
  }
}

describe('isolated real-provider-port Jev A/B/C candidate execution', () => {
  it('uses identical normalized model input while retaining the original frozen bytes', async () => {
    const f = fixture()
    f.item.inbound = ['  支持离线阅读吗？  ']
    f.bindCase()
    for (const arm of ['A', 'B', 'C'] as const) {
      const artifact = await executeJevReplayArm(arm, f.input, f.providers)
      expect(artifact.inputHash).toBe(replayCaseInputHash(f.item))
    }
    for (const [request] of f.generator.generate.mock.calls as unknown as [
      { inbound: string[] }
    ][]) {
      expect(request.inbound).toEqual(['支持离线阅读吗？'])
    }
    for (const [request] of f.decision.evaluate.mock.calls)
      expect(request.state).toMatchObject({ untrusted_inbound: ['支持离线阅读吗？'] })
  })

  it('runs independent A:text, B:pre/text and C:pre/text/post calls without simulated approvals or a sender contract', async () => {
    const f = fixture()
    const outputs = []
    for (const arm of ['A', 'B', 'C'] as const)
      outputs.push(await executeJevReplayArm(arm, f.input, f.providers))
    expect(f.generator.generate).toHaveBeenCalledTimes(3)
    expect(f.decision.evaluate).toHaveBeenCalledTimes(3)
    expect(outputs.map((o) => o.stages.map((s) => s.stage))).toEqual([
      ['text'],
      ['pre', 'text'],
      ['pre', 'text', 'post']
    ])
    expect(new Set(outputs.map((o) => o.assignmentId)).size).toBe(3)
    for (const o of outputs) {
      expect(o).toMatchObject({
        status: 'candidate',
        wouldRelease: true,
        factsVerified: true,
        releaseAuthorized: false,
        billedCostMicros: null,
        usage: null,
        usageSource: 'unknown'
      })
      expect(o.draft).toMatchObject({ text: f.p.evidence[0].content, evidenceIds: ['faq-A'] })
      expect(o).not.toHaveProperty('task')
      expect(o).not.toHaveProperty('review')
      expect(o.draft).not.toHaveProperty('taskId')
    }
    expect(outputs[0].pre).toBeNull()
    expect(outputs[1].post).toBeNull()
    expect(outputs[2].post?.answers.supported).toMatchObject({ type: 'noul', noul: 1 })
  })

  it('shares the exact production human-request threshold and preserves secondary-intent handoff', async () => {
    for (const arm of ['B', 'C'] as const) {
      const human = fixture()
      human.decision.evaluate.mockImplementation(async (r) => {
        const answer = response(r)
        answer.answers.human_requested = {
          type: 'noul',
          noul: human.p.policy.humanRequestThreshold
        }
        return answer
      })
      expect(await executeJevReplayArm(arm, human.input, human.providers)).toMatchObject({
        wouldRelease: false,
        status: 'handoff',
        reasons: ['human_requested_or_uncertain']
      })
      expect(human.generator.generate).not.toHaveBeenCalled()
      const mixed = fixture()
      mixed.decision.evaluate.mockImplementation(async (r) => {
        const a = response(r)
        a.answers.has_aftersales = { type: 'noul', noul: 0.99 }
        return a
      })
      expect(await executeJevReplayArm(arm, mixed.input, mixed.providers)).toMatchObject({
        status: 'handoff',
        reasons: ['intent_outside_scope'],
        intents: ['faq', 'aftersales']
      })
      expect(mixed.generator.generate).not.toHaveBeenCalled()
    }
  })

  it('calls a genuine post decision only in C and its failure changes release projection', async () => {
    const f = fixture()
    f.decision.evaluate.mockImplementation(async (r) => {
      const a = response(r)
      if (r.questions.supported) a.answers.supported = { type: 'noul', noul: 0.2 }
      return a
    })
    const b = await executeJevReplayArm('B', f.input, f.providers)
    const c = await executeJevReplayArm('C', f.input, f.providers)
    expect(b.wouldRelease).toBe(true)
    expect(c).toMatchObject({
      status: 'candidate',
      wouldRelease: false,
      reasons: ['audit_supported']
    })
    expect(f.decision.evaluate.mock.calls.map(([r]) => Boolean(r.questions.supported))).toEqual([
      false,
      false,
      true
    ])
  })

  it('keeps threshold equality and resolved-model drift identical between B and production C', async () => {
    for (const arm of ['B', 'C'] as const) {
      const f = fixture()
      f.p.policy.minimumChoiceMargin = 0.8
      f.bindPublication()
      f.decision.evaluate.mockImplementation(async (r) => {
        const a = response(r)
        if (r.questions.primary_intent) {
          a.answers.primary_intent = {
            type: 'choice',
            choice: 'faq',
            confidence: f.p.policy.minimumChoiceConfidence,
            probabilities: {
              faq: f.p.policy.minimumChoiceProbability,
              price: 1 - f.p.policy.minimumChoiceProbability,
              order: 0,
              aftersales: 0,
              other: 0
            }
          }
          a.answers.has_faq = { type: 'noul', noul: f.p.policy.presentIntentProbability }
        }
        return a
      })
      expect((await executeJevReplayArm(arm, f.input, f.providers)).wouldRelease).toBe(true)
      const drift = fixture()
      drift.decision.evaluate.mockImplementation(async (r) => ({
        ...response(r),
        model: 'changed-model'
      }))
      expect(await executeJevReplayArm(arm, drift.input, drift.providers)).toMatchObject({
        status: 'invalid',
        wouldRelease: false,
        reasons: ['model_drift']
      })
      expect(drift.generator.generate).not.toHaveBeenCalled()
    }
  })

  it('records the explicit broad A route instead of secretly using a Jev oracle to choose its intent set', async () => {
    const f = fixture()
    delete f.p.retrieval
    f.p.policy.automaticIntents = ['faq', 'order']
    f.p.evidence.push({
      ...f.p.evidence[0],
      evidenceId: 'order-A',
      intent: 'order',
      content: '合成订单规则。'
    })
    f.bindPublication()
    const a = await executeJevReplayArm('A', f.input, f.providers)
    const b = await executeJevReplayArm('B', f.input, f.providers)
    expect(a).toMatchObject({
      baselineRoute: 'automatic-intents-with-scoped-evidence-v1',
      intents: ['faq', 'order'],
      status: 'invalid',
      reasons: ['evidence_reference_invalid']
    })
    expect(b).toMatchObject({ intents: ['faq'], wouldRelease: true })
    expect(f.decision.evaluate).toHaveBeenCalledTimes(1)
  })

  it('retains deterministic explicit-human, facts, evidence expiry and customer-scope gates in every arm', async () => {
    for (const arm of ['A', 'B', 'C'] as const) {
      const human = fixture()
      human.item.inbound = ['请转人工处理']
      human.bindCase()
      expect(await executeJevReplayArm(arm, human.input, human.providers)).toMatchObject({
        status: 'handoff',
        reasons: ['explicit_human_request'],
        wouldRelease: false
      })
      expect(human.decision.evaluate).not.toHaveBeenCalled()
      expect(human.generator.generate).not.toHaveBeenCalled()
      const invented = fixture()
      invented.generator.generate.mockResolvedValue({
        text: '再给您免单退款。',
        evidenceIds: ['faq-A']
      })
      expect(await executeJevReplayArm(arm, invented.input, invented.providers)).toMatchObject({
        factsVerified: false,
        wouldRelease: false,
        reasons: ['freeform_requires_human']
      })
      const scoped = fixture()
      scoped.p.evidence[0].conversationId = 'another-customer'
      scoped.bindPublication()
      expect(await executeJevReplayArm(arm, scoped.input, scoped.providers)).toMatchObject({
        status: 'handoff',
        reasons: ['evidence_missing'],
        wouldRelease: false
      })
      expect(scoped.generator.generate).not.toHaveBeenCalled()
      const expired = fixture()
      expired.generator.generate.mockImplementation(async () => {
        expired.setTime(12000)
        return { text: expired.p.evidence[0].content, evidenceIds: ['faq-A'] }
      })
      expired.p.evidence[0].expiresAt = 11000
      expired.bindPublication()
      expect(await executeJevReplayArm(arm, expired.input, expired.providers)).toMatchObject({
        status: 'invalid',
        reasons: ['evidence_expired'],
        wouldRelease: false
      })
    }
  })

  it('rejects missing or cross-account authenticated identities and altered frozen inputs before providers', async () => {
    for (const change of ['tenant', 'account', 'employee', 'platform', 'missing'] as const) {
      const f = fixture()
      if (change === 'tenant') f.input.identity.tenantId = 'other'
      if (change === 'account') f.input.identity.accountId = 'other'
      if (change === 'employee') f.input.identity.employeeId = 'other'
      if (change === 'platform') f.input.identity.platform = 'wechat'
      if (change === 'missing') Object.assign(f.input.frozen, { authenticatedScope: undefined })
      await expect(executeJevReplayArm('A', f.input, f.providers)).rejects.toThrow()
      expect(f.generator.generate).not.toHaveBeenCalled()
    }
    const changed = fixture()
    changed.item.inbound = ['替换案例']
    await expect(executeJevReplayArm('C', changed.input, changed.providers)).rejects.toThrow(
      'replay_case_changed_or_unplanned'
    )
    expect(changed.decision.evaluate).not.toHaveBeenCalled()
    const incomplete = fixture()
    incomplete.input.frozen.plan.assignments.pop()
    await expect(executeJevReplayArm('A', incomplete.input, incomplete.providers)).rejects.toThrow()
    expect(incomplete.generator.generate).not.toHaveBeenCalled()
    const labeled = fixture()
    Object.assign(labeled.item, { expectedAnswer: '客户自填标签不得进模型' })
    await expect(executeJevReplayArm('A', labeled.input, labeled.providers)).rejects.toThrow()
  })

  it('counts complete recorded HTTP usage including text and retries, while keeping fees explicitly unknown', async () => {
    const f = fixture()
    f.providers.readAttempts = async () => [
      attempt('pre'),
      attempt('text'),
      attempt('text', 'text-retry'),
      attempt('post')
    ]
    const result = await executeJevReplayArm('C', f.input, f.providers)
    expect(result).toMatchObject({
      usage: { inputTokens: 220, outputTokens: 110 },
      usageSource: 'recorded_http_attempts',
      billedCostMicros: null,
      releaseAuthorized: false
    })
    expect(result.attempts).toHaveLength(4)
  })

  it('does not call an incomplete C text-only ledger total usage or invent tokens for a failed attempt', async () => {
    const incomplete = fixture()
    incomplete.providers.readAttempts = async () => [attempt('text')]
    expect(await executeJevReplayArm('C', incomplete.input, incomplete.providers)).toMatchObject({
      usage: null,
      usageSource: 'unknown',
      reasons: ['usage_records_incomplete']
    })
    const unknown = fixture()
    unknown.providers.readAttempts = async () => [
      attempt('pre'),
      {
        ...attempt('text'),
        result: { outcome: 'error', durationMs: 1, failureCode: 'UNAVAILABLE' }
      },
      attempt('post')
    ]
    expect(await executeJevReplayArm('C', unknown.input, unknown.providers)).toMatchObject({
      usage: null,
      usageSource: 'unknown',
      reasons: ['usage_records_incomplete']
    })
    for (const wrong of ['duplicate', 'actual-model', 'question'] as const) {
      const f = fixture()
      const records = [attempt('pre'), attempt('text'), attempt('post')]
      if (wrong === 'duplicate') records[1].attemptId = records[0].attemptId
      if (wrong === 'actual-model') records[1].result!.actualModel = 'unfrozen-text-model'
      if (wrong === 'question') records[0].start.questionHash = 'b'.repeat(64)
      f.providers.readAttempts = async () => records
      expect(await executeJevReplayArm('C', f.input, f.providers)).toMatchObject({
        wouldRelease: false,
        status: 'invalid',
        usage: null,
        reasons: ['attempt_records_unavailable']
      })
    }
  })

  it('retains a reserved HTTP attempt with an unknown result and prevents treating the arm as complete', async () => {
    const f = fixture()
    f.providers.readAttempts = async () => [
      { ...attempt('pre'), result: null },
      attempt('text'),
      attempt('post')
    ]
    const result = await executeJevReplayArm('C', f.input, f.providers)
    expect(result).toMatchObject({
      status: 'invalid',
      wouldRelease: false,
      usage: null,
      usageSource: 'unknown',
      billedCostMicros: null
    })
    expect(result.attempts?.[0].result).toBeNull()
    expect(result.reasons).toEqual(['attempt_result_unknown', 'usage_records_incomplete'])
  })

  it('rejects cancellation and uncooperative model calls without triggering the next stage', async () => {
    const cancelled = fixture(),
      controller = new AbortController()
    controller.abort()
    expect(
      await executeJevReplayArm('C', cancelled.input, cancelled.providers, controller.signal)
    ).toMatchObject({ status: 'cancelled', wouldRelease: false })
    expect(cancelled.decision.evaluate).not.toHaveBeenCalled()
    vi.useFakeTimers()
    const hung = fixture()
    hung.p.policy.preBudgetMs = 10
    hung.bindPublication()
    hung.decision.evaluate.mockImplementation(() => new Promise(() => {}))
    const running = executeJevReplayArm('B', hung.input, hung.providers)
    await vi.advanceTimersByTimeAsync(10)
    expect(await running).toMatchObject({ status: 'invalid', wouldRelease: false })
    expect(hung.generator.generate).not.toHaveBeenCalled()
  })

  it('refuses incomplete batch splits and cross-scope identities before constructing providers', async () => {
    const f = fixture(),
      factory = vi.fn(() => f.providers)
    await expect(
      replayFrozenJevCases(
        {
          frozen: f.input.frozen,
          identity: f.input.identity,
          rawCases: {
            datasetId: f.input.frozen.plan.datasetId,
            split: 'calibration',
            cases: [f.item]
          }
        },
        factory,
        { textGeneratorVersion: f.p.textGeneratorVersion }
      )
    ).rejects.toThrow('replay_sample_incomplete')
    expect(factory).not.toHaveBeenCalled()
    f.input.identity.accountId = 'other'
    await expect(
      replayFrozenJevCases(
        { frozen: f.input.frozen, identity: f.input.identity, rawCases: {} },
        factory,
        { textGeneratorVersion: f.p.textGeneratorVersion }
      )
    ).rejects.toThrow('replay_identity_scope_mismatch')
    expect(factory).not.toHaveBeenCalled()
  })

  it('executes a complete frozen calibration split and retains each independent arm before returning', async () => {
    const f = fixture()
    const cases = f.input.frozen.plan.assignments
      .filter((a) => a.split === 'calibration')
      .map((a) => ({
        ...f.item,
        caseId: a.caseId,
        conversationGroup: a.conversationGroup
      }))
    for (const item of cases)
      f.input.frozen.plan.assignments.find((a) => a.caseId === item.caseId)!.inputHash =
        replayCaseInputHash(item)
    const factory = vi.fn(() => f.providers)
    const persisted = vi.fn(async () => {})
    const artifacts = await replayFrozenJevCases(
      {
        frozen: f.input.frozen,
        identity: f.input.identity,
        rawCases: { datasetId: f.input.frozen.plan.datasetId, split: 'calibration', cases }
      },
      factory,
      { textGeneratorVersion: f.p.textGeneratorVersion, onArm: persisted }
    )
    expect(artifacts).toHaveLength(300)
    expect(factory).toHaveBeenCalledTimes(300)
    expect(persisted).toHaveBeenCalledTimes(300)
    expect(f.generator.generate).toHaveBeenCalledTimes(300)
    expect(f.decision.evaluate).toHaveBeenCalledTimes(300)
    expect(artifacts.slice(0, 3).map((a) => a.arm)).toEqual(['A', 'B', 'C'])
    expect(
      artifacts.every(
        (a) => a.releaseAuthorized === false && a.usage === null && a.billedCostMicros === null
      )
    ).toBe(true)
  })
})
