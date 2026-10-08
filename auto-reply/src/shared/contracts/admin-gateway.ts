import { z } from 'zod'
import { BulkPausePageInputSchema } from './bulk-pause'
import { RuntimeStatusPageInputSchema } from './runtime-monitoring'
import type { RuntimeStatusPage } from './runtime-monitoring'
import type { BulkPauseSummary, BulkPausePage } from './bulk-pause'
import { Id } from './identity'

/** Tenant and database authority belong to the operator service configuration.
 * A caller cannot select a tenant or invoke arbitrary administration commands. */
export const AdminGatewayRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('identity') }),
  z.strictObject({ operation: z.literal('runtime-status'), input: RuntimeStatusPageInputSchema }),
  z.strictObject({ operation: z.literal('request-pause-all'), requestId: z.uuid() }),
  z.strictObject({ operation: z.literal('pause-all-request'), requestId: z.uuid() }),
  z.strictObject({
    operation: z.literal('pause-all-accounts'),
    requestId: z.uuid(),
    input: BulkPausePageInputSchema
  })
])
export type AdminGatewayRequest = z.infer<typeof AdminGatewayRequestSchema>

export const AdminIdentitySchema = z.strictObject({ tenantId: Id, actorId: Id })
export type AdminIdentity = z.infer<typeof AdminIdentitySchema>
export const AdminConnectSchema = z.strictObject({
  serverUrl: z.string().min(1).max(2048),
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/)
})
export interface AdminConnectionStatus {
  connected: boolean
  serverUrl?: string
  identity?: AdminIdentity
  latestPause?: { requestId: string; confirmed: boolean; recovered?: boolean }
  journalUnavailable?: boolean
}
export type AdminResult<T> =
  | { success: true; value: T }
  | {
      success: false
      code:
        | 'invalid_input'
        | 'not_connected'
        | 'denied'
        | 'operation_unconfirmed'
        | 'journal_unavailable'
        | 'pause_pending'
        | 'operation_busy'
      requestId?: string
    }
export interface AdminDesktopApi {
  status(): Promise<AdminConnectionStatus>
  connect(input: z.infer<typeof AdminConnectSchema>): Promise<AdminResult<AdminConnectionStatus>>
  disconnect(): Promise<AdminConnectionStatus>
  runtime(
    input: z.infer<typeof RuntimeStatusPageInputSchema>
  ): Promise<AdminResult<RuntimeStatusPage>>
  pauseAll(input: { requestId: string }): Promise<AdminResult<BulkPauseSummary>>
  pauseSummary(input: { requestId: string }): Promise<AdminResult<BulkPauseSummary>>
  pauseAccounts(input: {
    requestId: string
    page: z.infer<typeof BulkPausePageInputSchema>
  }): Promise<AdminResult<BulkPausePage>>
}
