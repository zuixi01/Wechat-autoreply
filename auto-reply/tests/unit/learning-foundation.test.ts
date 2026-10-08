import { afterEach, describe, expect, it } from 'vitest'
import { LearningStore } from '../../src/core/memory/learning-store'
import { resolveLearningScope } from '../../src/core/memory/learning-identity'
import { accountMemoryScope } from '../../src/core/memory/learning-scope'
import type { MemoryScope } from '../../src/shared/contracts/learning-memory'
import type { ConversationBinding } from '../../src/shared/contracts/identity'

const stores: LearningStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})
const scope: MemoryScope = {
  workspaceId: 'profile',
  platform: 'wechat',
  tenantId: 'tenant',
  accountId: 'account',
  conversationId: 'a'
}
function setup() {
  let now = 1000
  const store = new LearningStore(':memory:', () => now)
  stores.push(store)
  const episode = store.recordEpisode(scope, {
    sourceId: 'source',
    topic: '询价',
    startedAt: now,
    messages: [],
    outcome: 'corrected'
  })
  const proposal = {
    content: {
      kind: 'lesson' as const,
      scenario: '报价',
      guidance: '先询问型号',
      rationale: '',
      steps: [],
      pitfalls: [],
      verification: []
    },
    evidence: [{ episodeId: episode.id }],
    source: 'human' as const,
    reason: '员工纠正'
  }
  return {
    store,
    episode,
    proposal,
    advance: (at: number) => {
      now = at
    }
  }
}
const binding: ConversationBinding = {
  identity: {
    tenantId: 'tenant',
    accountId: 'account',
    employeeId: 'employee',
    agentId: 'agent',
    platform: 'wechat',
    loginEpoch: 0,
    clientInstanceId: 'client'
  },
  conversationId: 'a',
  bindingVersion: 1,
  identityVerified: true,
  identityEvidence: ['stable-client-id']
}

describe('learning foundation used by actual generation', () => {
  it('uses a verified binding and refuses incomplete or unverified identities', () => {
    expect(resolveLearningScope('profile', binding)).toEqual(scope)
    expect(resolveLearningScope('profile', { ...binding, identityVerified: false })).toBeNull()
    expect(resolveLearningScope('profile', null)).toBeNull()
    expect(resolveLearningScope('profile', { ...binding, identityEvidence: [] })).toBeNull()
    expect(resolveLearningScope('', binding)).toBeNull()
    expect(resolveLearningScope('profile', { ...binding, conversationId: 'b' })).not.toEqual(scope)
  })
  it('inherits account controls and keeps reading independent from the learning mode', () => {
    const { store } = setup(),
      account = accountMemoryScope(scope)
    store.settings(account, {
      ...store.settings(account),
      mode: 'off',
      memoryEnabled: false,
      dailyReviewTokenBudget: 12000
    })
    expect(store.settings(scope)).toMatchObject({
      mode: 'off',
      memoryEnabled: false,
      dailyReviewTokenBudget: 12000
    })
    store.settings(scope, { ...store.settings(scope), memoryEnabled: true })
    expect(store.settings(scope)).toMatchObject({ mode: 'off', memoryEnabled: false })
  })
  it('invalidates empty and populated snapshots whenever the published corpus changes', () => {
    const { store, proposal } = setup(),
      empty = store.retrieve(scope, '报价')
    const pending = store.propose(scope, proposal)
    expect(store.snapshotCurrent(empty)).toBe(true)
    store.activate(scope, pending.id, 1)
    expect(store.snapshotCurrent(empty)).toBe(false)
    const active = store.retrieve(scope, '报价'),
      version = active.corpusVersion
    store.revise(scope, pending.id, 1, {
      ...proposal,
      content: { ...proposal.content, guidance: '先确认型号和数量' }
    })
    expect(store.snapshotCurrent(active)).toBe(true)
    store.activate(scope, pending.id, 2)
    expect(store.snapshotCurrent(active)).toBe(false)
    expect(store.corpusVersion(scope)).not.toBe(version)
  })
  it('invalidates snapshots on inherited publication, archive/restore and time expiry', () => {
    const { store, proposal, advance } = setup(),
      account = accountMemoryScope(scope)
    const episode = store.recordEpisode(account, {
      sourceId: 'shared',
      topic: '报价',
      startedAt: 1000,
      messages: [],
      outcome: 'resolved'
    })
    const shared = store.propose(account, {
      ...proposal,
      evidence: [{ episodeId: episode.id }],
      expiresAt: 3000
    })
    const empty = store.retrieve(scope, '报价')
    store.activate(account, shared.id, 1)
    expect(store.snapshotCurrent(empty)).toBe(false)
    const before = store.retrieve(scope, '报价')
    store.archive(account, shared.id, 1, 'human')
    store.restore(account, shared.id, 1)
    expect(store.snapshotCurrent(before)).toBe(false)
    const current = store.retrieve(scope, '报价')
    advance(3000)
    expect(store.snapshotCurrent(current)).toBe(false)
  })
  it('retains spent daily budget after forgetting without keeping customer payloads', () => {
    const { store, episode, advance } = setup(),
      account = accountMemoryScope(scope)
    store.settings(account, {
      ...store.settings(account),
      maxReviewInputTokens: 500,
      dailyReviewTokenBudget: 2500,
      idleDelayMs: 1000
    })
    store.jobs.enqueue(scope, episode.id, 'correction', 'trigger')
    advance(2000)
    const claim = store.jobs.claim('worker')!
    expect(claim).not.toBeNull()
    store.jobs.fail(claim, 'request_unknown')
    const usage = store.jobs.usage(scope)
    store.forgetScope(scope)
    expect(store.jobs.usage(scope).reservedTokens).toBe(usage.reservedTokens)
    expect(store.episodes(scope)).toEqual([])
    expect(store.jobs.list(scope)).toEqual([])
    const other = { ...scope, conversationId: 'b' }
    const next = store.recordEpisode(other, {
      sourceId: 'next',
      topic: '报价',
      startedAt: 2000,
      messages: [],
      outcome: 'resolved'
    })
    store.jobs.enqueue(other, next.id, 'completed', 'next-trigger')
    advance(3000)
    expect(store.jobs.claim('worker')).toBeNull()
  })
  it('keeps estimated usage distinguishable from provider-reported counts', () => {
    const { store, episode, advance } = setup()
    store.settings(scope, { ...store.settings(scope), idleDelayMs: 1000 })
    store.jobs.enqueue(scope, episode.id, 'completed', 'trigger')
    advance(2000)
    const claim = store.jobs.claim('worker')!
    store.jobs.complete(
      claim,
      { inputTokens: 8000, outputTokens: 2000, measurement: 'upper_bound' },
      []
    )
    expect(store.jobs.usage(scope)).toMatchObject({ estimatedRequests: 1, reportedRequests: 0 })
  })
})
