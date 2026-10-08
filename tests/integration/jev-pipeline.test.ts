import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  JevReplyPipeline,
  type DecisionPolicy,
  type KnowledgeEvidence,
  type DraftGenerator
} from '../../server/src/reply/jev-pipeline'
import type { JevRequest, JevResponse } from '../../src/shared/contracts/decision'
import { taskFixture } from '../fixtures/task'

function response(request: JevRequest, extras: Record<string, unknown> = {}): JevResponse {
  const answers: JevResponse['answers'] = {}
  for (const [id, question] of Object.entries(request.questions)) {
    if (question.type === 'choice')
      answers[id] = {
        type: 'choice',
        choice: 'faq',
        confidence: 0.99,
        probabilities: { faq: 1, price: 0, order: 0, aftersales: 0, other: 0 }
      }
    else
      answers[id] = {
        type: 'noul',
        noul: id === 'human_requested' || (id.startsWith('has_') && id !== 'has_faq') ? 0 : 1
      }
  }
  return {
    model: 'jev-test-version',
    answers,
    usage: { input_tokens: 10, output_tokens: 5 },
    ...extras
  } as JevResponse
}
function fixture() {
  const f = taskFixture()
  let current = true
  let now = f.now
  const policy: DecisionPolicy = {
    version: f.task.decisionPolicyVersion,
    questionSetVersion: f.task.questionSetVersion,
    knowledgeVersion: f.task.knowledgeVersion,
    mode: 'enforced',
    modelAlias: 'jev-latest',
    modelResolved: 'jev-test-version',
    evaluationApproved: true,
    automaticIntents: ['faq'],
    minimumChoiceProbability: 0.9,
    minimumChoiceConfidence: 0.8,
    minimumChoiceMargin: 0.3,
    presentIntentProbability: 0.9,
    humanRequestThreshold: 0.2,
    minimumAuditProbability: 0.95,
    reviewValidityMs: 5000,
    preBudgetMs: 2000,
    postBudgetMs: 2000
  }
  const evidence: KnowledgeEvidence = {
    evidenceId: 'faq-A',
    tenantId: 'company',
    intent: 'faq',
    knowledgeVersion: f.task.knowledgeVersion,
    kind: 'approved_faq',
    content: '本产品支持离线阅读。',
    source: '审核后的产品手册 v1',
    approvedBy: 'employee-A',
    validFrom: 5000,
    expiresAt: 25000
  }
  const evaluate = vi.fn(async (request: JevRequest) => response(request))
  const generator: DraftGenerator = {
    generate: vi.fn(async () => ({ text: evidence.content, evidenceIds: [evidence.evidenceId] }))
  }
  const pipeline = new JevReplyPipeline({ evaluate }, generator, () => now)
  const context = {
    task: f.task,
    inbound: ['支持离线阅读吗？'],
    evidence: [evidence],
    isCurrent: () => current
  }
  return {
    ...f,
    policy,
    evidence,
    evaluate,
    generator,
    pipeline,
    context,
    invalidate: () => {
      current = false
    },
    setTime: (value: number) => {
      now = value
    }
  }
}
afterEach(() => vi.useRealTimers())
describe('Jev predecision and final-draft review', () => {
  it('retrieves knowledge for a follow-up using bounded conversation context', async () => {
    const f = fixture()
    const evidence = { ...f.evidence, content: '企业套餐支持五十名员工使用。' }
    vi.mocked(f.generator.generate).mockResolvedValue({
      text: evidence.content,
      evidenceIds: [evidence.evidenceId]
    })
    const result = await f.pipeline.run(
      {
        ...f.context,
        inbound: ['那这个呢？'],
        context: [
          {
            sequence: 1,
            sourceMessageId: 'prior',
            direction: 'inbound',
            kind: 'text',
            text: '企业套餐支持多少员工？'
          }
        ],
        evidence: [evidence],
        retrieval: 'lexical-v1'
      },
      f.policy
    )
    expect(result.status).toBe('candidate')
    expect(f.generator.generate).toHaveBeenCalled()
  })
  it('retrieves matching published knowledge and passes trusted reply rules to generation', async () => {
    const f = fixture()
    const result = await f.pipeline.run(
      {
        ...f.context,
        retrieval: 'lexical-v1',
        replyRules: '回复简洁',
        evidence: [
          f.evidence,
          { ...f.evidence, evidenceId: 'unrelated', content: '财务发票办理流程。' }
        ]
      },
      f.policy
    )
    expect(result.status).toBe('candidate')
    expect(f.generator.generate).toHaveBeenCalledWith(
      expect.objectContaining({ replyRules: '回复简洁', evidence: [f.evidence] }),
      expect.any(AbortSignal)
    )
  })
  it('does not generate when published documents are unrelated to the question', async () => {
    const f = fixture()
    const result = await f.pipeline.run(
      {
        ...f.context,
        retrieval: 'lexical-v1',
        evidence: [{ ...f.evidence, content: '财务发票办理流程。' }]
      },
      f.policy
    )
    expect(result).toMatchObject({ status: 'handoff', automaticAllowed: false })
    expect(f.generator.generate).not.toHaveBeenCalled()
  })
  it('reassesses the exact edited revision without generating replacement text or automatic authority', async () => {
    const f = fixture()
    const original = await f.pipeline.run(f.context, f.policy)
    f.evaluate.mockClear()
    vi.mocked(f.generator.generate).mockClear()
    const edited = await f.pipeline.reviewEdited(f.context, f.policy, {
      text: f.evidence.content,
      draftRevision: 2,
      evidenceIds: ['faq-A']
    })
    expect(edited).toMatchObject({
      status: 'candidate',
      automaticAllowed: false,
      factsVerified: true,
      draft: { text: f.evidence.content, draftRevision: 2 },
      review: { status: 'passed', draftRevision: 2 }
    })
    expect(edited.review?.reviewId).not.toBe(original.review?.reviewId)
    expect(f.generator.generate).not.toHaveBeenCalled()
    expect(f.evaluate).toHaveBeenCalledTimes(2)
    expect(f.evaluate.mock.calls[1][0].state).toMatchObject({ final_draft: f.evidence.content })
  })
  it('does not reuse a passing audit after an employee invents a discount', async () => {
    const f = fixture()
    await f.pipeline.run(f.context, f.policy)
    const result = await f.pipeline.reviewEdited(f.context, f.policy, {
      text: '今天免费，再退您100元。',
      draftRevision: 2,
      evidenceIds: ['faq-A']
    })
    expect(result).toMatchObject({
      automaticAllowed: false,
      factsVerified: false,
      reasons: ['freeform_requires_human'],
      review: { status: 'needs_human', draftRevision: 2 }
    })
    expect(f.evaluate.mock.calls[3][0].state).toMatchObject({
      final_draft: '今天免费，再退您100元。'
    })
  })
  it('rejects invalid edit revisions and duplicate sources before invoking any provider', async () => {
    const f = fixture()
    for (const edit of [
      { text: f.evidence.content, draftRevision: 1, evidenceIds: ['faq-A'] },
      { text: f.evidence.content, draftRevision: 2, evidenceIds: ['faq-A', 'faq-A'] }
    ])
      expect(await f.pipeline.reviewEdited(f.context, f.policy, edit)).toMatchObject({
        status: 'invalid',
        reasons: ['invalid_contract'],
        automaticAllowed: false
      })
    expect(f.evaluate).not.toHaveBeenCalled()
  })
  it('discards edited review if context changes during the post-audit', async () => {
    const f = fixture()
    f.evaluate.mockImplementation(async (request) => {
      if (request.questions.supported) f.invalidate()
      return response(request)
    })
    expect(
      await f.pipeline.reviewEdited(f.context, f.policy, {
        text: f.evidence.content,
        draftRevision: 2,
        evidenceIds: ['faq-A']
      })
    ).toMatchObject({ status: 'cancelled', automaticAllowed: false, reasons: ['task_obsolete'] })
    expect(f.generator.generate).not.toHaveBeenCalled()
  })
  it('reviews the actual final draft against facts obtained after predecision', async () => {
    const f = fixture()
    const result = await f.pipeline.run(f.context, f.policy)
    expect(result).toMatchObject({
      status: 'candidate',
      automaticAllowed: true,
      factsVerified: true,
      review: { status: 'passed', modelResolved: 'jev-test-version' },
      usage: { input_tokens: 20, output_tokens: 10 }
    })
    const [pre, post] = f.evaluate.mock.calls.map(([request]) => request)
    expect(pre.state).toEqual({ untrusted_inbound: ['支持离线阅读吗？'] })
    expect(post.state).toMatchObject({
      final_draft: '本产品支持离线阅读。',
      trusted_evidence: [{ evidenceId: 'faq-A' }]
    })
    expect(Object.keys(post.questions)).toHaveLength(5)
    expect(result.review?.expiresAt).toBe(15000)
  })
  it.each(['shadow', 'unapproved'] as const)(
    'never allows automatic send when %s',
    async (mode) => {
      const f = fixture()
      if (mode === 'shadow') f.policy.mode = 'shadow'
      else f.policy.evaluationApproved = false
      expect(await f.pipeline.run(f.context, f.policy)).toMatchObject({
        automaticAllowed: false,
        review: { status: 'needs_human' }
      })
    }
  )
  it('honors explicit human requests before making any model call', async () => {
    const f = fixture()
    f.context.inbound = ['请转人工处理']
    expect(await f.pipeline.run(f.context, f.policy)).toMatchObject({
      status: 'handoff',
      reasons: ['explicit_human_request']
    })
    expect(f.evaluate).not.toHaveBeenCalled()
    expect(f.generator.generate).not.toHaveBeenCalled()
  })
  it.each(['tenant', 'account', 'customer', 'expired', 'version'] as const)(
    'rejects %s evidence',
    async (change) => {
      const f = fixture()
      if (change === 'tenant') f.evidence.tenantId = 'company-B'
      if (change === 'account') f.evidence.accountId = 'account-B'
      if (change === 'customer') {
        f.evidence.accountId = 'account-A'
        f.evidence.conversationId = 'customer-B'
      }
      if (change === 'expired') f.evidence.expiresAt = 9999
      if (change === 'version') f.evidence.knowledgeVersion = 'unpublished'
      expect(await f.pipeline.run(f.context, f.policy)).toMatchObject({
        automaticAllowed: false,
        reasons: ['evidence_missing']
      })
      expect(f.generator.generate).not.toHaveBeenCalled()
    }
  )
  it('rejects a model alias that resolves to a different version', async () => {
    const f = fixture()
    f.evaluate.mockImplementation(async (request) =>
      response(request, { model: 'jev-new-version' })
    )
    expect(await f.pipeline.run(f.context, f.policy)).toMatchObject({
      status: 'invalid',
      reasons: ['model_drift']
    })
    expect(f.generator.generate).not.toHaveBeenCalled()
  })
  it('rejects model drift between predecision and postreview', async () => {
    const f = fixture()
    f.evaluate
      .mockImplementationOnce(async (request) => response(request))
      .mockImplementationOnce(async (request) => response(request, { model: 'jev-new-version' }))
    expect(await f.pipeline.run(f.context, f.policy)).toMatchObject({
      status: 'invalid',
      reasons: ['model_drift']
    })
  })
  it('does not let a high primary score conceal a second unsupported request', async () => {
    const f = fixture()
    f.context.inbound = ['支持离线吗，另外我要退货']
    f.evaluate.mockImplementation(async (request) => {
      const r = response(request)
      r.answers.has_aftersales = { type: 'noul', noul: 0.98 }
      return r
    })
    expect(await f.pipeline.run(f.context, f.policy)).toMatchObject({
      status: 'handoff',
      reasons: ['intent_outside_scope'],
      intents: ['faq', 'aftersales']
    })
  })
  it('does not discard uncertain secondary requests', async () => {
    const f = fixture()
    f.evaluate.mockImplementation(async (request) => {
      const r = response(request)
      r.answers.has_price = { type: 'noul', noul: 0.5 }
      return r
    })
    expect(await f.pipeline.run(f.context, f.policy)).toMatchObject({
      reasons: ['secondary_intent_uncertain']
    })
  })
  it('invalidates the whole batch if an answer is absent', async () => {
    const f = fixture()
    f.evaluate.mockImplementation(async (request) => {
      const r = response(request)
      delete r.answers.human_requested
      return r
    })
    expect(await f.pipeline.run(f.context, f.policy)).toMatchObject({
      status: 'invalid',
      automaticAllowed: false
    })
  })
  it('does not bypass review on provider failure', async () => {
    const f = fixture()
    f.evaluate.mockRejectedValue(new Error('contains unsafe upstream text'))
    expect(await f.pipeline.run(f.context, f.policy)).toMatchObject({
      status: 'invalid',
      reasons: ['decision_or_generation_failed']
    })
  })
  it('discards a late generation when the coordinator invalidates the task', async () => {
    const f = fixture()
    f.generator.generate = vi.fn(async () => {
      f.invalidate()
      return { text: f.evidence.content, evidenceIds: [f.evidence.evidenceId] }
    })
    expect(await f.pipeline.run(f.context, f.policy)).toMatchObject({
      status: 'cancelled',
      automaticAllowed: false
    })
    expect(f.evaluate).toHaveBeenCalledTimes(1)
  })
  it('requires human review for invented business facts even when Jev gives all high probabilities', async () => {
    const f = fixture()
    f.generator.generate = vi.fn(async () => ({
      text: '退款已到账，我们再给你减免 100 元。',
      evidenceIds: ['faq-A']
    }))
    expect(await f.pipeline.run(f.context, f.policy)).toMatchObject({
      automaticAllowed: false,
      factsVerified: false,
      reasons: ['freeform_requires_human'],
      review: { status: 'needs_human' }
    })
  })
  it('rejects references to facts that were not supplied in this customer scope', async () => {
    const f = fixture()
    f.generator.generate = vi.fn(async () => ({
      text: '他人的订单已退款',
      evidenceIds: ['private-B']
    }))
    expect(await f.pipeline.run(f.context, f.policy)).toMatchObject({
      status: 'invalid',
      reasons: ['evidence_reference_invalid']
    })
    expect(f.evaluate).toHaveBeenCalledTimes(1)
  })
  it('fails one required audit rather than averaging it with the other high results', async () => {
    const f = fixture()
    f.evaluate.mockImplementation(async (request) => {
      const r = response(request)
      if (r.answers.covers_requests) r.answers.covers_requests = { type: 'noul', noul: 0.5 }
      return r
    })
    expect(await f.pipeline.run(f.context, f.policy)).toMatchObject({
      automaticAllowed: false,
      reasons: ['audit_covers_requests']
    })
  })
  it('expires the review no later than its verified evidence', async () => {
    const f = fixture()
    f.evidence.expiresAt = 11000
    expect((await f.pipeline.run(f.context, f.policy)).review?.expiresAt).toBe(11000)
  })
  it('rejects cancellation before entering the provider', async () => {
    const f = fixture()
    const controller = new AbortController()
    controller.abort()
    expect(await f.pipeline.run(f.context, f.policy, controller.signal)).toMatchObject({
      status: 'cancelled'
    })
    expect(f.evaluate).not.toHaveBeenCalled()
  })
  it('enforces the stage budget even if a provider ignores the deadline and abort signal', async () => {
    vi.useFakeTimers()
    const f = fixture()
    let resolve!: (value: JevResponse) => void
    let request!: JevRequest
    f.evaluate.mockImplementation(async (r) => {
      request = r
      return new Promise<JevResponse>((done) => {
        resolve = done
      })
    })
    const running = f.pipeline.run(f.context, f.policy)
    await vi.advanceTimersByTimeAsync(f.policy.preBudgetMs)
    expect(await running).toMatchObject({ status: 'invalid', automaticAllowed: false })
    resolve(response(request))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.generator.generate).not.toHaveBeenCalled()
  })
})
