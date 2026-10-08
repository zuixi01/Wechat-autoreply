import { performance } from 'node:perf_hooks'
import { type Identity } from '../../shared/contracts/identity'
import { sameIdentity } from '../../shared/contracts/identity'
import { LeaseGrantSchema, type LeaseGrant } from '../../shared/contracts/lease'
export { LeaseGrantSchema, type LeaseGrant } from '../../shared/contracts/lease'

/** Request-start monotonic time conservatively includes network time in the validity budget. */
export class LeaseGuard {
  private grant?: LeaseGrant
  private deadline = 0
  private generation = 0
  constructor(
    private readonly clock: () => number = () => performance.now(),
    private readonly safetyMarginMs = 250
  ) {
    if (!Number.isFinite(safetyMarginMs) || safetyMarginMs < 0)
      throw new Error('invalid_lease_margin')
  }
  beginRequest(): { startedAt: number; generation: number } {
    return { startedAt: this.clock(), generation: this.generation }
  }
  accept(input: LeaseGrant, request: { startedAt: number; generation: number }): boolean {
    const parsed = LeaseGrantSchema.safeParse(input)
    if (
      !parsed.success ||
      request.generation !== this.generation ||
      !Number.isFinite(request.startedAt) ||
      request.startedAt > this.clock()
    )
      return false
    const grant = structuredClone(parsed.data)
    const deadline =
      request.startedAt + (grant.expiresAt - grant.serverIssuedAt) - this.safetyMarginMs
    if (deadline <= this.clock() || (this.grant && grant.version < this.grant.version)) return false
    this.grant = grant
    this.deadline = deadline
    return true
  }
  valid(identity: Identity, version: number): boolean {
    return Boolean(
      this.grant &&
      sameIdentity(this.grant.identity, identity) &&
      this.grant.version === version &&
      this.clock() < this.deadline
    )
  }
  remainingMs(identity: Identity, version: number): number {
    return this.valid(identity, version) ? Math.max(0, this.deadline - this.clock()) : 0
  }
  invalidate(): void {
    this.generation++
    this.grant = undefined
    this.deadline = 0
  }
}
