import { afterEach, describe, expect, it } from 'vitest'
import { LearningStore } from '../../src/core/memory/learning-store'
import type { MemoryScope } from '../../src/shared/contracts/learning-memory'
import { accountMemoryScope } from '../../src/core/memory/learning-scope'

const stores: LearningStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})
const scope: MemoryScope = {
  workspaceId: 'profile',
  platform: 'wechat',
  conversationId: 'customer-a'
}
function setup() {
  let now = 1000
  const store = new LearningStore(':memory:', () => now)
  stores.push(store)
  store.settings(scope, {
    ...store.settings(scope),
    idleDelayMs: 1000,
    maxReviewInputTokens: 256,
    dailyReviewTokenBudget: 20000
  })
  const record = (sourceId: string, target = scope) =>
    store.recordEpisode(target, {
      sourceId,
      topic: '设备报价',
      startedAt: 1000,
      outcome: 'corrected',
      correction: '先确认需求',
      messages: [{ sourceId: 'msg', role: 'customer', text: '报价多少' }]
    })
  return {
    store,
    record,
    advance: (value: number) => {
      now += value
    },
    time: () => now
  }
}

describe('durable coalesced learning queue', () => {
  it('coalesces pending episodes within scope and deduplicates source events', () => {
    const { store, record, advance } = setup()
    const a = record('a'),
      b = record('b')
    const first = store.jobs.enqueue(scope, a.id, 'correction', 'event-a')!
    expect(store.jobs.enqueue(scope, a.id, 'correction', 'event-a')!.id).toBe(first.id)
    expect(store.jobs.enqueue(scope, b.id, 'completed', 'event-b')!.id).toBe(first.id)
    expect(store.jobs.list(scope)[0].episodeIds).toEqual([a.id, b.id])
    expect(store.jobs.claim('worker')).toBeNull()
    advance(1000)
    const claimed = store.jobs.claim('worker')!
    expect(claimed).toMatchObject({ id: first.id, state: 'running', attempts: 1 })
    expect(store.jobs.claim('other-worker')).toBeNull()
    expect(() => store.jobs.enqueue(scope, a.id, 'completed', 'event-a')).toThrow(
      'learning_event_conflict'
    )
  })

  it('refuses episode spoofing and never coalesces across customers', () => {
    const { store, record, advance } = setup()
    const a = record('a')
    const other = { ...scope, conversationId: 'b' }
    const b = record('a', other)
    expect(() => store.jobs.enqueue(other, a.id, 'correction', 'forged')).toThrow(
      'evidence_scope_mismatch'
    )
    const first = store.jobs.enqueue(scope, a.id, 'correction', 'first')!
    const second = store.jobs.enqueue(other, b.id, 'correction', 'second')!
    expect(first.id).not.toBe(second.id)
    advance(20000)
    const claimed = store.jobs.claim('worker')!
    store.jobs.complete(claimed, { inputTokens: 50, outputTokens: 10 }, [])
    expect(store.jobs.claim('worker')?.id).not.toBe(claimed.id)
  })

  it('does not enqueue off-mode work, leaves normal episodes intact, and holds queued work after switching off', () => {
    const { store, record, advance } = setup()
    const a = record('a')
    store.jobs.enqueue(scope, a.id, 'correction', 'a')
    store.settings(scope, { ...store.settings(scope), mode: 'off' })
    advance(20000)
    expect(store.jobs.claim('worker')).toBeNull()
    expect(store.jobs.enqueue(scope, a.id, 'completed', 'b')).toBeNull()
    expect(store.episodes(scope)).toHaveLength(1)
  })

  it('recovers abandoned leases and refuses late completion from a replaced worker', () => {
    const { store, record, advance } = setup()
    const a = record('a')
    store.jobs.enqueue(scope, a.id, 'correction', 'a')
    advance(1000)
    const old = store.jobs.claim('old-worker')!
    advance(40000)
    const current = store.jobs.claim('new-worker')!
    expect(current).toMatchObject({ id: old.id, attempts: 2 })
    expect(() => store.jobs.complete(old, { inputTokens: 10, outputTokens: 10 }, [])).toThrow(
      'learning_claim_expired'
    )
    store.jobs.complete(current, { inputTokens: 10, outputTokens: 10 }, [])
    expect(store.jobs.list(scope)[0].state).toBe('completed')
  })

  it('enforces a single worker globally and a daily budget even when usage is unavailable', () => {
    const { store, record, advance } = setup()
    store.settings(scope, { ...store.settings(scope), dailyReviewTokenBudget: 2500 })
    const accountScope = accountMemoryScope(scope)
    store.settings(accountScope, { ...store.settings(accountScope), dailyReviewTokenBudget: 2500 })
    const a = record('a')
    store.jobs.enqueue(scope, a.id, 'correction', 'a')
    advance(1000)
    const claim = store.jobs.claim('worker')!
    const otherScope: MemoryScope = { ...scope, conversationId: 'other' }
    const b = record('b', otherScope)
    store.jobs.enqueue(otherScope, b.id, 'correction', 'b')
    advance(20000)
    expect(store.jobs.claim('other-worker')).toBeNull()
    store.jobs.fail(claim, 'unavailable')
    expect(store.jobs.usage(scope).reservedTokens).toBeGreaterThan(0)
    advance(10000)
    expect(store.jobs.claim('worker')).toBeNull()
    expect(store.jobs.list(scope)[0].lastError).toBe('unavailable')
  })

  it('cancels a forgotten customer job and never accepts its late review', () => {
    const { store, record, advance } = setup()
    const a = record('a')
    store.jobs.enqueue(scope, a.id, 'correction', 'a')
    advance(1000)
    const claim = store.jobs.claim('worker')!
    store.forgetScope(scope)
    expect(store.jobs.list(scope)).toEqual([])
    expect(() => store.jobs.complete(claim, { inputTokens: 50, outputTokens: 10 }, [])).toThrow(
      'learning_claim_expired'
    )
  })
  it('charges a request to its original UTC day even when completion crosses midnight', () => {
    const { store, record, advance, time } = setup()
    const beforeMidnight = Date.UTC(2026, 9, 3, 23, 59, 58)
    advance(beforeMidnight - time())
    const episode = record('midnight')
    store.jobs.enqueue(scope, episode.id, 'correction', 'midnight')
    advance(1000)
    const claim = store.jobs.claim('worker')!
    advance(2000)
    store.jobs.complete(claim, { inputTokens: 100, outputTokens: 10 }, [])
    expect(store.jobs.usage(scope).reservedTokens).toBe(0)
    advance(beforeMidnight - time())
    expect(store.jobs.usage(scope)).toMatchObject({
      day: '2026-10-03',
      reservedTokens: 110,
      reportedRequests: 1
    })
  })
  it('a late report only settles its attempt while a newer worker retains ownership', () => {
    const { store, record, advance } = setup()
    store.jobs.enqueue(scope, record('retry').id, 'correction', 'retry')
    advance(1000)
    const old = store.jobs.claim('first')!
    store.jobs.fail(old, 'foreground_preempted')
    advance(10000)
    const current = store.jobs.claim('second')!
    expect(
      store.jobs.settleAttemptUsage(old, {
        inputTokens: 100,
        outputTokens: 10,
        measurement: 'reported'
      })
    ).toBe(true)
    expect(store.jobs.list(scope)[0]).toMatchObject({
      state: 'running',
      claimToken: current.claimToken
    })
    expect(() => store.jobs.complete(old, { inputTokens: 100, outputTokens: 10 }, [])).toThrow(
      'learning_claim_expired'
    )
    store.jobs.complete(current, { inputTokens: 100, outputTokens: 10 }, [])
    expect(store.jobs.usage(scope)).toMatchObject({ reservedTokens: 220, reportedRequests: 2 })
    expect(() =>
      store.jobs.settleAttemptUsage(old, {
        inputTokens: 200,
        outputTokens: 10,
        measurement: 'reported'
      })
    ).toThrow('learning_usage_conflict')
  })
})
