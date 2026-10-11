import { expect, it } from 'vitest'
import { ForegroundGenerationGate } from '../../src/core/agent/foreground-generation-gate'

it('bounds generation to two slots, removes aborted waiters and releases failed operations', async () => {
  const gate = new ForegroundGenerationGate(2)
  const signal = new AbortController().signal
  const releases: (() => void)[] = []
  let active = 0,
    peak = 0
  const job = () =>
    gate.run(signal, async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise<void>((resolve) => releases.push(resolve))
      active--
    })
  const first = job(),
    second = job()
  const cancelled = new AbortController()
  const aborted = gate.run(cancelled.signal, async () => {
    throw new Error('must_not_run')
  })
  cancelled.abort()
  await expect(aborted).rejects.toThrow('cancelled')
  const third = job()
  expect(releases).toHaveLength(2)
  releases[0]()
  await first
  await Promise.resolve()
  expect(releases).toHaveLength(3)
  releases[1]()
  releases[2]()
  await Promise.all([second, third])
  expect(peak).toBe(2)
  await expect(
    gate.run(signal, async () => {
      throw new Error('model_network_failed')
    })
  ).rejects.toThrow('model_network_failed')
  await expect(gate.run(signal, async () => 'next')).resolves.toBe('next')
})
