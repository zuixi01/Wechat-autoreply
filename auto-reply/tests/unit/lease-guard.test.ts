import { describe, expect, it } from 'vitest'
import { LeaseGuard, type LeaseGrant } from '../../src/core/agent/lease-guard'
import { taskFixture } from '../fixtures/task'

function fixture() {
  let elapsed = 1000
  const guard = new LeaseGuard(() => elapsed)
  const grant: LeaseGrant = {
    identity: taskFixture().task.identity,
    leaseId: 'lease-A',
    version: 1,
    serverIssuedAt: 200000,
    expiresAt: 210000
  }
  return {
    guard,
    grant,
    time: (value: number) => {
      elapsed = value
    }
  }
}
describe('monotonic account lease guard', () => {
  it('charges network time against the usable lifetime', () => {
    const f = fixture()
    const request = f.guard.beginRequest()
    f.time(4000)
    expect(f.guard.accept(f.grant, request)).toBe(true)
    f.time(10749)
    expect(f.guard.valid(f.grant.identity, 1)).toBe(true)
    f.time(10750)
    expect(f.guard.valid(f.grant.identity, 1)).toBe(false)
  })
  it('refuses a response whose entire lifetime was spent in transit', () => {
    const f = fixture()
    const request = f.guard.beginRequest()
    f.time(12000)
    expect(f.guard.accept(f.grant, request)).toBe(false)
  })
  it('does not revive a grant after loss of connection, pause or suspend invalidates it', () => {
    const f = fixture()
    const request = f.guard.beginRequest()
    f.guard.invalidate()
    expect(f.guard.accept(f.grant, request)).toBe(false)
  })
  it('binds the lease to full account, employee, login epoch and client instance', () => {
    const f = fixture()
    f.guard.accept(f.grant, f.guard.beginRequest())
    expect(f.guard.valid({ ...f.grant.identity, accountId: 'B' }, 1)).toBe(false)
    expect(f.guard.valid({ ...f.grant.identity, loginEpoch: 2 }, 1)).toBe(false)
    expect(f.guard.valid(f.grant.identity, 2)).toBe(false)
  })
  it('rejects late lower-version grants and unsupported grant lifetimes', () => {
    const f = fixture()
    f.guard.accept({ ...f.grant, version: 2 }, f.guard.beginRequest())
    expect(f.guard.accept(f.grant, f.guard.beginRequest())).toBe(false)
    expect(
      f.guard.accept(
        { ...f.grant, expiresAt: f.grant.serverIssuedAt + 40000 },
        f.guard.beginRequest()
      )
    ).toBe(false)
  })
})
