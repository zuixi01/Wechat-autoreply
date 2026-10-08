import { performance } from 'node:perf_hooks'
import { IdentitySchema, sameIdentity, type Identity } from '../../shared/contracts/identity'
import { LeaseGrantSchema, type LeaseGrant } from '../../shared/contracts/lease'
import { LeaseGuard } from './lease-guard'

export interface LeaseTransport {
  acquireLease(identity: Identity, signal: AbortSignal): Promise<LeaseGrant>
}
export type LeaseSessionStatus = 'stopped' | 'acquiring' | 'active' | 'lost'
export type LeaseLossReason = 'request_failed' | 'expired' | 'invalid_grant'

/** Renewing authority is separate from starting automation. Loss is terminal until explicit start.
 * The sender must consult current() again at the actual dispatch boundary. */
export class LeaseSession {
  private readonly guard: LeaseGuard
  private state: LeaseSessionStatus = 'stopped'
  private generation = 0
  private controller?: AbortController
  private renewal?: ReturnType<typeof setTimeout>
  private expiry?: ReturnType<typeof setTimeout>
  private grant?: LeaseGrant

  constructor(
    private readonly transport: LeaseTransport,
    private readonly onLost: (reason: LeaseLossReason) => void | Promise<void>,
    clock: () => number = () => performance.now()
  ) {
    this.guard = new LeaseGuard(clock)
  }

  status(): LeaseSessionStatus {
    this.current()
    return this.state
  }

  current(): LeaseGrant | undefined {
    if (this.state !== 'active' || !this.grant) return undefined
    if (!this.guard.valid(this.grant.identity, this.grant.version)) {
      this.lose('expired', this.generation)
      return undefined
    }
    return structuredClone(this.grant)
  }

  async start(input: Identity): Promise<LeaseGrant> {
    const identity = IdentitySchema.parse(structuredClone(input))
    this.stop()
    const generation = this.generation
    this.state = 'acquiring'
    this.controller = new AbortController()
    const grant = await this.request(identity, generation)
    if (!grant) throw new Error('lease_unavailable')
    return grant
  }

  stop(): void {
    this.generation++
    this.controller?.abort()
    this.clearTimers()
    this.guard.invalidate()
    this.grant = undefined
    this.state = 'stopped'
  }

  private clearTimers(): void {
    if (this.renewal) clearTimeout(this.renewal)
    if (this.expiry) clearTimeout(this.expiry)
    this.renewal = undefined
    this.expiry = undefined
  }

  private lose(reason: LeaseLossReason, generation: number): void {
    if (generation !== this.generation || this.state === 'lost' || this.state === 'stopped') return
    this.controller?.abort()
    this.clearTimers()
    this.guard.invalidate()
    this.grant = undefined
    this.state = 'lost'
    // An observer failure cannot reopen the local authority gate.
    try {
      void Promise.resolve(this.onLost(reason)).catch(() => {})
    } catch {
      // Local authority was invalidated before notifying the owner.
    }
  }

  private async request(identity: Identity, generation: number): Promise<LeaseGrant | undefined> {
    const parent = this.controller
    if (!parent || parent.signal.aborted || generation !== this.generation) return undefined
    const request = this.guard.beginRequest()
    const attempt = new AbortController()
    const signal = AbortSignal.any([parent.signal, attempt.signal])
    const timeout = setTimeout(() => attempt.abort(), 2500)
    let onAbort!: () => void
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error('lease_request_cancelled'))
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      const value = await Promise.race([this.transport.acquireLease(identity, signal), aborted])
      if (generation !== this.generation) return undefined
      if (signal.aborted) {
        this.lose('request_failed', generation)
        return undefined
      }
      const parsed = LeaseGrantSchema.safeParse(value)
      if (
        !parsed.success ||
        !sameIdentity(parsed.data.identity, identity) ||
        (this.grant &&
          (this.grant.version !== parsed.data.version ||
            this.grant.leaseId !== parsed.data.leaseId)) ||
        !this.guard.accept(parsed.data, request)
      ) {
        this.lose('invalid_grant', generation)
        return undefined
      }
      this.grant = structuredClone(parsed.data)
      this.state = 'active'
      this.clearTimers()
      const remaining = this.guard.remainingMs(identity, parsed.data.version)
      this.expiry = setTimeout(() => this.lose('expired', generation), remaining)
      this.renewal = setTimeout(
        () => {
          void this.request(identity, generation)
        },
        Math.min(2000, Math.max(1, Math.floor(remaining / 3)))
      )
      return structuredClone(parsed.data)
    } catch {
      this.lose('request_failed', generation)
      return undefined
    } finally {
      clearTimeout(timeout)
      signal.removeEventListener('abort', onAbort)
    }
  }
}
