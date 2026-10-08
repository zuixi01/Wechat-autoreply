import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConversationScheduler } from '../../src/core/reply/scheduler'

afterEach(() => vi.useRealTimers())
describe('bounded conversation scheduling', () => {
  it('preserves a queued burst deadline and capacity during collection interruption', async () => {
    vi.useFakeTimers()
    const work = vi.fn(async () => 'draft'),
      apply = vi.fn(async () => {}),
      onError = vi.fn()
    const scheduler = new ConversationScheduler<string>({
      quietMs: 100,
      maximumWaitMs: 300,
      maximumConversations: 1,
      onError
    })
    scheduler.resume()
    scheduler.submit('A', work, apply)
    await vi.advanceTimersByTimeAsync(80)
    scheduler.interrupt('A')
    scheduler.submit('B', work, apply)
    expect(onError).toHaveBeenCalledExactlyOnceWith('B', 'queue_overloaded')
    await vi.advanceTimersByTimeAsync(160)
    expect(work).not.toHaveBeenCalled()
    scheduler.submit('A', work, apply)
    await vi.advanceTimersByTimeAsync(60)
    expect(work).toHaveBeenCalledOnce()
    scheduler.pause()
  })

  it('explicit cancellation discards an interrupted burst deadline and capacity', async () => {
    vi.useFakeTimers()
    const work = vi.fn(async () => 'draft'),
      apply = vi.fn(async () => {}),
      onError = vi.fn()
    const scheduler = new ConversationScheduler<string>({
      quietMs: 100,
      maximumWaitMs: 300,
      maximumConversations: 1,
      onError
    })
    scheduler.resume()
    scheduler.submit('A', work, apply)
    await vi.advanceTimersByTimeAsync(80)
    scheduler.interrupt('A')
    scheduler.cancel('A')
    await vi.advanceTimersByTimeAsync(160)
    scheduler.submit('A', work, apply)
    await vi.advanceTimersByTimeAsync(60)
    expect(work).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(40)
    expect(work).toHaveBeenCalledOnce()
    expect(onError).not.toHaveBeenCalled()
    scheduler.pause()
  })

  it('caps unique pending conversations while allowing an existing conversation to update', async () => {
    vi.useFakeTimers()
    const onError = vi.fn(),
      work = vi.fn(async () => 'draft'),
      apply = vi.fn(async () => {})
    const scheduler = new ConversationScheduler<string>({
      quietMs: 10,
      maximumWaitMs: 50,
      maximumConversations: 2,
      onError
    })
    scheduler.resume()
    scheduler.submit('A', work, apply)
    scheduler.submit('B', work, apply)
    scheduler.submit('C', work, apply)
    scheduler.submit('A', work, apply)
    expect(onError).toHaveBeenCalledExactlyOnceWith('C', 'queue_overloaded')
    await vi.advanceTimersByTimeAsync(10)
    expect(work).toHaveBeenCalledTimes(2)
    scheduler.pause()
  })
  it('counts non-cooperating old generations against concurrency after pause/resume', async () => {
    vi.useFakeTimers()
    let finish!: (value: string) => void
    const gate = new Promise<string>((resolve) => {
        finish = resolve
      }),
      apply = vi.fn(async () => {}),
      next = vi.fn(async () => 'new')
    const scheduler = new ConversationScheduler<string>({
      concurrency: 1,
      quietMs: 0,
      maximumWaitMs: 0
    })
    scheduler.resume()
    scheduler.submit('A', async () => gate, apply)
    await vi.advanceTimersByTimeAsync(0)
    scheduler.pause()
    scheduler.resume()
    scheduler.submit('B', next, apply)
    await vi.advanceTimersByTimeAsync(10)
    expect(next).not.toHaveBeenCalled()
    finish('late')
    await vi.advanceTimersByTimeAsync(1)
    expect(next).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledExactlyOnceWith('new', expect.anything())
    scheduler.pause()
  })
})
