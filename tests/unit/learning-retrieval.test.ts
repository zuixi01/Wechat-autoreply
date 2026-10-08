import { afterEach, describe, expect, it } from 'vitest'
import { LearningStore } from '../../src/core/memory/learning-store'
import { buildLearningContext, estimateMemoryTokens } from '../../src/core/memory/learning-retrieval'
import type { MemoryScope, MemoryContent } from '../../src/shared/contracts/learning-memory'

const stores: LearningStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })
const scope: MemoryScope = { workspaceId: 'work', platform: 'wechat', conversationId: 'customer-a' }
function open(now = () => 5000): LearningStore { const store = new LearningStore(':memory:', now); stores.push(store); return store }
function save(store: LearningStore, content: Partial<MemoryContent> & { scenario: string; guidance: string }, target = scope, expiresAt?: number) {
  const episode = store.recordEpisode(target, { sourceId: content.scenario, topic: content.scenario, startedAt: 1000, endedAt: 2000, outcome: 'resolved', messages: [{ sourceId: 'source', role: 'customer', text: content.scenario }] })
  const memory = store.propose(target, { content: { kind: 'lesson', rationale: '', steps: [], pitfalls: [], verification: [], ...content }, evidence: [{ episodeId: episode.id }], source: 'human', reason: '经人工确认的处理方法', expiresAt })
  store.activate(target, memory.id, memory.currentRevision)
  return memory
}

describe('bounded scoped Chinese memory retrieval', () => {
  it('loads pricing guidance for a Chinese compound query and excludes unrelated complaint procedures', () => {
    const store = open()
    const pricing = save(store, { scenario: '设备报价与产品价格询价', guidance: '先确认设备型号和数量，再提供产品报价' })
    save(store, { scenario: '售后投诉和故障维修', guidance: '先记录故障表现，联系售后安排维修' })
    const snapshot = store.retrieve(scope, '设备多少钱？需要产品报价')
    expect(snapshot.items.map(item => item.id)).toEqual([pricing.id])
    expect(store.retrieve(scope, '售后投诉，设备故障维修').items[0].content.scenario).toContain('售后投诉')
  })
  it('loads explicit account inheritance but never another customer or account', () => {
    const store = open(); const account: MemoryScope = { workspaceId: 'work', platform: 'wechat' }
    const shared = save(store, { scenario: '设备询价', guidance: '确认型号' }, account)
    save(store, { scenario: '设备询价', guidance: '只适用于另一个客户' }, { ...scope, conversationId: 'customer-b' })
    expect(store.retrieve(scope, '设备询价').items.map(item => item.id)).toEqual([shared.id])
    expect(store.retrieve({ ...scope, workspaceId: 'other-work' }, '设备询价').items).toEqual([])
  })
  it('excludes pending, archived and expired candidates before ranking', () => {
    let now = 1000; const store = open(() => now)
    const expired = save(store, { scenario: '客户询价', guidance: '过期规则' }, scope, 2000)
    const archived = save(store, { scenario: '产品询价', guidance: '归档规则' }); store.archive(scope, archived.id, 1, 'human')
    const episode = store.episodes(scope)[0]
    store.propose(scope, { content: { kind: 'lesson', scenario: '报价询价', guidance: '待发布规则', rationale: '', steps: [], pitfalls: [], verification: [] }, evidence: [{ episodeId: episode.id }], source: 'review', reason: '自动建议' })
    now = 3000
    expect(store.retrieve(scope, '客户询价产品报价').items).toEqual([])
    expect(store.list(scope).some(memory => memory.id === expired.id)).toBe(true)
  })
  it('enforces five items and the rendered UTF-8 conservative token budget including instructions', () => {
    const store = open()
    for (let i = 0; i < 10; i++) save(store, { scenario: `设备报价型号${i}`, guidance: '确认具体需求和数量' })
    const snapshot = store.retrieve(scope, '设备报价型号', { maxEntries: 5, maxTokens: 2000 })
    expect(snapshot.items).toHaveLength(5)
    expect(snapshot.estimatedTokens).toBe(estimateMemoryTokens(buildLearningContext(snapshot)))
    expect(snapshot.estimatedTokens).toBeLessThanOrEqual(2000)
    const bounded = store.retrieve(scope, '设备报价型号', { maxTokens: 256 })
    expect(bounded.estimatedTokens).toBeLessThanOrEqual(256)
    expect(() => store.retrieve(scope, '设备报价', { maxEntries: 6 })).toThrow()
  })
  it('does not return arbitrary memories for empty or unrelated queries', () => {
    const store = open(); save(store, { scenario: '产品询价', guidance: '确认型号再报价' })
    expect(store.retrieve(scope, '').items).toEqual([])
    expect(store.retrieve(scope, '   ').items).toEqual([])
    expect(store.retrieve(scope, '明天天气预报').items).toEqual([])
    expect(buildLearningContext(store.retrieve(scope, '明天天气预报'))).toBe('')
  })
  it('pins active versions without mutating the snapshot while a new candidate is being reviewed', () => {
    const store = open(); const memory = save(store, { scenario: '产品询价', guidance: '先确认型号数量' })
    const first = store.retrieve(scope, '产品询价')
    const revision = store.history(scope, memory.id)[0]
    store.revise(scope, memory.id, 1, { content: { ...revision.content, guidance: '信息完整时直接查知识库报价' }, reason: '避免重复追问', source: 'human', evidence: revision.evidence })
    expect(store.retrieve(scope, '产品询价').snapshotId).toBe(first.snapshotId)
    store.activate(scope, memory.id, 2)
    const second = store.retrieve(scope, '产品询价')
    expect(second.snapshotId).not.toBe(first.snapshotId)
    expect(second.items[0].revision).toBe(2)
    expect(first.items[0].revision).toBe(1)
    expect(first.items[0].content.guidance).toBe('先确认型号数量')
    expect(store.snapshotCurrent(first)).toBe(false)
  })
})
