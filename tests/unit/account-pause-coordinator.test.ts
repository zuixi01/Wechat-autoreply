import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { AccountPauseCoordinator } from '../../src/main/services/account-pause-coordinator'
import type { AgentRegistration } from '../../src/main/services/agent-registration'
import type {
  AccountPauseChallenge,
  AccountPauseReport
} from '../../src/shared/contracts/runtime-pause'
import type { DeviceStatus } from '../../src/shared/contracts/registration'
import { hashContext } from '../../src/core/reply/hashes'

const scope = {
  tenant_id: 'A',
  account_id: 'account',
  agent_id: 'agent',
  employee_id: 'employee',
  platform: 'wework' as const
}
const coordinators: AccountPauseCoordinator[] = []
afterEach(async () => {
  for (const coordinator of coordinators.splice(0)) await coordinator.stop()
  vi.useRealTimers()
})
function fixture() {
  vi.useFakeTimers()
  let generation = 0,
    available = true,
    device: DeviceStatus = { state: 'registered', scope, serverUrl: 'https://example.test' }
  const instanceId = randomUUID(),
    order: string[] = [],
    changed = vi.fn(),
    nextEpoch = vi.fn(() => 5)
  const challenge = vi.fn<AgentRegistration['accountPauseChallenge']>(async (input) => {
    order.push('challenge')
    return {
      ...input,
      purpose: 'account_pause',
      challengeId: randomUUID(),
      scope,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 30000
    }
  })
  const confirm = vi.fn<AgentRegistration['confirmAccountPause']>(async (report) => ({
    requestId: report.challenge.requestId,
    challengeId: report.challenge.challengeId,
    reportHash: hashContext(report),
    receivedAt: Date.now(),
    status: 'runtime_stop_confirmation_recorded',
    physicalStopVerified: false,
    canAuthorizeSend: false
  }))
  const pause = vi.fn(async () => {
    order.push('pause')
    generation++
    return {
      state: 'paused' as const,
      reason: 'user_pause' as const,
      lease: 'stopped' as const,
      pauseAcknowledged: true
    }
  })
  const evidence = (): AccountPauseReport['stopped'] | undefined =>
    available
      ? {
          observerStopped: true,
          senderQuiescent: true,
          settlementQuiescent: true,
          leaseStopped: true,
          platform: 'absent'
        }
      : undefined
  const coordinator = new AccountPauseCoordinator(
    { status: () => device, accountPauseChallenge: challenge, confirmAccountPause: confirm },
    pause,
    () => ({ instanceId, generation }),
    evidence,
    nextEpoch,
    changed
  )
  coordinators.push(coordinator)
  return {
    coordinator,
    challenge,
    confirm,
    pause,
    changed,
    nextEpoch,
    order,
    instanceId,
    requestId: randomUUID(),
    device: (next: DeviceStatus) => {
      device = next
    },
    available: (value: boolean) => {
      available = value
    },
    mutate: () => {
      generation++
    }
  }
}
describe('purpose-bound local pause coordination', () => {
  it('pauses synchronously before network access, confirms quiescence once, and does not reuse a changed generation', async () => {
    const f = fixture()
    f.coordinator.observe(f.requestId)
    expect(f.order).toEqual(['pause', 'challenge'])
    await vi.advanceTimersByTimeAsync(0)
    expect(f.confirm).toHaveBeenCalledOnce()
    expect(f.changed).toHaveBeenCalledOnce()
    expect(f.confirm.mock.calls[0][0]).toMatchObject({
      challenge: { runtime: { instanceId: f.instanceId, generation: 1 }, instanceEpoch: 5 },
      stopped: { platform: 'absent' }
    })
    f.coordinator.observe(f.requestId)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.pause).toHaveBeenCalledOnce()
    f.mutate()
    f.coordinator.observe(f.requestId)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.confirm).toHaveBeenCalledTimes(2)
    expect(f.confirm.mock.calls[1][0].challenge.runtime.generation).toBe(3)
  })
  it('keeps ambiguous quiescence pending and retries after evidence becomes available', async () => {
    const f = fixture()
    f.available(false)
    f.coordinator.observe(f.requestId)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.confirm).not.toHaveBeenCalled()
    expect(f.changed).not.toHaveBeenCalled()
    f.available(true)
    f.coordinator.observe(f.requestId)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.confirm).toHaveBeenCalledOnce()
  })
  it('drops queued old-account requests before they can pause a new account', async () => {
    const f = fixture()
    f.challenge.mockImplementation(() => new Promise(() => {}))
    f.coordinator.observe(f.requestId)
    f.coordinator.observe(randomUUID())
    f.device({
      state: 'registered',
      scope: { ...scope, account_id: 'other' },
      serverUrl: 'https://example.test'
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.pause).toHaveBeenCalledOnce()
    expect(f.confirm).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('coalesces receipts and bounds an uncooperative request', async () => {
    const f = fixture()
    f.challenge.mockImplementation(() => new Promise(() => {}))
    f.coordinator.observe(f.requestId)
    for (let n = 0; n < 10; n++) f.coordinator.observe(f.requestId)
    expect(f.pause).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(10000)
    expect(f.challenge.mock.calls[0][1]?.aborted).toBe(true)
    expect(f.confirm).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('joins shutdown and discards a late challenge without sending a confirmation', async () => {
    const f = fixture()
    let finish!: (value: AccountPauseChallenge) => void
    f.challenge.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    f.coordinator.observe(f.requestId)
    const input = f.challenge.mock.calls[0][0]
    await f.coordinator.stop()
    finish({
      ...input,
      purpose: 'account_pause',
      scope,
      challengeId: randomUUID(),
      issuedAt: Date.now(),
      expiresAt: Date.now() + 30000
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.confirm).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('rejects a foreign challenge or changed runtime instead of publishing old evidence', async () => {
    const f = fixture()
    f.challenge.mockImplementation(async (input) => {
      f.mutate()
      return {
        ...input,
        purpose: 'account_pause',
        scope: { ...scope, agent_id: 'other' },
        challengeId: randomUUID(),
        issuedAt: Date.now(),
        expiresAt: Date.now() + 30000
      }
    })
    f.coordinator.observe(f.requestId)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.confirm).not.toHaveBeenCalled()
  })
  it('requires an exact acknowledgment before caching completion', async () => {
    const f = fixture()
    f.confirm.mockImplementation(async (report) => ({
      requestId: report.challenge.requestId,
      challengeId: report.challenge.challengeId,
      reportHash: 'f'.repeat(64),
      receivedAt: Date.now(),
      status: 'runtime_stop_confirmation_recorded',
      physicalStopVerified: false,
      canAuthorizeSend: false
    }))
    f.coordinator.observe(f.requestId)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.changed).not.toHaveBeenCalled()
    f.coordinator.observe(f.requestId)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.pause).toHaveBeenCalledTimes(2)
  })
  it('does not reserve an epoch or act before registration', async () => {
    const f = fixture()
    f.device({ state: 'unregistered' })
    f.coordinator.observe(f.requestId)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.pause).not.toHaveBeenCalled()
    expect(f.challenge).not.toHaveBeenCalled()
    expect(f.nextEpoch).not.toHaveBeenCalled()
  })
})
