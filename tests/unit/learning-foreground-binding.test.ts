import { describe, expect, it, vi } from 'vitest'
import {
  parseForegroundEvaluationInput,
  foregroundHostOperation
} from '../../server/src/learning/learning-foreground-binding'
import { taskFixture } from '../fixtures/task'
import { hashContext } from '../../src/core/reply/hashes'
import type { Publication } from '../../server/src/generation/publication'

// Minimal synthetic publication projection; the collector uses a fully validated DB publication.
function fixture() {
  const f = taskFixture()
  const scope = {
    tenant_id: f.task.identity.tenantId,
    employee_id: f.task.identity.employeeId,
    account_id: f.task.identity.accountId,
    agent_id: f.task.identity.agentId,
    platform: f.task.identity.platform as 'wework'
  }
  const context = [
    {
      sequence: 5,
      sourceMessageId: 'synthetic-source',
      direction: 'inbound' as const,
      kind: 'text' as const,
      text: '合成询价'
    }
  ]
  const input = {
    task: { ...f.task, inboundRange: { from: 5, to: 5 }, contextHash: hashContext(context) },
    context,
    inbound: ['合成询价']
  }
  const publication = {
    configuration: {
      configVersion: f.task.configVersion,
      knowledgeVersion: f.task.knowledgeVersion
    },
    policy: { version: f.task.decisionPolicyVersion, questionSetVersion: f.task.questionSetVersion }
  } as Publication
  const item = {
    caseId: 'synthetic-case',
    conversationId: f.task.conversationId,
    category: 'inquiry' as const,
    inbound: input.inbound
  }
  return { scope, publication, item, input, now: f.now }
}

describe('frozen foreground generation input and bounded host rendezvous', () => {
  it('accepts current bound input while preserving actual source IDs and sequence', () => {
    const f = fixture()
    const parsed = parseForegroundEvaluationInput(f.input, f.scope, f.publication, f.item, f.now)
    expect(parsed.context[0].sourceMessageId).toBe('synthetic-source')
    expect(parsed.task.inboundRange).toEqual({ from: 5, to: 5 })
    parsed.inbound[0] = 'changed copy'
    expect(f.input.inbound).toEqual(['合成询价'])
  })
  it.each(['tenantId', 'employeeId', 'accountId', 'agentId', 'platform'] as const)(
    'refuses a foreign %s even with a self-consistent body hash',
    (key) => {
      const f = fixture()
      Object.assign(f.input.task.identity, { [key]: key === 'platform' ? 'wechat' : 'foreign' })
      expect(() =>
        parseForegroundEvaluationInput(f.input, f.scope, f.publication, f.item, f.now)
      ).toThrow('evaluation_foreground_input_conflict')
    }
  )
  it.each([
    'conversationId',
    'configVersion',
    'knowledgeVersion',
    'decisionPolicyVersion',
    'questionSetVersion'
  ] as const)('refuses changed %s', (key) => {
    const f = fixture()
    f.input.task[key] = 'changed'
    expect(() =>
      parseForegroundEvaluationInput(f.input, f.scope, f.publication, f.item, f.now)
    ).toThrow('evaluation_foreground_input_conflict')
  })
  it('refuses future, expired, arbitrary learning claims and changed frozen inbound before any model operation', () => {
    for (const [change, reason] of [
      [{ createdAt: 10001 }, 'evaluation_foreground_input_conflict'],
      [{ expiresAt: 10000 }, 'evaluation_foreground_input_conflict'],
      [{ memoryCorpusVersion: 'claim' }, 'incomplete_learning_binding'],
      [{ learningContextVersion: 'claim' }, 'incomplete_learning_binding'],
      [{ memorySnapshotHash: 'a'.repeat(64) }, 'incomplete_learning_binding']
    ] as const) {
      const f = fixture()
      Object.assign(f.input.task, change)
      expect(() =>
        parseForegroundEvaluationInput(f.input, f.scope, f.publication, f.item, f.now)
      ).toThrow(reason)
    }
    const f = fixture()
    f.input.context[0].text = '改变冻结问题'
    f.input.inbound[0] = f.input.context[0].text
    f.input.task.contextHash = hashContext(f.input.context)
    expect(() =>
      parseForegroundEvaluationInput(
        f.input,
        f.scope,
        f.publication,
        { ...f.item, inbound: ['合成询价'] },
        f.now
      )
    ).toThrow('evaluation_foreground_input_conflict')
  })
  it('rejects extra history when none was frozen and rejects replacement of explicitly frozen source metadata', () => {
    const f = fixture()
    const extra = {
      ...f.input.context[0],
      sequence: 4,
      sourceMessageId: 'synthetic-history',
      text: '未冻结的历史'
    }
    f.input.context.unshift(extra)
    f.input.task.contextHash = hashContext(f.input.context)
    expect(() =>
      parseForegroundEvaluationInput(f.input, f.scope, f.publication, f.item, f.now)
    ).toThrow('evaluation_foreground_context_conflict')
    const g = fixture(),
      frozenContext = structuredClone(g.input.context)
    g.input.context[0].sourceMessageId = 'replacement'
    g.input.task.contextHash = hashContext(g.input.context)
    expect(() =>
      parseForegroundEvaluationInput(
        g.input,
        g.scope,
        g.publication,
        { ...g.item, context: frozenContext },
        g.now
      )
    ).toThrow('evaluation_foreground_context_conflict')
  })
  it('does not run an already cancelled host operation, including cancellation before the scheduled microtask', async () => {
    const controller = new AbortController(),
      callback = vi.fn(async () => 1)
    controller.abort()
    await expect(foregroundHostOperation(callback, controller.signal, 30)).rejects.toThrow(
      'evaluation_cancelled'
    )
    expect(callback).not.toHaveBeenCalled()
    const second = new AbortController()
    const work = foregroundHostOperation(callback, second.signal, 30)
    second.abort()
    await expect(work).rejects.toThrow('evaluation_cancelled')
    expect(callback).not.toHaveBeenCalled()
  })
  it('bounds a stalled callback and handles its late rejection without leaking timers', async () => {
    vi.useFakeTimers()
    try {
      let reject: (reason: Error) => void = () => {}
      const work = foregroundHostOperation(
        () =>
          new Promise((_resolve, failed) => {
            reject = failed
          }),
        new AbortController().signal,
        30
      )
      const failure = expect(work).rejects.toThrow('evaluation_foreground_timeout')
      await vi.advanceTimersByTimeAsync(31)
      await failure
      reject(new Error('synthetic late rejection'))
      await Promise.resolve()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
