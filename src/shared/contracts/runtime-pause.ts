import { z } from 'zod'
import { DeviceScopeSchema } from './registration'

const Millis = z.number().int().nonnegative().safe()
export const RuntimeContextSchema = z.strictObject({ instanceId: z.uuid(), generation: Millis })
export type RuntimeContext = z.infer<typeof RuntimeContextSchema>
export const PauseChallengeInputSchema = z.strictObject({
  requestId: z.uuid(),
  attemptId: z.uuid(),
  runtime: RuntimeContextSchema,
  instanceEpoch: z.number().int().positive().safe()
})
export const AccountPauseChallengeSchema = PauseChallengeInputSchema.extend({
  purpose: z.literal('account_pause'),
  challengeId: z.uuid(),
  scope: DeviceScopeSchema,
  issuedAt: Millis,
  expiresAt: Millis
})
  .strict()
  .refine((c) => c.expiresAt - c.issuedAt === 30000)
export type AccountPauseChallenge = z.infer<typeof AccountPauseChallengeSchema>
export const AccountPauseReportSchema = z.strictObject({
  challenge: AccountPauseChallengeSchema,
  elapsedMs: Millis.max(29999),
  stopped: z.strictObject({
    observerStopped: z.literal(true),
    senderQuiescent: z.literal(true),
    settlementQuiescent: z.literal(true),
    leaseStopped: z.literal(true),
    platform: z.enum(['absent', 'stop_returned'])
  })
})
export type AccountPauseReport = z.infer<typeof AccountPauseReportSchema>
export const AccountPauseAckSchema = z.strictObject({
  requestId: z.uuid(),
  challengeId: z.uuid(),
  reportHash: z.string().regex(/^[a-f0-9]{64}$/),
  receivedAt: Millis,
  status: z.literal('runtime_stop_confirmation_recorded'),
  physicalStopVerified: z.literal(false),
  canAuthorizeSend: z.literal(false)
})
export type AccountPauseAck = z.infer<typeof AccountPauseAckSchema>
