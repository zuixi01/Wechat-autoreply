import { z } from 'zod'
import { RuntimeStatusSchema } from './runtime'
import { DeviceScopeSchema } from './registration'
import { Id } from './identity'
import { RuntimeContextSchema } from './runtime-pause'

const Ordinal = z.number().int().positive().safe()
export const RuntimeObservationSchema = z
  .strictObject({
    runtimeEpoch: Ordinal,
    sequence: Ordinal,
    runtimeContext: RuntimeContextSchema.optional(),
    status: RuntimeStatusSchema
  })
  .superRefine(({ status }, context) => {
    if (
      status.pauseAcknowledged &&
      (!['paused', 'blocked', 'closed'].includes(status.state) || status.lease !== 'stopped')
    )
      context.addIssue({ code: 'custom', message: 'inconsistent_pause_state' })
  })
export type RuntimeObservation = z.infer<typeof RuntimeObservationSchema>

export const RuntimeObservationReceiptSchema = z.strictObject({
  scope: DeviceScopeSchema,
  runtimeEpoch: Ordinal,
  sequence: Ordinal,
  reportHash: z.string().regex(/^[a-f0-9]{64}$/),
  receivedAt: z.number().int().nonnegative().safe(),
  serverPaused: z.boolean(),
  pauseRequestId: z.uuid().optional(),
  canAuthorizeSend: z.literal(false)
})
export type RuntimeObservationReceipt = z.infer<typeof RuntimeObservationReceiptSchema>

export const RuntimeStatusPageInputSchema = z.strictObject({
  accountId: Id.optional(),
  after: z.string().min(1).max(2048).optional(),
  limit: z.number().int().min(1).max(100).optional()
})

export const RuntimeDeviceRowSchema = z.strictObject({
  accountId: Id,
  employeeId: Id,
  agentId: Id,
  platform: z.enum(['wechat', 'wework']),
  accountEnabled: z.boolean(),
  employeeEnabled: z.boolean(),
  serverPaused: z.boolean(),
  revoked: z.boolean(),
  configurationVersion: Id.nullable(),
  automaticEnabled: z.boolean().nullable(),
  leaseLive: z.boolean(),
  leaseAgentId: Id.nullable(),
  freshness: z.enum(['missing', 'recent', 'stale', 'revoked', 'invalid']),
  receivedAt: z.number().int().nonnegative().safe().nullable(),
  observation: RuntimeObservationSchema.nullable(),
  pauseRequestId: z.uuid().nullable(),
  pauseConfirmation: z.enum([
    'not_requested',
    'pending',
    'awaiting_state',
    'confirmed_runtime',
    'stale',
    'revoked',
    'invalid'
  ]),
  physicalStopVerified: z.literal(false),
  canAuthorizeSend: z.literal(false)
})
export const RuntimeStatusPageSchema = z.strictObject({
  serverTime: z.number().int().nonnegative().safe(),
  totalDevices: z.number().int().nonnegative().safe(),
  revokedDevices: z.number().int().nonnegative().safe(),
  rows: z.array(RuntimeDeviceRowSchema).max(100),
  nextCursor: z.string().min(1).max(2048).nullable()
})
export type RuntimeDeviceRow = z.infer<typeof RuntimeDeviceRowSchema>
export type RuntimeStatusPage = z.infer<typeof RuntimeStatusPageSchema>
