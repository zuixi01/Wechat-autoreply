import { z } from 'zod'
import type { BatchStatus } from './foreground-batch'

export const ForegroundMessageSchema = z.strictObject({
  direction: z.enum(['inbound', 'outbound', 'system']),
  text: z.string().max(4096)
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
  question: z.string().max(16384),
  reply: z.string().max(4096),
  state: z.enum(['unknown', 'sent', 'not_sent']),
  createdAt: z.number().int().nonnegative()
})
export const ForegroundCheckpointSchema = z.strictObject({
  baseline: ForegroundObservationSchema,
  ownEcho: z.string().max(4096).optional(),
  pending: z.boolean()
})
export type ForegroundCheckpoint = z.infer<typeof ForegroundCheckpointSchema>
export const ForegroundStatusSchema = z.strictObject({
  state: z.enum([
    'idle',
    'connecting',
    'running',
    'waiting_foreground',
    'generating',
    'sending',
    'paused'
  ]),
  target: z.string().max(128),
  reason: z.string().max(128),
  records: z.array(ForegroundRecordSchema).max(50)
})
export const ForegroundStartSchema = z
  .strictObject({
    target: z.string().trim().min(1).max(128),
    foregroundConsent: z.literal(true),
    connectionMode: z.enum(['search', 'current_chat']).optional(),
    currentChatSelected: z.literal(true).optional()
  })
  .refine(
    (input) => input.connectionMode !== 'current_chat' || input.currentChatSelected === true,
    { message: 'current_chat_selection_required', path: ['currentChatSelected'] }
  )
export type ForegroundConnectionMode = 'search' | 'current_chat'
export type ForegroundObservation = z.infer<typeof ForegroundObservationSchema>
export type ForegroundRecord = z.infer<typeof ForegroundRecordSchema>
export type ForegroundStatus = z.infer<typeof ForegroundStatusSchema>
export interface ForegroundDesktopApi {
  status(): Promise<ForegroundStatus>
  start(input: z.infer<typeof ForegroundStartSchema>): Promise<ForegroundStatus>
  pause(): Promise<ForegroundStatus>
  batchStatus(): Promise<BatchStatus>
  batchStart(input: {
    targets: string[]
    foregroundConsent: true
    processUnread: true
  }): Promise<BatchStatus>
  batchPause(): Promise<BatchStatus>
}
