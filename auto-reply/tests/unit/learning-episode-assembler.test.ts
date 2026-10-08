import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LearningStore } from '../../src/core/memory/learning-store'
import { LearningEpisodeAssembler } from '../../src/core/memory/learning-episode-assembler'
import type { MemoryScope } from '../../src/shared/contracts/learning-memory'

const scope: MemoryScope = { workspaceId: 'profile', platform: 'wechat', conversationId: 'a' }
const stores: LearningStore[] = [],
  directories: string[] = []
afterEach(() => {
  stores.splice(0).forEach((store) => store.close())
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }))
})
function setup(path = ':memory:') {
  let now = 1000
  const store = new LearningStore(path, () => now)
  stores.push(store)
  return {
    store,
    assembler: store.assembler as LearningEpisodeAssembler,
    advance: (at: number) => {
      now = at
    }
  }
}
const event = (sourceId: string, text: string, at = 1000) => ({
  scope,
  problemId: 'problem',
  sourceId,
  message: { sourceId, role: 'customer' as const, text },
  at
})

describe('durable problem episode assembly', () => {
  it('accumulates multiple messages of one problem, deduplicates retry, and closes once', () => {
    const { store, assembler, advance } = setup()
    const id = assembler.append(event('first', '想询问价格'))
    expect(assembler.append(event('first', '想询问价格'))).toBe(id)
    expect(assembler.append(event('second', '数量是十台', 2000))).toBe(id)
    expect(store.episodes(scope)).toEqual([])
    advance(3000)
    const close = {
      scope,
      problemId: 'problem',
      sourceId: 'finish',
      outcome: 'resolved' as const,
      at: 3000
    }
    const episode = assembler.close(close)
    expect(episode.messages.map((message) => message.text)).toEqual(['想询问价格', '数量是十台'])
    expect(episode).toMatchObject({ startedAt: 1000, endedAt: 3000, outcome: 'resolved' })
    expect(assembler.close(close).id).toBe(episode.id)
    expect(store.episodes(scope)).toHaveLength(1)
    expect(store.jobs.list(scope)[0].episodeIds).toEqual([episode.id])
    expect(() => assembler.close({ ...close, outcome: 'failed' })).toThrow('episode_event_conflict')
    expect(() => assembler.append(event('third', '迟到内容', 4000))).toThrow('problem_closed')
  })
  it('splits contact and problem identifiers even when names and message ids are equal', () => {
    const { assembler } = setup()
    const first = assembler.append(event('first', '报价'))
    const contact = assembler.append({
      ...event('first', '报价'),
      scope: { ...scope, conversationId: 'b' }
    })
    const problem = assembler.append({ ...event('other', '售后'), problemId: 'another-problem' })
    expect(new Set([first, contact, problem]).size).toBe(3)
  })
  it('rejects a reused event id with different text or problem', () => {
    const { assembler } = setup()
    assembler.append(event('first', '报价'))
    expect(() => assembler.append(event('first', '改过的报价'))).toThrow('episode_event_conflict')
    expect(() => assembler.append({ ...event('first', '报价'), problemId: 'changed' })).toThrow(
      'episode_event_conflict'
    )
  })
  it('closes idle problems as unknown only after 30 minutes, never as success', () => {
    const { assembler, store, advance } = setup()
    assembler.append(event('first', '需要报价'))
    expect(assembler.flushIdle(1800999)).toEqual([])
    advance(1801000)
    const episodes = assembler.flushIdle(1801000)
    expect(episodes).toHaveLength(1)
    expect(episodes[0].outcome).toBe('unknown')
    expect(store.jobs.list(scope)).toEqual([])
    expect(assembler.flushIdle(1801000)).toEqual([])
  })
  it('preserves an open problem across a real SQLite restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'learning-problem-'))
    directories.push(directory)
    const path = join(directory, 'memory.sqlite')
    const first = setup(path)
    const id = first.assembler.append(event('first', '询价'))
    first.store.close()
    const resumed = setup(path)
    expect(resumed.assembler.append(event('second', '确认型号', 2000))).toBe(id)
    expect(
      resumed.assembler.close({
        scope,
        problemId: 'problem',
        sourceId: 'close',
        outcome: 'handoff',
        at: 3000
      }).messages
    ).toHaveLength(2)
  })
  it('forgetting a scope removes open bodies and blocks late events or close replay', () => {
    const { assembler, store } = setup()
    assembler.append(event('first', '隐私正文'))
    store.forgetScope(scope)
    expect(() => assembler.append(event('first', '隐私正文'))).toThrow('problem_forgotten')
    expect(() => assembler.append(event('late', '迟到消息'))).toThrow('problem_forgotten')
    expect(() =>
      assembler.close({
        scope,
        problemId: 'problem',
        sourceId: 'close',
        outcome: 'resolved',
        at: 2000
      })
    ).toThrow('problem_forgotten')
    expect(assembler.flushIdle(1801000)).toEqual([])
  })
  it('stops after the bounded message count without losing earlier evidence', () => {
    const { assembler } = setup()
    for (let i = 0; i < 100; i++) assembler.append(event(`message-${i}`, `消息${i}`, 1000 + i))
    expect(() => assembler.append(event('overflow', '101条', 1101))).toThrow(
      'problem_message_limit'
    )
    const episode = assembler.close({
      scope,
      problemId: 'problem',
      sourceId: 'close',
      outcome: 'unknown',
      at: 2000
    })
    expect(episode.messages).toHaveLength(100)
  })
  it('learning off keeps genuine evidence but never enqueues a review', () => {
    const { assembler, store } = setup()
    store.settings(scope, { mode: 'off' })
    assembler.append(event('first', '问题'))
    assembler.close({
      scope,
      problemId: 'problem',
      sourceId: 'close',
      outcome: 'resolved',
      at: 2000
    })
    expect(store.jobs.list(scope)).toEqual([])
    expect(store.episodes(scope)).toHaveLength(1)
  })
  it('retention removes an abandoned open body instead of reviving its retention clock', () => {
    const { assembler, store, advance } = setup()
    assembler.append(event('first', '旧的隐私正文'))
    advance(91 * 86400000)
    store.pruneExpiredEpisodes(91 * 86400000)
    expect(assembler.flushIdle(91 * 86400000)).toEqual([])
    expect(() => assembler.append(event('late', '迟到消息'))).toThrow('problem_forgotten')
    expect(store.episodes(scope)).toEqual([])
  })
  it('one forgotten loaded method cannot prevent idle closure of every open problem', () => {
    const { assembler, store, advance } = setup()
    const evidence = store.recordEpisode(scope, {
      sourceId: 'old',
      topic: '旧经验',
      startedAt: 0,
      messages: [],
      outcome: 'corrected'
    })
    const method = store.propose(scope, {
      source: 'human',
      reason: '旧方法',
      evidence: [{ episodeId: evidence.id }],
      content: {
        kind: 'lesson',
        scenario: '询价',
        guidance: '询问需求',
        rationale: '',
        steps: [],
        pitfalls: [],
        verification: []
      }
    })
    assembler.append({
      ...event('first', '报价'),
      loadedMemoryRefs: [{ id: method.id, revision: 1 }]
    })
    assembler.append({ ...event('other', '售后'), problemId: 'another' })
    store.forget(scope, method.id, 1)
    advance(1801000)
    expect(assembler.flushIdle(1801000)).toHaveLength(2)
    expect(store.list(scope)).toEqual([])
  })
})
