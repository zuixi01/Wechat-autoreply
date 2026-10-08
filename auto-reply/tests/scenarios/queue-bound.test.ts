import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConversationScheduler } from '../../src/core/reply/scheduler'

afterEach(() => vi.useRealTimers())
describe('default deployed conversation queue under overload', () => {
  it('drains 200 admitted conversations and explicitly hands off the other 100 without running them', async () => {
    vi.useFakeTimers()
    const completed = new Set<string>(),
      rejected = new Set<string>()
    let active = 0,
      peak = 0
    const scheduler = new ConversationScheduler<string>({
      quietMs: 10,
      maximumWaitMs: 30,
      onError: (key, reason) => {
        expect(reason).toBe('queue_overloaded')
        rejected.add(key)
      }
    })
    scheduler.resume()
    try {
      for (let index = 0; index < 300; index++) {
        const key = `synthetic-conversation-${index}`
        scheduler.submit(
          key,
          async () => {
            active++
            peak = Math.max(active, peak)
            expect(rejected.has(key)).toBe(false)
            await new Promise<void>((resolve) => setTimeout(resolve, 3))
            active--
            return key
          },
          async (result) => {
            expect(completed.has(result)).toBe(false)
            completed.add(result)
          }
        )
      }
      expect(rejected.size).toBe(100)
      await vi.advanceTimersByTimeAsync(500)
      expect(peak).toBe(2)
      expect(active).toBe(0)
      expect(completed.size).toBe(200)
      expect(new Set([...completed, ...rejected]).size).toBe(300)
      expect([...completed].some((key) => rejected.has(key))).toBe(false)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      scheduler.pause()
    }
  })
})
