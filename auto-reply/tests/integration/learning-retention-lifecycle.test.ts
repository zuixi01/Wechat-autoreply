import { afterEach, describe, expect, it, vi } from 'vitest'
import { LearningStore } from '../../src/core/memory/learning-store'
import { LearningService } from '../../src/main/services/learning-service'

const stores: LearningStore[] = [],
  services: LearningService[] = []
afterEach(() => {
  services.splice(0).forEach((service) => service.stop())
  stores.splice(0).forEach((store) => store.close())
  vi.useRealTimers()
})
const scope = { workspaceId: 'profile', platform: 'wechat' as const }
describe('retention in the desktop service lifecycle', () => {
  it('removes already expired data when the service starts and releases both timers on stop', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const store = new LearningStore(':memory:')
    stores.push(store)
    store.recordEpisode(scope, {
      sourceId: 'old',
      topic: '投诉',
      startedAt: 1000,
      messages: [],
      outcome: 'corrected'
    })
    vi.setSystemTime(1000 + 91 * 86400000)
    const service = new LearningService(
      store,
      { review: async () => ({ operations: [], usage: { inputTokens: 0, outputTokens: 0 } }) },
      { workspaceId: 'profile' }
    )
    services.push(service)
    service.start()
    expect(store.episodes(scope)).toEqual([])
    service.stop()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('cleans cases reaching expiry while the application stays open', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const store = new LearningStore(':memory:')
    stores.push(store)
    store.recordEpisode(scope, {
      sourceId: 'old',
      topic: '投诉',
      startedAt: 1000,
      messages: [],
      outcome: 'corrected'
    })
    vi.setSystemTime(1000 + 90 * 86400000 - 1800000)
    const service = new LearningService(
      store,
      { review: async () => ({ operations: [], usage: { inputTokens: 0, outputTokens: 0 } }) },
      { workspaceId: 'profile' }
    )
    services.push(service)
    service.start()
    expect(store.episodes(scope)).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(3600000)
    expect(store.episodes(scope)).toEqual([])
  })
})
