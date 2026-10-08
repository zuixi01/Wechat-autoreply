import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LearningStore } from '../../src/core/memory/learning-store'
import { accountMemoryScope } from '../../src/core/memory/learning-scope'
import type {
  MemoryScope,
  NewLearningEpisode,
  MemoryProposal
} from '../../src/shared/contracts/learning-memory'

const resources: LearningStore[] = []
const directories: string[] = []
afterEach(() => {
  for (const store of resources.splice(0)) store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
const scope: MemoryScope = {
  workspaceId: 'desktop-profile',
  platform: 'wechat',
  tenantId: 'business-a',
  accountId: 'account-a',
  conversationId: 'customer-id-a'
}
const episode: NewLearningEpisode = {
  sourceId: 'task-1',
  topic: '询价',
  startedAt: 1000,
  endedAt: 2000,
  messages: [{ sourceId: 'message-1', role: 'customer', text: '这个设备多少钱？' }],
  draft: '价格是100元',
  correction: '请问您需要什么型号和数量？',
  outcome: 'corrected',
  correctionReason: '先确认型号和数量，避免错误报价'
}
function open(path = ':memory:'): LearningStore {
  const store = new LearningStore(path)
  resources.push(store)
  return store
}
function proposal(
  episodeId: string,
  guidance = '先确认型号和数量，再根据知识库报价'
): MemoryProposal {
  return {
    content: {
      kind: 'skill',
      scenario: '客户询问设备报价且信息不足',
      guidance,
      rationale: '准确匹配需求',
      steps: ['确认型号', '确认数量', '查阅正式报价资料'],
      pitfalls: ['不要猜测价格'],
      verification: ['客户需求完整']
    },
    evidence: [{ episodeId }],
    reason: '员工明确纠正报价流程',
    source: 'review'
  }
}

describe('scoped durable learning memory', () => {
  it('stores pending evidence-backed proposals and preserves them across restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'learning-store-'))
    directories.push(directory)
    const path = join(directory, 'learning.sqlite')
    const first = open(path)
    const recorded = first.recordEpisode(scope, episode)
    const memory = first.propose(scope, proposal(recorded.id))
    expect(memory).toMatchObject({ state: 'pending', currentRevision: 1, activeRevision: null })
    expect(first.active(scope)).toEqual([])
    first.close()
    const restarted = open(path)
    expect(restarted.list(scope)[0]).toEqual(memory)
    expect(restarted.episodes(scope)[0]).toEqual(recorded)
    expect(restarted.history(scope, memory.id)[0].evidence).toEqual([{ episodeId: recorded.id }])
  })

  it('isolates tenants, accounts, platforms, workspaces and identical customer names', () => {
    const store = open()
    const recorded = store.recordEpisode(scope, episode)
    const memory = store.propose(scope, proposal(recorded.id))
    store.activate(scope, memory.id, 1)
    for (const other of [
      { ...scope, tenantId: 'business-b' },
      { ...scope, accountId: 'account-b' },
      { ...scope, platform: 'wework' as const },
      { ...scope, workspaceId: 'other-profile' },
      { ...scope, conversationId: 'other-customer-same-display-name' }
    ]) {
      expect(store.list(other)).toEqual([])
      expect(store.episodes(other)).toEqual([])
      expect(() => store.history(other, memory.id)).toThrow('memory_not_found')
      expect(() => store.propose(other, proposal(recorded.id))).toThrow('evidence_scope_mismatch')
    }
  })

  it('rejects partial enterprise identity and untrusted or missing evidence', () => {
    const store = open()
    expect(() =>
      store.recordEpisode({ workspaceId: 'x', platform: 'wechat', tenantId: 'a' }, episode)
    ).toThrow()
    expect(() => store.propose(scope, proposal('missing'))).toThrow('evidence_scope_mismatch')
    expect(() => store.propose(scope, { ...proposal('missing'), evidence: [] })).toThrow()
  })

  it('deduplicates identical episodes but rejects source ID reuse with altered content', () => {
    const store = open()
    const recorded = store.recordEpisode(scope, episode)
    expect(store.recordEpisode(scope, structuredClone(episode))).toEqual(recorded)
    expect(store.episodes(scope)).toHaveLength(1)
    expect(() => store.recordEpisode(scope, { ...episode, correction: '直接报价' })).toThrow(
      'episode_source_conflict'
    )
    const other = store.recordEpisode({ ...scope, conversationId: 'other-customer' }, episode)
    expect(other.id).not.toBe(recorded.id)
  })

  it('deduplicates proposals without losing independent supporting cases', () => {
    const store = open()
    const firstEpisode = store.recordEpisode(scope, episode)
    const secondEpisode = store.recordEpisode(scope, { ...episode, sourceId: 'task-2' })
    const first = store.propose(scope, proposal(firstEpisode.id))
    expect(store.propose(scope, proposal(firstEpisode.id)).id).toBe(first.id)
    const strengthened = store.propose(scope, proposal(secondEpisode.id))
    expect(strengthened.id).toBe(first.id)
    expect(strengthened.currentRevision).toBe(2)
    expect(store.history(scope, first.id)[1].evidence).toHaveLength(2)
    expect(store.list(scope)).toHaveLength(1)
  })

  it('retains active V1 while V2 is pending, refuses stale writers, and rolls back with a new revision', () => {
    const store = open()
    const recorded = store.recordEpisode(scope, episode)
    const first = store.propose(scope, proposal(recorded.id))
    store.activate(scope, first.id, 1)
    const second = store.revise(
      scope,
      first.id,
      1,
      proposal(recorded.id, '信息已齐全时不要重复追问')
    )
    expect(second).toMatchObject({ currentRevision: 2, activeRevision: 1 })
    expect(store.active(scope)[0].content.guidance).toContain('先确认型号')
    expect(() => store.revise(scope, first.id, 1, proposal(recorded.id))).toThrow(
      'memory_revision_conflict'
    )
    store.activate(scope, first.id, 2)
    expect(store.active(scope)[0].content.guidance).toContain('不要重复追问')
    const rollback = store.rollback(scope, first.id, 2, 1)
    expect(rollback).toMatchObject({ currentRevision: 3, activeRevision: 3 })
    expect(store.active(scope)[0].content.guidance).toContain('先确认型号')
    expect(store.history(scope, first.id)).toHaveLength(3)
  })

  it('requires a previously activated revision for rollback and keeps pinned rules intact', () => {
    const store = open()
    const recorded = store.recordEpisode(scope, episode)
    const first = store.propose(scope, proposal(recorded.id))
    store.activate(scope, first.id, 1)
    store.revise(scope, first.id, 1, proposal(recorded.id, '待验证的处理方法'))
    expect(() => store.rollback(scope, first.id, 2, 2)).toThrow('rollback_target_unpublished')
    store.setPinned(scope, first.id, 2, true)
    expect(() => store.revise(scope, first.id, 2, proposal(recorded.id))).toThrow('memory_pinned')
    expect(() => store.archive(scope, first.id, 2, 'curator')).toThrow('memory_pinned')
    store.archive(scope, first.id, 2, 'human')
    expect(store.active(scope)).toEqual([])
    store.restore(scope, first.id, 2)
    expect(store.active(scope)).toHaveLength(1)
  })

  it('explicit forget removes readable content and blocks replay from old evidence', () => {
    const store = open()
    const recorded = store.recordEpisode(scope, episode)
    const first = store.propose(scope, proposal(recorded.id))
    store.activate(scope, first.id, 1)
    store.forget(scope, first.id, 1)
    expect(store.list(scope)).toEqual([])
    expect(store.history(scope, first.id)).toEqual([])
    expect(() => store.propose(scope, proposal(recorded.id))).toThrow('memory_forgotten')
    expect(() => store.propose(scope, proposal(recorded.id, '改写措辞试图恢复相同教训'))).toThrow(
      'memory_forgotten'
    )
    expect(() => store.restore(scope, first.id, 1)).toThrow('memory_not_found')
  })

  it('deleting a customer removes cases/feedback/revisions and rejects late writes from removed cases', () => {
    const store = open()
    const recorded = store.recordEpisode(scope, episode)
    const first = store.propose(scope, proposal(recorded.id))
    store.activate(scope, first.id, 1)
    store.feedback(scope, {
      sourceId: 'feedback-1',
      episodeId: recorded.id,
      kind: 'adopted',
      memoryRefs: [{ id: first.id, revision: 1 }],
      at: 3000
    })
    store.forgetScope(scope)
    expect(store.episodes(scope)).toEqual([])
    expect(store.list(scope)).toEqual([])
    expect(store.feedbackEvents(scope)).toEqual([])
    expect(() => store.propose(scope, proposal(recorded.id))).toThrow()
  })

  it('counts loading, adoption, correction and delivery separately and feedback is idempotent', () => {
    const store = open()
    const recorded = store.recordEpisode(scope, episode)
    const memory = store.propose(scope, proposal(recorded.id))
    store.activate(scope, memory.id, 1)
    const loaded = {
      sourceId: 'loaded-1',
      episodeId: recorded.id,
      kind: 'loaded' as const,
      memoryRefs: [{ id: memory.id, revision: 1 }],
      at: 3000
    }
    store.feedback(scope, loaded)
    store.feedback(scope, loaded)
    store.feedback(scope, { ...loaded, sourceId: 'sent-1', kind: 'delivery_confirmed' })
    expect(store.metrics(scope, memory.id)).toMatchObject({
      loaded: 1,
      adopted: 0,
      delivery_confirmed: 1,
      substantially_corrected: 0
    })
    expect(() => store.feedback(scope, { ...loaded, kind: 'adopted' })).toThrow(
      'feedback_source_conflict'
    )
    expect(() => store.feedback({ ...scope, accountId: 'different' }, loaded)).toThrow(
      'evidence_scope_mismatch'
    )
  })

  it('keeps shared account lessons separate from customer memory unless explicitly retrieving inheritance', () => {
    const store = open()
    const accountScope = accountMemoryScope(scope)
    const recorded = store.recordEpisode(accountScope, episode)
    const memory = store.propose(accountScope, proposal(recorded.id))
    store.activate(accountScope, memory.id, 1)
    expect(store.list(scope)).toEqual([])
    expect(store.active(scope, { includeAccount: true })).toHaveLength(1)
    expect(store.active({ ...scope, accountId: 'other' }, { includeAccount: true })).toEqual([])
  })

  it('validates settings and saves mode changes durably without changing scope', () => {
    const store = open()
    expect(store.settings(scope)).toMatchObject({
      mode: 'suggest',
      maxEntries: 5,
      maxContextTokens: 2000,
      concurrency: 1
    })
    expect(store.settings(scope, { ...store.settings(scope), mode: 'off' }).mode).toBe('off')
    expect(store.settings({ ...scope, accountId: 'other' }).mode).toBe('suggest')
    expect(() => store.settings(scope, { ...store.settings(scope), maxEntries: 6 })).toThrow()
  })

  it('imports legacy cards once, preserves a source backup, and never activates unknown ownership', () => {
    const directory = mkdtempSync(join(tmpdir(), 'learning-legacy-'))
    directories.push(directory)
    const file = join(directory, 'cards.json')
    const source = JSON.stringify({
      version: 1,
      cards: [
        {
          cardId: 'old-card',
          scenario: '询价',
          guidance: '先了解需求',
          rationale: '',
          source: 'human_takeover',
          evidence: { sessionId: 'old-session' },
          enabled: true,
          stats: { used: 90, success: 85 },
          createdAt: 1000
        }
      ]
    })
    writeFileSync(file, source)
    const store = open()
    expect(store.migrateLegacy(file)).toMatchObject({ imported: 1, alreadyImported: 0 })
    expect(store.migrateLegacy(file)).toMatchObject({ imported: 0, alreadyImported: 1 })
    expect(readFileSync(file, 'utf8')).toBe(source)
    expect(readFileSync(`${file}.learning-backup`, 'utf8')).toBe(source)
    expect(store.unassigned()).toHaveLength(1)
    expect(store.unassigned()[0]).toMatchObject({
      state: 'pending',
      legacyStats: { used: 90, success: 85 }
    })
    expect(store.active(scope, { includeAccount: true })).toEqual([])
  })

  it('rolls back failed database mutations instead of claiming success', () => {
    const directory = mkdtempSync(join(tmpdir(), 'learning-fault-'))
    directories.push(directory)
    const path = join(directory, 'learning.sqlite')
    const store = open(path)
    const recorded = store.recordEpisode(scope, episode)
    const fault = new DatabaseSync(path)
    fault.exec(
      "CREATE TRIGGER fail_memory_audit BEFORE INSERT ON learning_mutations BEGIN SELECT RAISE(ABORT, 'disk_failure'); END"
    )
    fault.close()
    expect(() => store.propose(scope, proposal(recorded.id))).toThrow('disk_failure')
    expect(store.list(scope)).toEqual([])
  })

  it('keeps a failed index migration retryable instead of advancing the schema version', () => {
    const directory = mkdtempSync(join(tmpdir(), 'learning-migration-'))
    directories.push(directory)
    const path = join(directory, 'learning.sqlite')
    const store = open(path)
    const recorded = store.recordEpisode(scope, episode)
    store.propose(scope, proposal(recorded.id))
    store.close()
    const broken = new DatabaseSync(path)
    broken.exec(
      "DROP TRIGGER learning_search_forget; DROP TABLE learning_search; PRAGMA user_version=1; UPDATE learning_revisions SET payload='invalid json'"
    )
    broken.close()
    expect(() => open(path)).toThrow()
    const inspect = new DatabaseSync(path)
    try {
      expect(inspect.prepare('PRAGMA user_version').get()?.user_version).toBe(1)
    } finally {
      inspect.close()
    }
  })

  it('counts inherited account-memory use from a customer without allowing foreign account references', () => {
    const store = open()
    const accountScope = accountMemoryScope(scope)
    const accountEpisode = store.recordEpisode(accountScope, episode)
    const shared = store.propose(accountScope, proposal(accountEpisode.id))
    store.activate(accountScope, shared.id, 1)
    const customerEpisode = store.recordEpisode(scope, episode)
    const input = {
      sourceId: 'loaded-shared',
      episodeId: customerEpisode.id,
      kind: 'loaded' as const,
      memoryRefs: [{ id: shared.id, revision: 1 }],
      at: 3000
    }
    store.feedback(scope, input)
    expect(store.metrics(accountScope, shared.id).loaded).toBe(1)
    const foreignScope = { ...accountScope, accountId: 'foreign' }
    const foreignEpisode = store.recordEpisode(foreignScope, episode)
    const foreign = store.propose(foreignScope, proposal(foreignEpisode.id))
    store.activate(foreignScope, foreign.id, 1)
    expect(() =>
      store.feedback(scope, {
        ...input,
        sourceId: 'foreign-ref',
        memoryRefs: [{ id: foreign.id, revision: 1 }]
      })
    ).toThrow('memory_not_found')
  })
})
