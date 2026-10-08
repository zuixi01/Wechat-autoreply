import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeStatusReporter } from '../../src/main/services/runtime-status-reporter'
import type { AgentRegistration } from '../../src/main/services/agent-registration'
import type { DeviceStatus } from '../../src/shared/contracts/registration'
import type { RuntimeStatus } from '../../src/shared/contracts/runtime'
import type { RuntimeObservationReceipt } from '../../src/shared/contracts/runtime-monitoring'
import { hashContext } from '../../src/core/reply/hashes'

const scope = {
  tenant_id: 'A',
  employee_id: 'employee',
  account_id: 'account',
  agent_id: 'agent',
  platform: 'wework' as const
}
const active: RuntimeStatus = {
  state: 'running',
  reason: 'none',
  lease: 'active',
  pauseAcknowledged: false
}
const reporters: RuntimeStatusReporter[] = []
afterEach(async () => {
  for (const reporter of reporters.splice(0)) await reporter.stop()
  vi.useRealTimers()
})
function fixture() {
  vi.useFakeTimers()
  let device: DeviceStatus = { state: 'registered', scope, serverUrl: 'https://example.test' }
  let status = active,
    epoch = 0
  const nextEpoch = vi.fn(() => ++epoch),
    pause = vi.fn()
  const report = vi.fn<AgentRegistration['reportRuntimeStatus']>(async (input) => ({
    scope,
    runtimeEpoch: input.runtimeEpoch,
    sequence: input.sequence,
    reportHash: hashContext(input),
    receivedAt: Date.now(),
    serverPaused: false,
    canAuthorizeSend: false
  }))
  const reporter = new RuntimeStatusReporter(
    { status: () => device, reportRuntimeStatus: report },
    () => status,
    nextEpoch,
    pause
  )
  reporters.push(reporter)
  return {
    reporter,
    report,
    pause,
    nextEpoch,
    device: (next: DeviceStatus) => {
      device = next
    },
    status: (next: RuntimeStatus) => {
      status = next
    }
  }
}
describe('bounded private runtime reporting', () => {
  it('does not reserve an epoch or collect status before device registration', async () => {
    const f = fixture()
    f.device({ state: 'unregistered' })
    f.reporter.start()
    await vi.advanceTimersByTimeAsync(15000)
    expect(f.report).not.toHaveBeenCalled()
    expect(f.nextEpoch).not.toHaveBeenCalled()
  })
  it('publishes only metadata, advances sequence, and stop removes recurring timers', async () => {
    const f = fixture()
    f.reporter.start()
    f.reporter.start()
    await vi.advanceTimersByTimeAsync(5000)
    expect(f.report.mock.calls.map(([input]) => [input.runtimeEpoch, input.sequence])).toEqual([
      [1, 1],
      [1, 2]
    ])
    expect(f.nextEpoch).toHaveBeenCalledOnce()
    expect(f.report.mock.calls[0][0]).toEqual({ runtimeEpoch: 1, sequence: 1, status: active })
    await f.reporter.stop()
    await vi.advanceTimersByTimeAsync(20000)
    expect(f.report).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('times out a transport that ignores abort without overlapping requests', async () => {
    const f = fixture()
    f.report.mockImplementation(() => new Promise(() => {}))
    f.reporter.start()
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < 20; i++) f.reporter.wake()
    expect(f.report).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(2500)
    expect(f.report.mock.calls[0][1]?.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(f.report).toHaveBeenCalledTimes(2)
    await f.reporter.stop()
    expect(f.report.mock.calls[1][1]?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('ignores late receipts after stop, even when the transport remains unresolved', async () => {
    const f = fixture()
    let resolve!: (value: RuntimeObservationReceipt) => void
    f.report.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r
        })
    )
    f.reporter.start()
    await vi.advanceTimersByTimeAsync(0)
    await f.reporter.stop()
    resolve({
      scope,
      runtimeEpoch: 1,
      sequence: 1,
      reportHash: 'a'.repeat(64),
      receivedAt: Date.now(),
      serverPaused: true,
      canAuthorizeSend: false
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.pause).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('ignores receipts from the previous binding and reserves a fresh durable epoch', async () => {
    const f = fixture()
    let resolve!: (value: RuntimeObservationReceipt) => void
    f.report.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r
        })
    )
    f.reporter.start()
    await vi.advanceTimersByTimeAsync(0)
    f.device({
      state: 'registered',
      scope: { ...scope, account_id: 'other' },
      serverUrl: 'https://example.test'
    })
    resolve({
      scope,
      runtimeEpoch: 1,
      sequence: 1,
      reportHash: 'a'.repeat(64),
      receivedAt: Date.now(),
      serverPaused: true,
      canAuthorizeSend: false
    })
    await vi.advanceTimersByTimeAsync(5000)
    expect(f.pause).not.toHaveBeenCalled()
    expect(f.nextEpoch).toHaveBeenCalledTimes(2)
    expect(f.report.mock.calls[1][0]).toMatchObject({ runtimeEpoch: 2, sequence: 1 })
  })
  it.each(['running', 'starting'] as const)('central pause stops a %s runtime', async (state) => {
    const f = fixture()
    f.status({ ...active, state })
    f.report.mockImplementation(async (input) => ({
      scope,
      runtimeEpoch: input.runtimeEpoch,
      sequence: input.sequence,
      reportHash: hashContext(input),
      receivedAt: Date.now(),
      serverPaused: true,
      canAuthorizeSend: false
    }))
    f.reporter.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.pause).toHaveBeenCalledOnce()
  })
  it('does not resume a paused runtime when the server clears its pause', async () => {
    const f = fixture()
    f.status({ state: 'paused', reason: 'user_pause', lease: 'stopped', pauseAcknowledged: true })
    f.reporter.start()
    await vi.advanceTimersByTimeAsync(5000)
    expect(f.pause).not.toHaveBeenCalled()
  })
})
