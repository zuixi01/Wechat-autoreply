import { z } from 'zod'
import type { BatchStatus } from './foreground-batch'
import { DeliverySchema, ReplyPartSchema } from './foreground-reply-plan'
import type { PersonalResourcesApi } from './personal-resources'

export const ForegroundMessageSchema = z.strictObject({
  direction: z.enum(['inbound', 'outbound', 'system']),
  text: z.string().max(4096),
  pixelFingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional()
})
export const ForegroundObservationSchema = z.strictObject({
  windowToken: z.string().min(1).max(256),
  contact: z.string().max(128),
  privateChat: z.boolean(),
  inputText: z.string().max(4096),
  messages: z.array(ForegroundMessageSchema).max(80),
  revision: z.string().min(1).max(128)
})
export const ForegroundRecordSchema = z.strictObject({
  id: z.string().uuid(),
  target: z.string().max(128),
  question: z.string().max(80 * 4096 + 79),
  reply: z.string().max(4096),
  state: z.enum(['unknown', 'sent', 'not_sent', 'handoff']),
  source: ForegroundObservationSchema.optional(),
  planId: z.string().uuid().optional(),
  partIndex: z.number().int().min(0).max(2).optional(),
  part: ReplyPartSchema.optional(),
  handledAt: z.number().int().nonnegative().optional(),
  failureReason: z.string().max(128).optional(),
  failureStage: z
    .enum(['before_input', 'input', 'draft_validation', 'before_enter', 'receipt'])
    .optional(),
  createdAt: z.number().int().nonnegative()
})
export const ForegroundCheckpointSchema = z.strictObject({
  baseline: ForegroundObservationSchema,
  ownEcho: z.string().max(4096).optional(),
  ownEchoFingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  pending: z.boolean(),
  delivery: DeliverySchema.optional()
})
export type ForegroundCheckpoint = z.infer<typeof ForegroundCheckpointSchema>
export const ForegroundResolutionSchema = z.strictObject({
  id: z.string().uuid(),
  state: z.enum(['sent', 'not_sent']),
  verifiedInWechat: z.literal(true)
})
export const ForegroundMetricsSchema = z.strictObject({
  visionRequests: z.number().int().nonnegative(),
  cacheHits: z.number().int().nonnegative(),
  lastVisionMs: z.number().nonnegative().optional(),
  lastGenerationMs: z.number().nonnegative().optional()
})
export type ForegroundMetrics = z.infer<typeof ForegroundMetricsSchema>
export const ForegroundStatusSchema = z.strictObject({
  state: z.enum([
    'idle',
    'connecting',
    'running',
    'waiting_foreground',
    'waiting_owner',
    'recovering',
    'generating',
    'sending',
    'paused'
  ]),
  target: z.string().max(128),
  reason: z.string().max(128),
  recoveryAttempts: z.number().int().nonnegative().optional(),
  lastReplyDurationMs: z.number().nonnegative().optional(),
  nextRetryAt: z.number().nonnegative().optional(),
  performance: ForegroundMetricsSchema.optional(),
  records: z.array(ForegroundRecordSchema).max(50)
})
export const ForegroundStartSchema = z
  .strictObject({
    target: z.string().trim().min(1).max(128),
    foregroundConsent: z.literal(true),
    connectionMode: z.enum(['search', 'current_chat']).optional(),
    currentChatSelected: z.literal(true).optional(),
    resetBaseline: z.boolean().optional(),
    pendingPreview: z.string().trim().min(1).max(4096).optional()
  })
  .refine(
    (input) =>
      !input.pendingPreview ||
      (input.resetBaseline === true && input.connectionMode === 'current_chat'),
    { message: 'pending_preview_requires_current_chat_reset', path: ['pendingPreview'] }
  )
  .refine(
    (input) => input.connectionMode !== 'current_chat' || input.currentChatSelected === true,
    { message: 'current_chat_selection_required', path: ['currentChatSelected'] }
  )
export type ForegroundConnectionMode = 'search' | 'current_chat'
export type ForegroundObservation = z.infer<typeof ForegroundObservationSchema>
/** OCR may vary compatibility punctuation and spacing around it after scrolling.
 * Word spacing and every other character remain significant. Exact pixel matches
 * retain the already verified message even if a later OCR transcription varies. */
export function sameForegroundMessages(
  a: ForegroundObservation['messages'],
  b: ForegroundObservation['messages']
): boolean {
  const canonical = (text: string): string =>
    text.normalize('NFKC').replace(/\s*([:;,!?。])\s*/g, '$1')
  return (
    a.length === b.length &&
    a.every(
      (message, index) =>
        message.direction === b[index].direction &&
        (message.direction === 'system' && message.pixelFingerprint && b[index].pixelFingerprint
          ? message.pixelFingerprint === b[index].pixelFingerprint
          : (message.pixelFingerprint && message.pixelFingerprint === b[index].pixelFingerprint) ||
            canonical(message.text) === canonical(b[index].text))
    )
  )
}
export type ForegroundRecord = z.infer<typeof ForegroundRecordSchema>
export type ForegroundDispatchFailure = Pick<ForegroundRecord, 'failureReason' | 'failureStage'>
export type ForegroundStatus = z.infer<typeof ForegroundStatusSchema>
export interface ForegroundDesktopApi extends PersonalResourcesApi {
  status(): Promise<ForegroundStatus>
  start(input: z.infer<typeof ForegroundStartSchema>): Promise<ForegroundStatus>
  pause(): Promise<ForegroundStatus>
  resolve(input: z.infer<typeof ForegroundResolutionSchema>): Promise<ForegroundStatus>
  acknowledgeHandoff(id: string): Promise<void>
  batchStatus(): Promise<BatchStatus>
  batchStart(input: {
    targets: string[]
    foregroundConsent: true
    processUnread: true
  }): Promise<BatchStatus>
  batchPause(): Promise<BatchStatus>
}
