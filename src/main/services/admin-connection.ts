import { TextDecoder } from 'node:util'
import { z } from 'zod'
import {
  AdminConnectSchema,
  AdminIdentitySchema,
  AdminGatewayRequestSchema,
  type AdminConnectionStatus,
  type AdminDesktopApi,
  type AdminIdentity,
  type AdminResult,
  type AdminGatewayRequest
} from '../../shared/contracts/admin-gateway'
import {
  RuntimeStatusPageSchema,
  RuntimeStatusPageInputSchema,
  type RuntimeStatusPage
} from '../../shared/contracts/runtime-monitoring'
import {
  BulkPauseSummarySchema,
  BulkPausePageSchema,
  BulkPausePageInputSchema,
  type BulkPauseSummary,
  type BulkPausePage
} from '../../shared/contracts/bulk-pause'
import { serverOrigin } from './agent-registration'
import {
  MemoryAdminPauseJournal,
  type AdminPauseJournal,
  type AdminPauseScope
} from './admin-pause-journal'

/** Operator bearer exists only in main-process memory for the current session.
 * Disconnect cancels requests and invalidates late login responses. A cancelled
 * pause may already have committed: its caller retains the same batch UUID. */
export class AdminConnection implements AdminDesktopApi {
  private session?: {
    origin: string
    token: string
    identity: AdminIdentity
    latestPause?: AdminConnectionStatus['latestPause']
    journalUnavailable?: boolean
  }
  private epoch = 0
  private closed = false
  private mutating = false
  private readonly pending = new Set<AbortController>()
  constructor(
    private readonly transport: typeof fetch = fetch,
    private readonly allowLocalHttp = false,
    private readonly journal: AdminPauseJournal = new MemoryAdminPauseJournal()
  ) {}
  async status(): Promise<AdminConnectionStatus> {
    return this.session
      ? {
          connected: true,
          serverUrl: this.session.origin,
          identity: { ...this.session.identity },
          ...(this.session.journalUnavailable ? { journalUnavailable: true } : {}),
          ...(this.session.latestPause ? { latestPause: { ...this.session.latestPause } } : {})
        }
      : { connected: false }
  }
  async disconnect(): Promise<AdminConnectionStatus> {
    this.reset()
    return { connected: false }
  }
  async close(): Promise<void> {
    this.closed = true
    this.reset()
    await this.journal.close()
  }
  private scope(session: NonNullable<AdminConnection['session']>): AdminPauseScope {
    return { origin: session.origin, ...session.identity }
  }
  private reset(): void {
    this.epoch++
    this.session = undefined
    for (const pending of this.pending) pending.abort()
  }
  async connect(raw: unknown): Promise<AdminResult<AdminConnectionStatus>> {
    if (this.closed) return { success: false, code: 'not_connected' }
    const input = AdminConnectSchema.safeParse(raw)
    if (!input.success) return { success: false, code: 'invalid_input' }
    let origin: string
    try {
      origin = serverOrigin(input.data.serverUrl, this.allowLocalHttp)
    } catch {
      return { success: false, code: 'invalid_input' }
    }
    this.reset()
    const epoch = this.epoch
    const result = await this.send(
      origin,
      input.data.token,
      { operation: 'identity' },
      AdminIdentitySchema
    )
    if (epoch !== this.epoch) return { success: false, code: 'operation_unconfirmed' }
    if (!result.success) return result
    const session: NonNullable<AdminConnection['session']> = {
      origin,
      token: input.data.token,
      identity: result.value
    }
    try {
      const latest = await this.journal.latest(this.scope(session))
      if (latest)
        session.latestPause = {
          requestId: latest.requestId,
          confirmed: latest.confirmed,
          recovered: true
        }
    } catch {
      session.journalUnavailable = true
    }
    if (epoch !== this.epoch) return { success: false, code: 'operation_unconfirmed' }
    this.session = session
    return { success: true, value: await this.status() }
  }
  runtime(raw: unknown): Promise<AdminResult<RuntimeStatusPage>> {
    const input = RuntimeStatusPageInputSchema.safeParse(raw)
    return input.success
      ? this.request({ operation: 'runtime-status', input: input.data }, RuntimeStatusPageSchema)
      : Promise.resolve({ success: false as const, code: 'invalid_input' as const })
  }
  async pauseAll(raw: unknown): Promise<AdminResult<BulkPauseSummary>> {
    const input = z.strictObject({ requestId: z.uuid() }).safeParse(raw)
    if (!input.success) return { success: false as const, code: 'invalid_input' as const }
    const session = this.session,
      epoch = this.epoch
    if (!session) return { success: false, code: 'not_connected' }
    if (this.mutating) return { success: false, code: 'operation_busy' }
    this.mutating = true
    const requestId = input.data.requestId.toLowerCase()
    try {
      let intent: Awaited<ReturnType<AdminPauseJournal['begin']>>
      try {
        intent = await this.journal.begin(this.scope(session), requestId)
      } catch {
        if (session === this.session) session.journalUnavailable = true
        return { success: false, code: 'journal_unavailable', requestId }
      }
      if (epoch !== this.epoch) return { success: false, code: 'operation_unconfirmed' }
      session.journalUnavailable = false
      session.latestPause = {
        requestId: intent.record.requestId,
        confirmed: intent.record.confirmed
      }
      if (!intent.accepted)
        return { success: false, code: 'pause_pending', requestId: intent.record.requestId }
      // A locally confirmed historical batch must never create another pause after server recovery.
      const result = await this.pauseOperation(
        intent.record.confirmed ? 'pause-all-request' : 'request-pause-all',
        { requestId }
      )
      return await this.confirmResult(session, epoch, requestId, result)
    } finally {
      this.mutating = false
    }
  }
  async pauseSummary(raw: unknown): Promise<AdminResult<BulkPauseSummary>> {
    const input = z.strictObject({ requestId: z.uuid() }).safeParse(raw)
    if (!input.success) return { success: false, code: 'invalid_input' }
    const session = this.session,
      epoch = this.epoch
    if (!session) return { success: false, code: 'not_connected' }
    const result = await this.pauseOperation('pause-all-request', raw)
    return this.confirmResult(session, epoch, input.data.requestId.toLowerCase(), result)
  }
  private async confirmResult(
    session: NonNullable<AdminConnection['session']>,
    epoch: number,
    requestId: string,
    result: AdminResult<BulkPauseSummary>
  ): Promise<AdminResult<BulkPauseSummary>> {
    if (!result.success) return result
    if (epoch !== this.epoch || result.value.requestId.toLowerCase() !== requestId)
      return { success: false, code: 'operation_unconfirmed' }
    const latestPause = session.latestPause
    if (latestPause?.requestId !== requestId) return result
    if (latestPause.confirmed) return result
    try {
      const confirmed = await this.journal.confirm(this.scope(session), requestId)
      if (!confirmed) throw new Error('missing_pause_intent')
    } catch {
      if (session === this.session && session.latestPause === latestPause) {
        session.journalUnavailable = true
        latestPause.confirmed = false
      }
      return { success: false, code: 'journal_unavailable', requestId }
    }
    if (epoch !== this.epoch) return { success: false, code: 'operation_unconfirmed' }
    if (session.latestPause === latestPause) {
      latestPause.confirmed = true
      session.journalUnavailable = false
    }
    return result
  }
  private pauseOperation(
    operation: 'request-pause-all' | 'pause-all-request',
    raw: unknown
  ): Promise<AdminResult<BulkPauseSummary>> {
    const input = z.strictObject({ requestId: z.uuid() }).safeParse(raw)
    return input.success
      ? this.request(
          { operation, requestId: input.data.requestId.toLowerCase() },
          BulkPauseSummarySchema
        )
      : Promise.resolve({ success: false as const, code: 'invalid_input' as const })
  }
  pauseAccounts(raw: unknown): Promise<AdminResult<BulkPausePage>> {
    const input = z
      .strictObject({ requestId: z.uuid(), page: BulkPausePageInputSchema })
      .safeParse(raw)
    return input.success
      ? this.request(
          {
            operation: 'pause-all-accounts',
            requestId: input.data.requestId,
            input: input.data.page
          },
          BulkPausePageSchema
        )
      : Promise.resolve({ success: false as const, code: 'invalid_input' as const })
  }
  private async request<T>(
    input: AdminGatewayRequest,
    schema: z.ZodType<T>
  ): Promise<AdminResult<T>> {
    const session = this.session,
      epoch = this.epoch
    if (!session) return { success: false, code: 'not_connected' }
    const result = await this.send(session.origin, session.token, input, schema)
    if (epoch !== this.epoch) return { success: false, code: 'operation_unconfirmed' }
    if (!result.success && result.code === 'denied') await this.disconnect()
    return result
  }
  private async send<T>(
    origin: string,
    token: string,
    input: AdminGatewayRequest,
    schema: z.ZodType<T>
  ): Promise<AdminResult<T>> {
    const controller = new AbortController()
    this.pending.add(controller)
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error('admin_deadline'))
      }, 8000)
    })
    const cancelled = new Promise<never>((_resolve, reject) =>
      controller.signal.addEventListener('abort', () => reject(new Error('admin_cancelled')), {
        once: true
      })
    )
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      const operation = (async (): Promise<AdminResult<T>> => {
        const response = await this.transport(origin + '/v1/admin/operations', {
          method: 'POST',
          redirect: 'manual',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify(AdminGatewayRequestSchema.parse(input))
        })
        if (controller.signal.aborted) {
          void response.body?.cancel().catch(() => {})
          throw new Error('cancelled')
        }
        if ([401, 403].includes(response.status)) {
          void response.body?.cancel().catch(() => {})
          return { success: false, code: 'denied' }
        }
        if (
          !response.ok ||
          !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '') ||
          !response.body
        ) {
          void response.body?.cancel().catch(() => {})
          throw new Error('invalid_response')
        }
        reader = response.body.getReader()
        const chunks: Uint8Array[] = [],
          maximum = 2097152
        let length = 0
        while (true) {
          const read = await reader.read()
          if (controller.signal.aborted) throw new Error('cancelled')
          if (read.done) break
          length += read.value.byteLength
          if (length > maximum) throw new Error('response_too_large')
          chunks.push(read.value)
        }
        const envelope = z
          .strictObject({ result: schema })
          .parse(
            JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
          )
        return { success: true, value: envelope.result }
      })()
      return await Promise.race([operation, deadline, cancelled])
    } catch {
      return { success: false, code: 'operation_unconfirmed' }
    } finally {
      if (timer) clearTimeout(timer)
      controller.abort()
      void reader?.cancel().catch(() => {})
      this.pending.delete(controller)
    }
  }
}
