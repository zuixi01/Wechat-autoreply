import { afterEach, describe, expect, it, vi } from 'vitest'
import { LearningKnowledgeAnswers } from '../../src/main/services/learning-knowledge'
import { LearningService } from '../../src/main/services/learning-service'
import { LearningStore } from '../../src/core/memory/learning-store'
import { KnowledgeStore } from '../../src/core/knowledge/knowledge-store'
import { KnowledgeReplyService } from '../../src/core/knowledge/knowledge-reply'
const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach((close) => close()))
function setup() {
  const store = new LearningStore(':memory:'),
    knowledge = new KnowledgeStore(':memory:')
  cleanup.push(
    () => store.close(),
    () => knowledge.close()
  )
  knowledge.finish(
    knowledge.begin('设备资料', 'txt', '产品').id,
    '设备报价需要确认型号和数量，X型号价格为100元。'
  )
  const service = new LearningService(
    store,
    { review: async () => ({ operations: [], usage: { inputTokens: 10, outputTokens: 10 } }) },
    { workspaceId: 'profile' }
  )
  const scope = { ...service.accountScope('generic'), conversationId: 'explicit-object-id' }
  const episode = store.recordEpisode(scope, {
    sourceId: 'method',
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
    reason: '员工教导',
    source: 'human'
  })
  store.activate(scope, memory.id, 1)
  return {
    store,
    service,
    scope,
    memory,
    answers: new LearningKnowledgeAnswers(new KnowledgeReplyService(knowledge), service)
  }
}
describe('learning in the actual knowledge answer product flow', () => {
  it('loads scoped methods and records an unknown trial without claiming a completed problem', async () => {
    const { answers, scope, store, memory } = setup()
    let prompt = ''
    const result = await answers.answer(
      '设备报价',
      '回复简短',
      async (system) => {
        prompt = system
        return '请问型号和数量？'
      },
      scope
    )
    expect(prompt).toContain('回复简短')
    expect(prompt).toContain('先问型号和数量')
    expect(prompt).toContain('知识依据')
    expect(result.learning?.memoryRefs).toEqual([{ id: memory.id, revision: 1 }])
    expect(store.episodes(scope).some((episode) => episode.id === result.learning?.episodeId)).toBe(
      true
    )
    expect(store.jobs.list(scope)).toHaveLength(0)
    expect(store.metrics(scope, memory.id)).toMatchObject({
      loaded: 1,
      adopted: 0,
      delivery_confirmed: 0
    })
  })
  it('rejects results when memory changes during generation', async () => {
    const { answers, scope, store, memory } = setup()
    await expect(
      answers.answer(
        '设备报价',
        '',
        async () => {
          store.archive(scope, memory.id, 1, 'human')
          return '旧方法回复'
        },
        scope
      )
    ).rejects.toThrow('工作记忆已更新')
    expect(store.jobs.list(scope)).toEqual([])
  })
  it('unknown customer questions stay unassigned and cannot load personal methods', async () => {
    const { answers, store, scope } = setup()
    let prompt = ''
    const result = await answers.answer('设备报价', '', async (system) => {
      prompt = system
      return '回复'
    })
    expect(prompt).not.toContain('先问型号和数量')
    expect(result.learning?.scope.conversationId).toContain('unassigned:')
    expect(store.episodes(result.learning!.scope)[0].identityStatus).toBe('unassigned')
    expect(store.jobs.list(scope)).toEqual([])
  })
  it('an unavailable memory store and failing diagnostic cannot block the knowledge answer', async () => {
    const { service, store, scope } = setup()
    const knowledge = new KnowledgeStore(':memory:')
    cleanup.push(() => knowledge.close())
    knowledge.finish(knowledge.begin('设备资料', 'txt', '产品').id, '设备报价需要确认型号和数量。')
    vi.spyOn(store, 'retrieve').mockImplementation(() => {
      throw new Error('sqlite unavailable')
    })
    const answers = new LearningKnowledgeAnswers(
      new KnowledgeReplyService(knowledge),
      service,
      () => {
        throw new Error('diagnostic unavailable')
      }
    )
    const result = await answers.answer(
      '设备报价',
      '简短回复',
      async () => '请问型号和数量？',
      scope
    )
    expect(result.text).toBe('请问型号和数量？')
    expect(result.learning).toBeUndefined()
  })
})
