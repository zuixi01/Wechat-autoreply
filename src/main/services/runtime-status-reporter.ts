import { hashContext } from '../../core/reply/hashes'
import { RuntimeObservationSchema } from '../../shared/contracts/runtime-monitoring'
import type { RuntimeStatus } from '../../shared/contracts/runtime'
import type { AgentRegistration } from './agent-registration'
import type { RuntimeObservationReceipt } from '../../shared/contracts/runtime-monitoring'
import type { RuntimeContext } from '../../shared/contracts/runtime-pause'

type Client = Pick<AgentRegistration, 'status' | 'reportRuntimeStatus'>
/** Main-process metadata only; no renderer-supplied payload or platform reads. */
export class RuntimeStatusReporter {
  private stopped = true
  private timer?: ReturnType<typeof setTimeout>
  private work?: Promise<void>
  private controller?: AbortController
  private binding?: string
  private epoch = 0
  private sequence = 0
  private dirty = false
  constructor(
    private readonly client: Client,
    private readonly snapshot: () => RuntimeStatus,
    private readonly nextEpoch: () => number,
    private readonly onServerPause: (receipt: RuntimeObservationReceipt) => void | Promise<unknown>,
    private readonly runtimeContext?: () => RuntimeContext
  ) {}

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.schedule(0)
  }
  wake(): void {
    if (this.stopped) return
    if (this.work) {
      this.dirty = true
      return
    }
    this.schedule(0)
  }
  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.controller?.abort()
    await this.work
  }
  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (this.stopped || this.work) return
      const work = this.tick()
      this.work = work
      const settled = (): void => {
        if (this.work === work) this.work = undefined
        if (!this.stopped) {
          const delay = this.dirty ? 0 : 5000
          this.dirty = false
          this.schedule(delay)
        }
      }
      void work.then(settled, settled)
    }, ms)
    this.timer.unref?.()
  }
  private currentBinding(): string | undefined {
    const device = this.client.status()
    return device.scope
      ? hashContext({ scope: device.scope, serverUrl: device.serverUrl })
      : undefined
  }
  private async tick(): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined
    const controller = new AbortController()
    this.controller = controller
    try {
      const binding = this.currentBinding()
      if (!binding) return
      if (binding !== this.binding) {
        this.epoch = this.nextEpoch()
        this.sequence = 0
        this.binding = binding
      }
      const observation = RuntimeObservationSchema.parse({
        runtimeEpoch: this.epoch,
        sequence: ++this.sequence,
        ...(this.runtimeContext ? { runtimeContext: this.runtimeContext() } : {}),
        status: this.snapshot()
      })
      const stopped = new Promise<never>((_, reject) => {
        abort = () => reject(new Error('runtime_reporting_stopped'))
        controller.signal.addEventListener('abort', abort, { once: true })
      })
      timeout = setTimeout(() => controller.abort(), 2500)
      const receipt = await Promise.race([
        this.client.reportRuntimeStatus(observation, controller.signal),
        stopped
      ])
      if (this.stopped || controller.signal.aborted || this.currentBinding() !== binding) return
      if (
        receipt.serverPaused &&
        (receipt.pauseRequestId || ['running', 'starting'].includes(this.snapshot().state))
      )
        void Promise.resolve(this.onServerPause(receipt)).catch(() => {})
    } catch {
      // Failure is visible centrally as aging/missing reports. It grants no execution right.
    } finally {
      if (timeout) clearTimeout(timeout)
      if (abort) controller.signal.removeEventListener('abort', abort)
      if (this.controller === controller) this.controller = undefined
    }
  }
}
