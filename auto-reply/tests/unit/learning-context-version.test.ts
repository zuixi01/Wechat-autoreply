import { afterEach, describe, expect, it } from 'vitest'
import { LearningStore } from '../../src/core/memory/learning-store'
import {
  learningContextCurrent,
  retrieveLearningContext
} from '../../src/core/memory/learning-context'
import { accountMemoryScope } from '../../src/core/memory/learning-scope'
import type { MemoryScope } from '../../src/shared/contracts/learning-memory'

const scope: MemoryScope = {
  workspaceId: 'profile',
  platform: 'wechat',
  conversationId: 'customer-a'
}
const stores: LearningStore[] = []
afterEach(() => stores.splice(0).forEach((store) => store.close()))
function setup() {
  let now = 1000
  const store = new LearningStore(':memory:', () => now)
  stores.push(store)
  const record = (sourceId: string, target = scope) =>
    store.recordEpisode(target, {
      sourceId,
      topic: '投诉',
      startedAt: now,
      outcome: 'corrected',
      messages: [{ sourceId: `${sourceId}-msg`, role: 'customer', text: '投诉处理问题' }],
      correction: '先确认客户具体问题',
      correctionReason: '需要明确诉求'
    })
  return {
    store,
    record,
    advance: (at: number) => {
      now = at
    }
  }
}

describe('learning contexts expire when their case catalogue changes', () => {
  it('new_case_invalidates_context even when the previous retrieval was empty', () => {
    const { store, record } = setup()
    const context = retrieveLearningContext(store, scope, '投诉')
    expect(context.episodeIds).toEqual([])
    record('new-case')
    expect(learningContextCurrent(store, context)).toBe(false)
  })

  it('an unrelated customer cannot invalidate this customer context', () => {
    const { store, record } = setup()
    const context = retrieveLearningContext(store, scope, '投诉')
    record('other-case', { ...scope, conversationId: 'customer-b' })
    expect(learningContextCurrent(store, context)).toBe(true)
  })

  it('expired_case_invalidates_context before the maintenance timer runs', () => {
    const { store, record, advance } = setup()
    record('old-case')
    const context = retrieveLearningContext(store, scope, '投诉')
    expect(context.episodeIds).toHaveLength(1)
    advance(1000 + 90 * 86400000 + 1)
    expect(learningContextCurrent(store, context)).toBe(false)
    expect(store.searchEpisodes(scope, '投诉', 3)).toEqual([])
  })

  it('account_off_overrides_customer_patch and prevents reads independently', () => {
    const { store, record } = setup(),
      account = accountMemoryScope(scope)
    const episode = record('case')
    store.settings(scope, { ...store.settings(scope), mode: 'auto', memoryEnabled: true })
    store.settings(account, { ...store.settings(account), mode: 'off', memoryEnabled: false })
    expect(store.settings(scope)).toMatchObject({ mode: 'off', memoryEnabled: false })
    expect(store.jobs.enqueue(scope, episode.id, 'correction', 'trigger')).toBeNull()
    expect(retrieveLearningContext(store, scope, '投诉').episodeIds).toEqual([])
  })

  it('forgetting a method also invalidates contexts containing its evidence case', () => {
    const { store, record } = setup(),
      episode = record('evidence')
    const memory = store.propose(scope, {
      content: {
        kind: 'lesson',
        scenario: '投诉',
        guidance: '先确认问题',
        rationale: '',
        steps: [],
        pitfalls: [],
        verification: []
      },
      evidence: [{ episodeId: episode.id }],
      source: 'review',
      reason: '员工纠正'
    })
    const context = retrieveLearningContext(store, scope, '投诉')
    expect(context.episodeIds).toEqual([episode.id])
    store.forget(scope, memory.id, 1)
    expect(learningContextCurrent(store, context)).toBe(false)
    expect(store.searchEpisodes(scope, '投诉', 3)).toEqual([])
  })
})
