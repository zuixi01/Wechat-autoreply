import { z } from 'zod'
import { MemoryScopeSchema, type MemoryScope } from './learning-memory'
import {
  LearningSubmissionRequestSchema,
  LearningSubmissionReceiptSchema,
  type LearningSubmissionRequest,
  type LearningSubmissionReceipt
} from './learning-submissions'

export const LearningSubmissionDesktopRequests = {
  submit: LearningSubmissionRequestSchema,
  receipts: z.strictObject({ scope: MemoryScopeSchema })
}

export const LearningSubmissionReadTransientSchema = z.strictObject({
  status: z.literal('unavailable'),
  code: z.enum(['network_unavailable', 'storage_busy'])
})
export type LearningSubmissionReadTransient = z.infer<typeof LearningSubmissionReadTransientSchema>

export const LearningSubmissionReadResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('available'),
    receipts: z.array(LearningSubmissionReceiptSchema)
  }),
  LearningSubmissionReadTransientSchema
])
export type LearningSubmissionReadResult = z.infer<typeof LearningSubmissionReadResultSchema>

export function parseLearningSubmissionReadResult(raw: unknown): LearningSubmissionReadResult {
  const receipts = z.array(LearningSubmissionReceiptSchema).safeParse(raw)
  if (receipts.success) return { status: 'available', receipts: receipts.data }
  const transient = LearningSubmissionReadTransientSchema.safeParse(raw)
  if (transient.success) return transient.data
  throw new Error('learning_submission_response_invalid')
}

/** Plain IPC envelopes retain safe codes; no host error message or private payload crosses the bridge. */
export function parseLearningSubmissionReadResponse(raw: unknown): LearningSubmissionReceipt[] {
  const result = parseLearningSubmissionReadResult(raw)
  if (result.status === 'available') return result.receipts
  throw Object.assign(new Error(result.code), { code: result.code })
}
export interface LearningSubmissionDesktopApi {
  submit(input: LearningSubmissionRequest): Promise<LearningSubmissionReceipt>
  submissions(input: { scope: MemoryScope }): Promise<LearningSubmissionReceipt[]>
  readSubmissions(input: { scope: MemoryScope }): Promise<LearningSubmissionReadResult>
}
