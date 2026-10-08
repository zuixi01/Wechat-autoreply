import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LeaseSession, type LeaseTransport } from '../../src/core/agent/lease-session'
import { taskFixture } from '../fixtures/task'
import type { LeaseGrant } from '../../src/shared/contracts/lease'

describe('renewing desktop lease session', () => {
  const sessions: LeaseSession[] = []
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    for (const session of sessions.splice(0)) session.stop()
    vi.useRealTimers()
  })
  function fixture(lifetime = 10000) {
    let elapsed = 0
    const identity = taskFixture().task.identity
    const grant: LeaseGrant = {
      identity,
      leaseId: 'lease-A',
      version: 1,
      serverIssuedAt: 500000,
      expiresAt: 500000 + lifetime
    }
    const transport = {
      acquireLease: vi.fn<LeaseTransport['acquireLease']>().mockImplementation(async () => grant)
    }
    const lost = vi.fn()
    const session = new LeaseSession(transport, lost, () => elapsed)
    sessions.push(session)
    return {
      identity,
      grant,
      transport,
      lost,
      session,
      advance: async (ms: number) => {
        elapsed += ms
        await vi.advanceTimersByTimeAsync(ms)
      },
      setClock: (value: number) => {
        elapsed = value
      }
    }
  }
  it('starts explicitly and renews the same login identity with no overlapping requests', async () => {
    const f = fixture()
    expect(f.session.current()).toBeUndefined()
    await f.session.start(f.identity)
    expect(f.session.status()).toBe('active')
    let finish!: (grant: LeaseGrant) => void
    f.transport.acquireLease.mockImplementationOnce(
      () =>
        new Promise((r) => {
          finish = r
        })
    )
    await f.advance(2000)
    expect(f.transport.acquireLease).toHaveBeenCalledTimes(2)
    await f.advance(1500)
    expect(f.transport.acquireLease).toHaveBeenCalledTimes(2)
    finish(f.grant)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.session.current()?.version).toBe(1)
    expect(f.lost).not.toHaveBeenCalled()
  })
  it('closes on network failure and never silently reacquires', async () => {
    const f = fixture()
    await f.session.start(f.identity)
    f.transport.acquireLease.mockRejectedValueOnce(new Error('private network details'))
    await f.advance(2000)
    expect(f.session.current()).toBeUndefined()
    expect(f.session.status()).toBe('lost')
    expect(f.lost).toHaveBeenCalledExactlyOnceWith('request_failed')
    await f.advance(30000)
    expect(f.transport.acquireLease).toHaveBeenCalledTimes(2)
    await f.session.start(f.identity)
    expect(f.session.current()).toBeDefined()
  })
  it('times out an uncooperative request and ignores its late response', async () => {
    const f = fixture()
    await f.session.start(f.identity)
    let finish!: (grant: LeaseGrant) => void
    f.transport.acquireLease.mockImplementationOnce(
      () =>
        new Promise((r) => {
          finish = r
        })
    )
    await f.advance(2000)
    await f.advance(2500)
    expect(f.session.status()).toBe('lost')
    finish(f.grant)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.session.current()).toBeUndefined()
    expect(f.lost).toHaveBeenCalledTimes(1)
  })
  it('checks monotonic expiry immediately after a suspended event loop', async () => {
    const f = fixture()
    await f.session.start(f.identity)
    f.setClock(9750)
    expect(f.session.current()).toBeUndefined()
    expect(f.lost).toHaveBeenCalledExactlyOnceWith('expired')
  })
  it('expires before a slow renewal can return even when its request timeout is later', async () => {
    const f = fixture(1000)
    await f.session.start(f.identity)
    let finish!: (grant: LeaseGrant) => void
    f.transport.acquireLease.mockImplementationOnce(
      () =>
        new Promise((r) => {
          finish = r
        })
    )
    await f.advance(250)
    await f.advance(500)
    expect(f.session.status()).toBe('lost')
    expect(f.lost).toHaveBeenCalledExactlyOnceWith('expired')
    finish(f.grant)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.session.current()).toBeUndefined()
  })
  it('rejects a renewed lease for a different account, version or lease id', async () => {
    for (const change of [
      { identity: { ...taskFixture().task.identity, accountId: 'other' } },
      { version: 2 },
      { leaseId: 'other-lease' }
    ]) {
      const f = fixture()
      await f.session.start(f.identity)
      f.transport.acquireLease.mockResolvedValueOnce({ ...f.grant, ...change })
      await f.advance(2000)
      expect(f.session.status()).toBe('lost')
      expect(f.lost).toHaveBeenCalledExactlyOnceWith('invalid_grant')
      f.session.stop()
    }
  })
  it('stopping during initial acquisition aborts promptly and never emits a loss', async () => {
    const f = fixture()
    f.transport.acquireLease.mockReturnValue(new Promise(() => {}))
    const pending = expect(f.session.start(f.identity)).rejects.toThrow('lease_unavailable')
    f.session.stop()
    await pending
    expect(f.session.status()).toBe('stopped')
    expect(f.lost).not.toHaveBeenCalled()
  })
  it('restarting cannot be invalidated by the previous in-flight response', async () => {
    const f = fixture()
    let finish!: (grant: LeaseGrant) => void
    f.transport.acquireLease.mockImplementationOnce(
      () =>
        new Promise((r) => {
          finish = r
        })
    )
    const old = expect(f.session.start(f.identity)).rejects.toThrow('lease_unavailable')
    const newIdentity = { ...f.identity, loginEpoch: f.identity.loginEpoch + 1 }
    f.transport.acquireLease.mockResolvedValueOnce({
      ...f.grant,
      identity: newIdentity,
      version: 2
    })
    await f.session.start(newIdentity)
    finish(f.grant)
    await old
    expect(f.session.current()?.identity).toEqual(newIdentity)
    expect(f.lost).not.toHaveBeenCalled()
  })
  it('keeps the gate closed when a loss notification itself fails', async () => {
    const f = fixture()
    f.lost.mockRejectedValue(new Error('observer failed'))
    await f.session.start(f.identity)
    f.setClock(20000)
    expect(f.session.current()).toBeUndefined()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.session.status()).toBe('lost')
  })
})
