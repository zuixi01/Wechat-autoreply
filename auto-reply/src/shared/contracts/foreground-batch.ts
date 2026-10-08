import { z } from 'zod'
import { ForegroundRecordSchema } from './foreground-wechat'

const name = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine(
    (value) =>
      !Array.from(value).some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
      )
  )
export const BatchStartSchema = z.strictObject({
  targets: z
    .array(name)
    .min(1)
    .max(500)
    .refine((values) => new Set(values).size === values.length),
  foregroundConsent: z.literal(true),
  processUnread: z.literal(true)
})
export const ListRowSchema = z.strictObject({
  name,
  nameComplete: z.boolean(),
  preview: z.string().max(4096),
  unread: z.number().int().min(0).max(9999).nullable(),
  point: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)])
})
export type ListRow = z.infer<typeof ListRowSchema>
export interface ListPage {
  rows: ListRow[]
  atBottom: boolean
  atTop: boolean
  currentContact?: string
}
export interface BatchNavigator {
  currentContact?(): string
  connect(signal: AbortSignal): Promise<void>
  top(signal: AbortSignal): Promise<void>
  page(signal: AbortSignal): Promise<ListPage>
  down(signal: AbortSignal): Promise<void>
  open(row: ListRow, signal: AbortSignal): Promise<void>
}
export const BatchStatusSchema = z.strictObject({
  state: z.enum(['idle', 'connecting', 'scanning', 'processing', 'waiting_foreground', 'paused']),
  reason: z.string().max(128),
  targets: z.array(name).max(500),
  current: z.string().max(128),
  discovered: z.number().int().nonnegative(),
  pages: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  scanComplete: z.boolean(),
  issues: z
    .array(z.strictObject({ target: z.string().max(128), reason: z.string().max(128) }))
    .max(500),
  records: z.array(ForegroundRecordSchema).max(50)
})
export type BatchStatus = z.infer<typeof BatchStatusSchema>
