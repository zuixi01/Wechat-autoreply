import { afterEach, describe, expect, it, vi } from 'vitest'
import { Ledger } from '../../src/core/persistence/ledger'
import { ReliableAgent } from '../../src/core/agent/reliable-agent'
import { ConversationCollector } from '../../src/core/agent/conversation-collector'
import { JevReplyPipeline, type DecisionPolicy } from '../../server/src/reply/jev-pipeline'
import type { JevRequest, JevResponse } from '../../src/shared/contracts/decision'
import type { Identity } from '../../src/shared/contracts/identity'
import { SyntheticCollectionSource } from '../fixtures/collection'
import { taskFixture } from '../fixtures/task'

const opened: { agent: ReliableAgent; collector: ConversationCollector; ledger: Ledger }[] = []
afterEach(async () => {
  for (const f of opened.splice(0)) {
    await f.collector.stop()
    await f.agent.pause()
    f.ledger.close()
  }
  vi.useRealTimers()
})

type Mode = 'approved' | 'human_requested' | 'audit_failed' | 'unknown_delivery'
async function fixture(platform: Identity['platform'], employee: string, mode: Mode = 'approved') {
  const f = taskFixture()
  const identity = { ...f.task.identity, platform, employeeId: employee, accountId: employee }
  const ledger = new Ledger(':memory:')
  const source = new SyntheticCollectionSource(identity, 1)
  source.add('customer-0', '支持离线阅读吗？')
  const events: string[] = []
  const evaluate = vi.fn(async (request: JevRequest): Promise<JevResponse> => {
    const post = 'supported' in request.questions
    events.push(post ? 'jev_review' : 'jev_decision')
    const answers: JevResponse['answers'] = {}
    for (const [id, question] of Object.entries(request.questions)) {
      if (question.type === 'choice') {
        answers[id] = {
          type: 'choice',
          choice: 'faq',
          confidence: 0.99,
          probabilities: { faq: 1, price: 0, order: 0, aftersales: 0, other: 0 }
        }
      } else {
        answers[id] = {
          type: 'noul',
          noul:
            id === 'human_requested'
              ? Number(mode === 'human_requested')
              : id.startsWith('has_')
                ? Number(id === 'has_faq')
                : Number(!(mode === 'audit_failed' && id === 'supported'))
        }
      }
    }
    return { model: 'jev-test-version', answers, usage: { input_tokens: 1, output_tokens: 1 } }
  })
  const generator = vi.fn(async () => {
    events.push('text_generation')
    return { text: '本产品支持离线阅读。', evidenceIds: ['faq-A'] }
  })
  const pipeline = new JevReplyPipeline({ evaluate }, { generate: generator })
  const policy: DecisionPolicy = {
    version: 'policy-1',
    questionSetVersion: 'questions-1',
    knowledgeVersion: 'knowledge-1',
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
  const dispatch = vi.fn(
    async (
      command: Parameters<
        import('../../src/core/sending/sender').VerifiedSendAdapter['dispatch']
      >[0]
    ) => {
      events.push('simulated_dispatch')
      if (mode === 'unknown_delivery') return { status: 'unknown' as const }
      return {
        status: 'confirmed' as const,
        executionId: command.executionId,
        identity: command.task.identity,
        conversationId: command.task.conversationId,
        draftHash: command.draft.draftHash,
        evidence: 'synthetic-echo-only'
      }
    }
  )
  const agent = new ReliableAgent(
    ledger,
    {
      readCurrent: async (task) => ({
        ...f.current,
        identity,
        conversationId: task.conversationId
      }),
      dispatch
    },
    {
      generate: async (task, inbound, isCurrent, signal, context) => {
        const result = await pipeline.run(
          {
            task,
            inbound,
            context,
            isCurrent,
            retrieval: 'lexical-v1',
            evidence: [
              {
                evidenceId: 'faq-A',
                tenantId: identity.tenantId,
                intent: 'faq',
                knowledgeVersion: 'knowledge-1',
                kind: 'approved_faq',
                content: '本产品支持离线阅读。',
                source: '合成产品手册',
                approvedBy: employee,
                validFrom: 0,
                expiresAt: 1000000
              }
            ]
          },
          policy,
          signal
        )
        return { ...result, task, factsVerified: result.factsVerified ?? false }
      }
    },
    {},
    { quietMs: 10, maximumWaitMs: 30 }
  )
  await agent.configure({
    configVersion: 'config-1',
    knowledgeVersion: 'knowledge-1',
    decisionPolicyVersion: 'policy-1',
    questionSetVersion: 'questions-1',
    modelResolved: 'jev-test-version',
    automaticEnabled: true
  })
  const collector = new ConversationCollector(
    ledger,
    identity,
    source,
    {
      onBindings: (bindings) => agent.discoverBindings(bindings),
      onPending: (binding) => agent.collectionPending(binding),
      onRead: (binding, messages, complete) => agent.collected(binding, messages, complete),
      onFailure: () => {
        throw new Error('synthetic_collection_failed')
      }
    },
    { pollMs: 10, sweepIntervalMs: 100 }
  )
  opened.push({ agent, collector, ledger })
  await collector.start(new AbortController().signal)
  agent.resume()
  return { identity, source, ledger, agent, collector, dispatch, evaluate, generator, events }
}

describe('offline private-chat mainline: collector → Jev → draft → review → sender', () => {
  it.each(['wechat', 'wework'] as const)(
    'keeps two %s employee accounts separate and sends each message once',
    async (platform) => {
      vi.useFakeTimers()
      vi.setSystemTime(10000)
      const a = await fixture(platform, 'employee-A')
      const b = await fixture(platform, 'employee-B')
      await vi.advanceTimersByTimeAsync(300)
      for (const f of [a, b]) {
        expect(f.events).toEqual([
          'jev_decision',
          'text_generation',
          'jev_review',
          'simulated_dispatch'
        ])
        expect(f.dispatch).toHaveBeenCalledTimes(1)
        expect(f.dispatch.mock.calls[0][0].task.identity).toEqual(f.identity)
        expect(f.dispatch.mock.calls[0][0].draft.text).toBe('本产品支持离线阅读。')
        expect(f.ledger.replies.list(f.identity)[0].status).toBe('sent')
        expect(f.ledger.snapshot(f.identity, 'customer-0').messages[0].handledBy).not.toBeNull()
      }
      // Both customers have the same source ID and conversation ID, in different accounts.
      a.source.emit('customer-0')
      b.source.emit('customer-0')
      await vi.advanceTimersByTimeAsync(300)
      expect(a.dispatch).toHaveBeenCalledTimes(1)
      expect(b.dispatch).toHaveBeenCalledTimes(1)
      expect(a.evaluate).toHaveBeenCalledTimes(2)
      expect(b.evaluate).toHaveBeenCalledTimes(2)
    }
  )

  it.each(['human_requested', 'audit_failed'] as const)(
    'keeps %s as an employee suggestion without dispatch',
    async (mode) => {
      vi.useFakeTimers()
      vi.setSystemTime(10000)
      const f = await fixture('wework', 'employee-A', mode)
      await vi.advanceTimersByTimeAsync(300)
      expect(f.dispatch).not.toHaveBeenCalled()
      expect(f.ledger.replies.list(f.identity)[0].status).toBe('needs_human')
      expect(f.evaluate).toHaveBeenCalledTimes(mode === 'human_requested' ? 1 : 2)
      expect(f.generator).toHaveBeenCalledTimes(mode === 'human_requested' ? 0 : 1)
      f.source.emit('customer-0')
      await vi.advanceTimersByTimeAsync(300)
      expect(f.evaluate).toHaveBeenCalledTimes(mode === 'human_requested' ? 1 : 2)
    }
  )

  it('cancels queued automation when the employee replies first', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10000)
    const f = await fixture('wechat', 'employee-A')
    f.source.add('customer-0', '我来跟进这个问题。', 'human_outbound')
    f.source.emit('customer-0')
    await vi.advanceTimersByTimeAsync(300)
    expect(f.ledger.snapshot(f.identity, 'customer-0').humanOwned).toBe(true)
    expect(f.dispatch).not.toHaveBeenCalled()
    expect(f.generator).not.toHaveBeenCalled()
  })

  it('never replays an unknown delivery after a reread or a new customer question', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10000)
    const f = await fixture('wework', 'employee-A', 'unknown_delivery')
    await vi.advanceTimersByTimeAsync(300)
    expect(f.dispatch).toHaveBeenCalledTimes(1)
    expect(f.ledger.hasUnknown(f.identity, 'customer-0')).toBe(true)
    f.source.add('customer-0', '请问还在吗？')
    f.source.emit('customer-0')
    await vi.advanceTimersByTimeAsync(300)
    expect(f.dispatch).toHaveBeenCalledTimes(1)
    expect(f.ledger.hasUnknown(f.identity, 'customer-0')).toBe(true)
  })
})
