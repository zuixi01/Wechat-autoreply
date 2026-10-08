import { afterEach, describe, expect, it } from 'vitest'
import { LearningStore } from '../../src/core/memory/learning-store'
import { LearningService } from '../../src/main/services/learning-service'
import { LearningFeedbackCollector } from '../../src/core/memory/learning-feedback'
import type { LearningFeedback, MemoryScope } from '../../src/shared/contracts/learning-memory'
import type { ProviderInput } from '../../src/core/session-types'
import { retrieveLearningContext } from '../../src/core/memory/learning-context'

const stores: LearningStore[] = []
afterEach(() => stores.splice(0).forEach((store) => store.close()))
const scope: MemoryScope = { workspaceId: 'profile', platform: 'wechat', conversationId: 'object' }
const input: ProviderInput = {
  screenshot: '',
  appType: 'wechat',
  extractedText: '设备报价数量',
  learningGenerationId: 'g1',
  learningProblemId: 'p1'
}
function setup() {
  const store = new LearningStore(':memory:', () => 1000)
  stores.push(store)
  const service = new LearningService(
    store,
    { review: async () => ({ operations: [], usage: { inputTokens: 1, outputTokens: 1 } }) },
    { workspaceId: 'profile', now: () => 1000 }
  )
  const evidence = store.recordEpisode(scope, {
    sourceId: 'evidence',
    topic: '设备报价',
    startedAt: 0,
    messages: [],
    outcome: 'corrected'
  })
  const method = store.propose(scope, {
    source: 'human',
    reason: '确认需求',
    evidence: [{ episodeId: evidence.id }],
    content: {
      kind: 'lesson',
      scenario: '设备报价数量',
      guidance: '先询问型号和数量',
      rationale: '',
      steps: [],
      pitfalls: [],
      verification: []
    }
  })
  store.activate(scope, method.id, 1)
  const context = retrieveLearningContext(store, scope, '设备报价数量')
  const episode = service.onDraft(input, context, '请问型号数量？', scope)
  return { store, service, episode, method, collector: new LearningFeedbackCollector(store) }
}
function feedback(
  episodeId: string,
  memoryId: string,
  kind: LearningFeedback['kind'],
  sourceId: string = kind
): LearningFeedback {
  return { sourceId, episodeId, kind, at: 1000, memoryRefs: [{ id: memoryId, revision: 1 }] }
}
describe('feedback from recorded usage and human actions', () => {
  it('a draft is unknown and does not queue a completed problem', () => {
    const { store, episode } = setup()
    expect(episode.outcome).toBe('unknown')
    expect(store.jobs.list(scope)).toEqual([])
  })
  it('delivery confirmation never counts as human adoption or resolution', () => {
    const { store, collector, episode, method } = setup()
    collector.record(scope, feedback(episode.id, method.id, 'delivery_confirmed'))
    expect(store.metrics(scope, method.id)).toMatchObject({
      loaded: 1,
      adopted: 0,
      delivery_confirmed: 1
    })
    expect(store.episode(scope, episode.id).outcome).toBe('unknown')
    expect(store.jobs.list(scope)).toEqual([])
    collector.record(scope, feedback(episode.id, method.id, 'adopted'))
    expect(store.metrics(scope, method.id).adopted).toBe(1)
  })
  it('rejects adoption or failure references that were not loaded for that saved generation', () => {
    const { collector, episode, method } = setup()
    expect(() =>
      collector.record(scope, {
        ...feedback(episode.id, method.id, 'adopted'),
        memoryRefs: [{ id: method.id, revision: 2 }]
      })
    ).toThrow('feedback_usage_mismatch')
    expect(() =>
      collector.record(scope, { ...feedback(episode.id, method.id, 'fact_error'), memoryRefs: [] })
    ).toThrow('feedback_usage_mismatch')
    expect(() =>
      collector.record(
        { ...scope, conversationId: 'b' },
        feedback(episode.id, method.id, 'adopted')
      )
    ).toThrow()
  })
  it('two independent quality failures for one problem trigger review once; retries and delivery failures do not', () => {
    const { store, service, collector, episode, method } = setup()
    const one = feedback(episode.id, method.id, 'repeated_question', 'failure-1')
    collector.record(scope, one)
    collector.record(scope, one)
    expect(store.jobs.list(scope)).toEqual([])
    const context = retrieveLearningContext(store, scope, '设备报价数量')
    const second = service.onDraft(
      { ...input, learningGenerationId: 'g2' },
      context,
      '请问型号数量？',
      scope
    )
    const two = feedback(second.id, method.id, 'repeated_question', 'failure-2')
    collector.record(scope, two)
    collector.record(scope, two)
    expect(store.jobs.list(scope)).toHaveLength(1)
    expect(store.jobs.list(scope)[0].triggers).toEqual(['repeated_failure'])
    expect(store.jobs.list(scope)[0].episodeIds.sort()).toEqual([episode.id, second.id].sort())
  })
  it('quality failures in different problems are not combined', () => {
    const { store, service, collector, episode, method } = setup()
    collector.record(scope, feedback(episode.id, method.id, 'repeated_question', 'f1'))
    const second = service.onDraft(
      { ...input, learningGenerationId: 'g2', learningProblemId: 'p2' },
      retrieveLearningContext(store, scope, '设备报价数量'),
      '回复',
      scope
    )
    collector.record(scope, feedback(second.id, method.id, 'repeated_question', 'f2'))
    expect(store.jobs.list(scope)).toEqual([])
  })
  it('a human correction closes the whole problem atomically and is idempotent', () => {
    const { store, service, episode, method } = setup()
    const second = service.onDraft(
      { ...input, learningGenerationId: 'g2', extractedText: '设备报价型号是什么？' },
      retrieveLearningContext(store, scope, '设备报价数量'),
      '型号是什么？',
      scope
    )
    const correction = {
      sourceId: 'edit-final',
      text: '请提供型号、数量和使用场景。',
      reason: '一次问全需求'
    }
    const changed = service.correct(scope, second.id, correction)
    expect(changed.messages).toHaveLength(4)
    expect(changed).toMatchObject({
      correction: correction.text,
      correctionReason: correction.reason,
      outcome: 'corrected'
    })
    expect(service.correct(scope, second.id, correction).id).toBe(changed.id)
    expect(store.jobs.list(scope)).toHaveLength(1)
    expect(store.jobs.list(scope)[0].episodeIds).toEqual([changed.id])
    expect(store.metrics(scope, method.id)).toMatchObject({ loaded: 2, substantially_corrected: 1 })
    expect(store.episode(scope, episode.id).outcome).toBe('unknown')
    expect(() => service.correct(scope, second.id, { ...correction, text: '悄悄改变' })).toThrow(
      'episode_event_conflict'
    )
    const another = service.correct(scope, second.id, {
      ...correction,
      sourceId: 'edit-again',
      text: '再次调整'
    })
    expect(another.id).not.toBe(changed.id)
  })
  it('a correction after idle closure remains possible and preserves the whole conversation', () => {
    const { store, service, episode } = setup()
    store.assembler.flushIdle(1801000)
    const changed = service.correct(scope, episode.id, {
      sourceId: 'after-idle',
      text: '纠正的回复',
      reason: '补充需求'
    })
    expect(changed.messages).toHaveLength(2)
    expect(changed.outcome).toBe('corrected')
    expect(store.jobs.list(scope)[0].triggers).toEqual(['correction'])
  })
  it('an employee-confirmed outcome is distinct from draft, delivery and adoption', () => {
    const { store, service, episode, method } = setup()
    const resultInput = {
      sourceId: 'customer-result',
      outcome: 'resolved' as const,
      reason: '员工已核实客户需求得到解决'
    }
    const result = service.confirmResult(scope, episode.id, resultInput)
    expect(result.outcome).toBe('resolved')
    expect(service.confirmResult(scope, episode.id, resultInput).id).toBe(result.id)
    expect(store.metrics(scope, method.id)).toMatchObject({
      loaded: 1,
      adopted: 0,
      delivery_confirmed: 0,
      outcome_confirmed: 1
    })
    expect(store.jobs.list(scope)[0].episodeIds).toEqual([result.id])
    expect(() =>
      service.confirmResult(scope, episode.id, { ...resultInput, reason: '更换同一来源的结果' })
    ).toThrow('feedback_source_conflict')
  })
  it('human feedback derives references and is idempotent across a later timestamp', () => {
    const { store, service, episode, method } = setup()
    const event = {
      sourceId: 'employee-adopts',
      kind: 'adopted' as const,
      reason: '我确认采用了此方法'
    }
    service.humanFeedback(scope, episode.id, event)
    service.humanFeedback(scope, episode.id, event)
    expect(store.metrics(scope, method.id).adopted).toBe(1)
    expect(() =>
      service.humanFeedback(scope, episode.id, { ...event, kind: 'fact_error' })
    ).toThrow('feedback_source_conflict')
  })
})
