import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LearningStore } from '../../src/core/memory/learning-store'
import { LearningRetention } from '../../src/core/memory/learning-retention'
import {
  learningContextCurrent,
  retrieveLearningContext
} from '../../src/core/memory/learning-context'

const scope = { workspaceId: 'profile', platform: 'wechat' as const, conversationId: 'customer' }
const stores: LearningStore[] = [],
  directories: string[] = []
afterEach(() => {
  stores.splice(0).forEach((store) => store.close())
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }))
})
function setup() {
  let now = 1000
  const dir = mkdtempSync(join(tmpdir(), 'learning-retention-'))
  directories.push(dir)
  const path = join(dir, 'memory.sqlite'),
    store = new LearningStore(path, () => now)
  stores.push(store)
  const episodeInput = {
    sourceId: 'expired-source',
    topic: '投诉',
    startedAt: now,
    outcome: 'corrected' as const,
    messages: [
      { sourceId: 'message', role: 'customer' as const, text: '投诉 CUSTOMER_PRIVATE_SECRET' }
    ],
    correction: '先核对具体问题',
    correctionReason: '理解诉求'
  }
  const episode = store.recordEpisode(scope, episodeInput)
  const memory = store.propose(scope, {
    content: {
      kind: 'lesson',
      scenario: '投诉',
      guidance: '先核对问题',
      rationale: '',
      steps: [],
      pitfalls: [],
      verification: []
    },
    evidence: [{ episodeId: episode.id }],
    source: 'review',
    reason: '员工纠正'
  })
  store.activate(scope, memory.id, 1)
  return {
    store,
    path,
    episode,
    memory,
    episodeInput,
    advance: (at: number) => {
      now = at
    }
  }
}

describe('learning retention deletes case bodies without inventing valid evidence', () => {
  it('physically deletes expired case text and search entries and leaves methods awaiting review', () => {
    const { store, path, episode, memory, advance } = setup()
    const context = retrieveLearningContext(store, scope, '投诉')
    const at = 1000 + 90 * 86400000 + 1
    advance(at)
    expect(new LearningRetention(store).run(at)).toEqual({
      deletedEpisodes: 1,
      redactedEvidence: 1,
      invalidatedMethods: [memory.id]
    })
    expect(store.episodes(scope)).toEqual([])
    expect(store.active(scope)).toEqual([])
    expect(store.get(scope, memory.id).state).toBe('stale')
    expect(store.history(scope, memory.id)[0].redactedEvidenceIds).toEqual([episode.id])
    expect(learningContextCurrent(store, context)).toBe(false)
    const inspect = new DatabaseSync(path)
    try {
      expect(inspect.prepare('SELECT COUNT(*) AS n FROM learning_episodes').get()?.n).toBe(0)
      expect(inspect.prepare('SELECT COUNT(*) AS n FROM learning_episode_search').get()?.n).toBe(0)
      expect(
        inspect
          .prepare(
            "SELECT COUNT(*) AS n FROM learning_revisions WHERE payload LIKE '%CUSTOMER_PRIVATE_SECRET%'"
          )
          .get()?.n
      ).toBe(0)
    } finally {
      inspect.close()
    }
    expect(new LearningRetention(store).run(at).deletedEpisodes).toBe(0)
  })

  it('cancelled late reviews cannot restore expired evidence or refund already reserved usage', () => {
    const { store, path, episode, memory, episodeInput, advance } = setup()
    store.settings(scope, { idleDelayMs: 1000 })
    store.jobs.enqueue(scope, episode.id, 'correction', 'trigger')
    advance(2000)
    const claim = store.jobs.claim('worker')!,
      before = store.jobs.usage(scope).reservedTokens
    const at = 1000 + 90 * 86400000 + 1
    advance(at)
    new LearningRetention(store).run(at)
    expect(store.jobs.list(scope)[0].state).toBe('cancelled')
    const inspect = new DatabaseSync(path)
    try {
      expect(
        inspect
          .prepare('SELECT charged_tokens FROM learning_review_attempts WHERE claim_token=?')
          .get(claim.claimToken)?.charged_tokens
      ).toBe(before)
    } finally {
      inspect.close()
    }
    expect(() =>
      store.applyReview(claim, { operations: [], usage: { inputTokens: 20, outputTokens: 20 } })
    ).toThrow('learning_claim_expired')
    expect(() => store.recordEpisode(scope, episodeInput)).toThrow('episode_forgotten')
    expect(() => store.activate(scope, memory.id, 1)).toThrow()
    store.archive(scope, memory.id, 1, 'human')
    store.restore(scope, memory.id, 1)
    expect(store.active(scope)).toEqual([])
  })

  it('respects per-scope retention and clears raw cases even when learning is disabled', () => {
    const { store, advance } = setup(),
      other = { ...scope, conversationId: 'other-customer' }
    store.settings(scope, { mode: 'off', caseRetentionDays: 7 })
    store.settings(other, { caseRetentionDays: 30 })
    const kept = store.recordEpisode(other, {
      sourceId: 'kept',
      topic: '投诉',
      startedAt: 1000,
      messages: [],
      outcome: 'resolved'
    })
    const at = 1000 + 7 * 86400000 + 1
    advance(at)
    expect(new LearningRetention(store).run(at).deletedEpisodes).toBe(1)
    expect(store.episodes(other).map((item) => item.id)).toEqual([kept.id])
  })

  it('persists redaction and replay protection after closing and reopening the database', () => {
    const { store, path, memory, episodeInput, advance } = setup()
    const at = 1000 + 90 * 86400000 + 1
    advance(at)
    new LearningRetention(store).run(at)
    store.close()
    const reopened = new LearningStore(path, () => at)
    stores.push(reopened)
    expect(reopened.get(scope, memory.id).state).toBe('stale')
    expect(reopened.history(scope, memory.id)[0].redactedEvidenceIds).toHaveLength(1)
    expect(() => reopened.recordEpisode(scope, episodeInput)).toThrow('episode_forgotten')
  })
})
