import { z } from 'zod'
import { DeviceScopeSchema } from './registration'

const Hash = z.string().regex(/^[a-f0-9]{64}$/)
export const LedgerRestoreDescriptorSchema = z
  .strictObject({
    formatVersion: z.literal(1),
    restoreId: z.uuid(),
    backupId: z.uuid(),
    sourceSha256: Hash,
    restoredAt: z.iso.datetime(),
    previousRestoreId: z.uuid().nullable(),
    previousContextHash: Hash.nullable(),
    requiresReconciliation: z.literal(true)
  })
  .refine((value) => (value.previousRestoreId === null) === (value.previousContextHash === null))
export const LedgerRestoreContextSchema = LedgerRestoreDescriptorSchema.safeExtend({
  contextHash: Hash
})
export type LedgerRestoreContext = z.infer<typeof LedgerRestoreContextSchema>
export const RestoreLookupInputSchema = z.strictObject({ restoreId: z.uuid(), contextHash: Hash })
export const RestoreLookupResultSchema = RestoreLookupInputSchema.extend({
  caseId: z.uuid(),
  scope: DeviceScopeSchema
}).strict()
export type RestoreLookupResult = z.infer<typeof RestoreLookupResultSchema>
export const RestorationStatusSchema = z.strictObject({
  state: z.enum([
    'not_required',
    'review_required',
    'pause_report_recorded',
    'inventory_received',
    'quarantine_recorded',
    'context_unavailable'
  ])
})
export type RestorationStatus = z.infer<typeof RestorationStatusSchema>

const Millis = z.number().int().nonnegative().safe()
export const RestoreChallengeInputSchema = z.strictObject({
  caseId: z.uuid(),
  requestId: z.uuid(),
  restoreId: z.uuid(),
  contextHash: Hash
})
export const RestorePauseChallengeSchema = z
  .strictObject({
    challengeId: z.uuid(),
    caseId: z.uuid(),
    requestId: z.uuid(),
    scope: DeviceScopeSchema,
    context: LedgerRestoreContextSchema,
    frontierHash: Hash,
    issuedAt: Millis,
    expiresAt: Millis
  })
  .refine((value) => value.expiresAt > value.issuedAt && value.expiresAt - value.issuedAt === 30000)
export type RestorePauseChallenge = z.infer<typeof RestorePauseChallengeSchema>
export const RestorePauseReportSchema = z
  .strictObject({
    challenge: RestorePauseChallengeSchema,
    instanceId: z.uuid(),
    runtimeGeneration: Millis,
    stoppedAt: Millis,
    observedAt: Millis,
    stopped: z.strictObject({
      observerStopped: z.literal(true),
      senderQuiescent: z.literal(true),
      settlementQuiescent: z.literal(true),
      leaseStopped: z.literal(true),
      platformStopped: z.literal(true)
    })
  })
  .refine(
    (value) =>
      value.stoppedAt >= value.challenge.issuedAt &&
      value.observedAt >= value.stoppedAt &&
      value.observedAt < value.challenge.expiresAt
  )
export type RestorePauseReport = z.infer<typeof RestorePauseReportSchema>
export const RestorePauseAckSchema = z.strictObject({
  challengeId: z.uuid(),
  reportHash: Hash,
  status: z.literal('target_pause_report_recorded')
})
export type RestorePauseAck = z.infer<typeof RestorePauseAckSchema>
export const RestorationSubmitResultSchema = z.discriminatedUnion('success', [
  RestorePauseAckSchema.extend({ success: z.literal(true), caseId: z.uuid() }).strict(),
  z.strictObject({
    success: z.literal(false),
    code: z.enum([
      'invalid_input',
      'unavailable',
      'execution_pending',
      'device_changed',
      'local_storage_unavailable'
    ])
  })
])
export type RestorationSubmitResult = z.infer<typeof RestorationSubmitResultSchema>
export const RestorationApplyResultSchema = z.discriminatedUnion('success', [
  z.strictObject({
    success: z.literal(true),
    status: z.literal('quarantine_recorded'),
    canRelease: z.literal(false)
  }),
  z.strictObject({
    success: z.literal(false),
    code: z.enum([
      'invalid_input',
      'unavailable',
      'execution_pending',
      'device_changed',
      'local_storage_unavailable'
    ])
  })
])
export type RestorationApplyResult = z.infer<typeof RestorationApplyResultSchema>
export interface RestorationDesktopApi {
  status(): Promise<RestorationStatus>
  submitPause(): Promise<RestorationSubmitResult>
  submitInventory(): Promise<import('./restore-inventory').RestorationInventorySubmitResult>
  applyDecision(): Promise<RestorationApplyResult>
}
