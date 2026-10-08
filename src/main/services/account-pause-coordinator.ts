import { randomUUID } from 'node:crypto'
import { hashContext } from '../../core/reply/hashes'
import type { AgentRegistration } from './agent-registration'
import type { RuntimeStatus } from '../../shared/contracts/runtime'
import {
  AccountPauseReportSchema,
  AccountPauseAckSchema,
  type RuntimeContext,
  type AccountPauseReport
} from '../../shared/contracts/runtime-pause'

type Client = Pick<AgentRegistration, 'status' | 'accountPauseChallenge' | 'confirmAccountPause'>
/** Produces local quiescence declarations after a fresh purpose-bound challenge, not hardware attestation. */
export class AccountPauseCoordinator {
  private disposed = false
  private work?: Promise<void>
  private controller?: AbortController
  private current?: { requestId: string; binding: string }
  private queued?: { requestId: string; binding: string }
  private completed?: { requestId: string; binding: string; context: string }
  private epoch = 0
  private epochBinding?: string
  constructor(
    private readonly client: Client,
    private readonly pause: () => Promise<RuntimeStatus>,
    private readonly context: () => RuntimeContext,
    private readonly evidence: () => AccountPauseReport['stopped'] | undefined,
    private readonly nextEpoch: () => number,
    private readonly changed: () => void
  ) {}
  observe(requestId: string): void {
    if (this.disposed) return
    const device = this.client.status()
    if (!device.scope || !device.serverUrl) return
    const binding = hashContext({ scope: device.scope, serverUrl: device.serverUrl })
    if (this.work) {
      if (this.current?.requestId !== requestId || this.current.binding !== binding) {
        this.queued = { requestId, binding }
        this.controller?.abort()
      }
      return
    }
    if (
      this.completed?.requestId === requestId &&
      this.completed.binding === binding &&
      this.completed.context === hashContext(this.context())
    )
      return
    this.current = { requestId, binding }
    const work = this.attempt(requestId, binding)
    this.work = work
    const settled = (): void => {
      if (this.work === work) this.work = undefined
      const next = this.queued
      this.queued = undefined
      if (next && !this.disposed) {
        const device = this.client.status()
        if (hashContext({ scope: device.scope, serverUrl: device.serverUrl }) === next.binding)
          this.observe(next.requestId)
      }
    }
    void work.then(settled, settled)
  }
  async stop(): Promise<void> {
    this.disposed = true
    this.queued = undefined
    this.controller?.abort()
    await this.work
  }
  private async race<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
      void work.catch(() => {})
      throw new Error('pause_confirmation_cancelled')
    }
    let abort!: () => void
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(new Error('pause_confirmation_cancelled'))
      signal.addEventListener('abort', abort, { once: true })
    })
    try {
      return await Promise.race([work, cancelled])
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }
  private async attempt(requestId: string, binding: string): Promise<void> {
    const controller = new AbortController()
    this.controller = controller
    const timer = setTimeout(() => controller.abort(), 10000)
    try {
      // Cancellation precedes network access. Even a failed challenge leaves the runtime paused.
      const stopping = this.pause()
      void stopping.catch(() => {})
      const context = this.context(),
        device = this.client.status()
      if (this.epochBinding !== binding) {
        this.epoch = this.nextEpoch()
        this.epochBinding = binding
      }
      const challenge = await this.race(
        this.client.accountPauseChallenge(
          { requestId, attemptId: randomUUID(), runtime: context, instanceEpoch: this.epoch },
          controller.signal
        ),
        controller.signal
      )
      const observedStart = performance.now()
      await this.race(stopping, controller.signal)
      const stopped = this.evidence()
      if (!stopped || !this.valid(binding, context, controller.signal)) return
      if (
        !device.scope ||
        hashContext(challenge.scope) !== hashContext(device.scope) ||
        challenge.requestId !== requestId ||
        hashContext(challenge.runtime) !== hashContext(context) ||
        challenge.instanceEpoch !== this.epoch
      )
        return
      const report = AccountPauseReportSchema.parse({
        challenge,
        elapsedMs: Math.floor(performance.now() - observedStart),
        stopped
      })
      const ack = AccountPauseAckSchema.safeParse(
        await this.race(
          this.client.confirmAccountPause(report, controller.signal),
          controller.signal
        )
      )
      if (
        !ack.success ||
        ack.data.requestId !== challenge.requestId ||
        ack.data.challengeId !== challenge.challengeId ||
        ack.data.reportHash !== hashContext(report)
      )
        return
      if (!this.valid(binding, context, controller.signal)) return
      this.completed = { requestId, binding, context: hashContext(context) }
      this.changed()
    } catch {
      // Central state remains pending. No failure or declaration grants execution rights.
    } finally {
      clearTimeout(timer)
      if (this.controller === controller) this.controller = undefined
    }
  }
  private valid(binding: string, context: RuntimeContext, signal: AbortSignal): boolean {
    const device = this.client.status()
    return (
      !this.disposed &&
      !signal.aborted &&
      Boolean(device.scope) &&
      hashContext({ scope: device.scope, serverUrl: device.serverUrl }) === binding &&
      hashContext(this.context()) === hashContext(context)
    )
  }
}
