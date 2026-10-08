import { afterEach, describe, expect, it } from 'vitest'
import { Ledger } from '../../src/core/persistence/ledger'
import { LearningStore } from '../../src/core/memory/learning-store'
import { LearningSubmissionSync } from '../../src/main/services/learning-service'
import type { LearningSubmissionRequest } from '../../src/shared/contracts/learning-submissions'
import type { LearningSubmissionBinding } from '../../src/main/services/learning-submission-sync'

const scope = { workspaceId: 'work', platform: 'generic' as const, conversationId: 'customer-a' }
const account = { workspaceId: 'work', platform: 'generic' as const }
const authorityId = 'a'.repeat(64)
const request = {
  kind: 'manual' as const,
  input: {
    scope,
    sourceId: '11111111-1111-4111-8111-111111111111',
    content: {
      kind: 'lesson' as const,
      scenario: '核对订单',
      guidance: '先确认订单号',
      rationale: '',
      steps: [],
      pitfalls: [],
      verification: []
    },
    reason: '员工明确教导'
  }
}
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function fixture() {
  let now = 1770000000000,
    online = true,
    owner = authorityId,
    loseResponse = false,
    available = true
  const ledger = new Ledger(':memory:', now),
    memory = new LearningStore(':memory:', () => now)
  const binding: LearningSubmissionBinding = {
    scope: account,
    get authorityId() {
      return owner
    },
    settings: async () => {
      if (!online) throw new Error('offline')
      return memory.settings(scope)
    },
    episode: async (_scope: typeof scope, id: string) => memory.episode(scope, id),
    apply: async (value: LearningSubmissionRequest) => {
      if (!online) throw new Error('offline')
      if (value.kind !== 'manual') throw new Error('unexpected_fixture_operation')
      const { scope: selected, ...input } = value.input
      const result = memory.teach(selected, input)
      if (loseResponse) {
        loseResponse = false
        throw new Error('response_lost_after_commit')
      }
      return result
    }
  }
  const make = () =>
    new LearningSubmissionSync(ledger.learningSubmissions, {
      resolve: () => (available ? binding : undefined),
      now: () => now
    })
  const sync = make()
  cleanups.push(async () => {
    await sync?.stop()
    memory.close()
    ledger.close()
  })
  return {
    ledger,
    memory,
    sync,
    binding,
    make,
    offline: () => {
      online = false
    },
    online: () => {
      online = true
    },
    loseResponse: () => {
      loseResponse = true
    },
    owner: (next: string) => {
      owner = next
    },
    revoke: () => {
      available = false
    },
    advance: (ms: number) => {
      now += ms
    },
    now: () => now
  }
}

describe('host-owned window learning synchronization', () => {
  it('expires trusted timestamp metadata during idle sync even without a pending submission or authority', async () => {
    const f = fixture()
    const episode = f.memory.recordEpisode(scope, {
      sourceId: 'idle-source',
      topic: '来源',
      startedAt: f.now(),
      messages: [],
      outcome: 'unknown'
    })
    f.sync.observeEpisode(episode)
    f.ledger.learningSubmissions.setRetention(scope, 7)
    f.advance(8 * 86400000)
    f.revoke()
    await f.sync.flush()
    expect(f.ledger.learningSubmissions.episodeTime(scope, episode.id)).toBeUndefined()
  })
  it('accepts offline correction only for a previously observed trusted episode and keeps original age', async () => {
    const f = fixture()
    const episode = f.memory.recordEpisode(scope, {
      sourceId: 'actual-draft',
      topic: '订单',
      startedAt: f.now() - 86400000,
      messages: [],
      draft: '旧答复',
      outcome: 'unknown'
    })
    f.sync.observeEpisode(episode)
    f.binding.episode = async () => {
      throw new Error('offline')
    }
    f.offline()
    const correction = {
      kind: 'correct' as const,
      input: {
        scope,
        episodeId: episode.id,
        sourceId: request.input.sourceId,
        text: '先核对订单',
        reason: '真实纠正'
      }
    }
    expect(await f.sync.submit(correction)).toMatchObject({
      state: 'pending',
      evidenceAt: episode.startedAt
    })
    expect(f.ledger.learningSubmissions.pending(scope, authorityId, f.now())[0].input).toEqual(
      correction.input
    )
    await expect(
      f.sync.submit({ ...correction, input: { ...correction.input, episodeId: 'unobserved' } })
    ).rejects.toThrow()
  })

  it('keeps an offline submission pending and applies the original source once after recovery', async () => {
    const f = fixture()
    f.offline()
    expect(await f.sync.submit(request)).toMatchObject({
      state: 'pending',
      errorCode: 'network_unavailable'
    })
    expect(f.memory.list(scope)).toEqual([])
    f.online()
    await f.sync.flush()
    expect(f.ledger.learningSubmissions.receipts(scope, authorityId)).toMatchObject([
      { state: 'saved' }
    ])
    expect(f.ledger.learningSubmissions.receipts(scope, authorityId)[0].errorCode).toBeUndefined()
    expect(f.memory.list(scope)).toHaveLength(1)
    expect(await f.sync.submit(request)).toMatchObject({ state: 'saved' })
    expect(f.memory.episodes(scope)).toHaveLength(1)
  })

  it('recovers a lost response using the existing authoritative method instead of teaching again', async () => {
    const f = fixture()
    f.loseResponse()
    expect(await f.sync.submit(request)).toMatchObject({ state: 'pending' })
    const original = f.memory.list(scope)[0].id
    await f.sync.stop()
    const recovered = f.make()
    cleanups.push(() => recovered.stop())
    await recovered.flush()
    expect(f.memory.list(scope).map((value) => value.id)).toEqual([original])
    expect(f.memory.episodes(scope)).toHaveLength(1)
    expect(f.ledger.learningSubmissions.receipts(scope, authorityId)[0].state).toBe('saved')
  })

  it('refuses a forged account before writing a private intent or invoking learning', async () => {
    const f = fixture()
    await expect(
      f.sync.submit({
        ...request,
        input: { ...request.input, scope: { ...scope, workspaceId: 'foreign' } }
      })
    ).rejects.toThrow('learning_scope_unavailable')
    expect(f.ledger.learningSubmissions.receipts(scope, authorityId)).toEqual([])
    expect(f.memory.list(scope)).toEqual([])
  })

  it('does not acknowledge an old device response after the host binding changes', async () => {
    const f = fixture()
    let entered!: () => void, release!: () => void
    const ready = new Promise<void>((resolve) => {
      entered = resolve
    })
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const apply = f.binding.apply
    f.binding.apply = async (value, signal) => {
      const result = await apply(value, signal)
      entered()
      await held
      return result
    }
    const submitted = f.sync.submit(request)
    const rejected = expect(submitted).rejects.toThrow('learning_scope_unavailable')
    await ready
    f.owner('b'.repeat(64))
    release()
    await rejected
    expect(f.ledger.learningSubmissions.receipts(scope, authorityId)[0].state).toBe('pending')
    await f.sync.flush()
    expect(f.ledger.learningSubmissions.receipts(scope, authorityId)[0].state).toBe('pending')
    expect(f.memory.list(scope)).toHaveLength(1)
  })

  it('joins cancellation of a held request and never acknowledges it after stopping', async () => {
    const f = fixture()
    let entered!: () => void
    const ready = new Promise<void>((resolve) => {
      entered = resolve
    })
    f.binding.settings = (_scope: unknown, signal: AbortSignal) =>
      new Promise((_resolve, reject) => {
        entered()
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
      })
    const submitted = f.sync.submit(request)
    const rejected = expect(submitted).rejects.toThrow('learning_scope_unavailable')
    await ready
    await f.sync.stop()
    await rejected
    expect(f.ledger.learningSubmissions.receipts(scope, authorityId)[0].state).toBe('pending')
    expect(f.memory.list(scope)).toEqual([])
  })

  it('rechecks current retention before replaying and clears an expired offline intent', async () => {
    const f = fixture()
    f.offline()
    await f.sync.submit(request)
    f.advance(91 * 86400000)
    f.online()
    await f.sync.flush()
    expect(f.memory.list(scope)).toEqual([])
    expect(f.ledger.learningSubmissions.receipts(scope, authorityId)[0].state).toBe('forgotten')
  })

  it.each([
    { knownDays: undefined, ageDays: 366 },
    { knownDays: 7, ageDays: 8 }
  ])(
    'clears expired private intents without current account authority (%j)',
    async ({ knownDays, ageDays }) => {
      const f = fixture()
      f.offline()
      await f.sync.submit(request)
      if (knownDays !== undefined) f.ledger.learningSubmissions.setRetention(scope, knownDays)
      f.revoke()
      f.advance(ageDays * 86400000)
      await f.sync.flush()
      expect(f.memory.list(scope)).toEqual([])
      expect(f.ledger.learningSubmissions.receipts(scope, authorityId)[0].state).toBe('forgotten')
    }
  )
})
