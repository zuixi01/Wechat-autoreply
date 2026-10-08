import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { hashContext } from '../../core/reply/hashes'
import type { ReplyTask } from '../../shared/contracts/task'
import type { WorkbenchRow } from '../../shared/contracts/workbench'
import type { RuntimePresentationReceipt } from '../../core/agent/runtime-timing'
import {
  WorkbenchPresentationRequestSchema,
  WorkbenchPresentationAckSchema,
  type WorkbenchPresentationTicket,
  type WorkbenchPresentationResult
} from '../../shared/contracts/workbench-presentation'

export interface HostPresentationTarget {
  task: ReplyTask
  row: WorkbenchRow
}
/** Implemented only by trusted main IPC, using the actual window and compositor. */
export interface HostPresentationSurface {
  owner: number
  document: string
  visible(): boolean
  inspect(nonce: string, target: HostPresentationTarget): Promise<boolean>
  capture(): Promise<boolean>
}
interface Ticket {
  target: HostPresentationTarget
  hash: string
  owner: number
  document: string
  expiresAtMs: number
}

async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('presentation_unconfirmed')), 2500)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Ephemeral, bounded, single-use receipts. This class cannot generate, edit or send. */
export class WorkbenchPresentationCapture {
  private readonly tickets = new Map<string, Ticket>()
  private busy = false
  private closed = false
  constructor(
    private readonly target: (input: unknown) => HostPresentationTarget | undefined,
    private readonly record: (receipt: RuntimePresentationReceipt) => boolean,
    private readonly now: () => number = () => performance.now()
  ) {}
  issue(input: unknown, surface: HostPresentationSurface): WorkbenchPresentationTicket {
    const parsed = WorkbenchPresentationRequestSchema.safeParse(input),
      now = this.now()
    if (this.closed || !parsed.success || !Number.isFinite(now) || now < 0 || !surface.visible())
      return { available: false }
    for (const [nonce, ticket] of this.tickets)
      if (
        ticket.expiresAtMs <= now ||
        (ticket.owner === surface.owner &&
          (ticket.document !== surface.document || ticket.target.row.taskId === parsed.data.taskId))
      )
        this.tickets.delete(nonce)
    if (this.tickets.size >= 64) return { available: false }
    const target = this.target(parsed.data)
    if (!target) return { available: false }
    const nonce = randomUUID()
    this.tickets.set(nonce, {
      target: structuredClone(target),
      hash: hashContext(target),
      owner: surface.owner,
      document: surface.document,
      expiresAtMs: now + 30000
    })
    return { available: true, nonce }
  }
  async acknowledge(
    input: unknown,
    surface: HostPresentationSurface
  ): Promise<WorkbenchPresentationResult> {
    const parsed = WorkbenchPresentationAckSchema.safeParse(input)
    if (!parsed.success || this.closed || this.busy) return { accepted: false }
    const ticket = this.tickets.get(parsed.data.nonce)
    // A foreign page cannot consume the intended page's receipt.
    if (!ticket || ticket.owner !== surface.owner || ticket.document !== surface.document)
      return { accepted: false }
    this.tickets.delete(parsed.data.nonce)
    const current = (): boolean => {
      const now = this.now()
      return (
        !this.closed &&
        Number.isFinite(now) &&
        now >= 0 &&
        now < ticket.expiresAtMs &&
        surface.visible() &&
        hashContext(
          this.target({
            taskId: ticket.target.row.taskId,
            expectedVersion: ticket.target.row.version
          }) ?? null
        ) === ticket.hash
      )
    }
    if (!current()) return { accepted: false }
    this.busy = true
    try {
      if (!(await bounded(surface.inspect(parsed.data.nonce, ticket.target))) || !current())
        return { accepted: false }
      if (!(await bounded(surface.capture())) || !current()) return { accepted: false }
      if (!(await bounded(surface.inspect(parsed.data.nonce, ticket.target))) || !current())
        return { accepted: false }
      const atMs = this.now()
      if (!Number.isFinite(atMs) || atMs < 0 || atMs >= ticket.expiresAtMs)
        return { accepted: false }
      return {
        accepted: this.record({
          task: ticket.target.task,
          rowVersion: ticket.target.row.version,
          receiptId: parsed.data.nonce,
          webContentsId: surface.owner,
          atMs
        })
      }
    } catch {
      return { accepted: false }
    } finally {
      this.busy = false
    }
  }
  close(): void {
    this.closed = true
    this.tickets.clear()
  }
}
