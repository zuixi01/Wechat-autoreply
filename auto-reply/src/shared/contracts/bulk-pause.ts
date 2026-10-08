import { z } from 'zod'
import { Id } from './identity'
const Count = z.number().int().nonnegative().safe()
export const BulkPauseSummarySchema = z
  .strictObject({
    requestId: z.uuid(),
    actorId: Id,
    issuedAt: Count,
    accountCount: Count,
    activeAccounts: Count,
    outsideAccounts: Count,
    targetCount: Count,
    reportedTargets: Count,
    physicalStopVerified: z.literal(false),
    canAuthorizeSend: z.literal(false)
  })
  .refine((s) => s.activeAccounts <= s.accountCount && s.reportedTargets <= s.targetCount)
export type BulkPauseSummary = z.infer<typeof BulkPauseSummarySchema>
export const BulkPausePageInputSchema = z.strictObject({
  after: z.string().min(1).max(2048).optional(),
  limit: z.number().int().min(1).max(100).optional()
})
export const BulkPauseAccountSchema = z
  .strictObject({
    accountId: Id,
    requestId: z.uuid(),
    employeeId: Id,
    platform: z.enum(['wechat', 'wework']),
    enabled: z.boolean(),
    active: z.boolean(),
    targetCount: Count,
    reportedTargets: Count
  })
  .refine((r) => r.reportedTargets <= r.targetCount)
export const BulkPausePageSchema = z.strictObject({
  summary: BulkPauseSummarySchema,
  rows: z.array(BulkPauseAccountSchema).max(100),
  nextCursor: z.string().min(1).max(2048).nullable()
})
export type BulkPausePage = z.infer<typeof BulkPausePageSchema>
