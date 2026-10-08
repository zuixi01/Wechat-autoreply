import { z } from 'zod'
import { Id, Hash } from './identity'

const Content = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('preferences'),
    localeHint: z.enum(['zh', 'en']),
    themeHint: z.enum(['dark', 'light']),
    platformHint: z.enum(['wechat', 'wework']).nullable(),
    defaultModeSourceId: z.string().max(256),
    autoReplyRequested: z.boolean()
  }),
  z.strictObject({
    kind: z.literal('mode'),
    legacyModeId: z.string().min(1).max(256),
    name: z.string().max(200),
    prompt: z.string().max(32000),
    unifiedPrefix: z.string().max(2000),
    autoReplyRequested: z.boolean()
  }),
  z.strictObject({
    kind: z.literal('relationship'),
    legacyObjectId: z.string().min(1).max(256),
    originModeId: z.string().min(1).max(256),
    requestedModeId: z.string().max(256),
    name: z.string().max(200),
    title: z.string().max(256),
    relationship: z.string().max(2000),
    autoReplyRequested: z.boolean().nullable()
  })
])
export const LegacySettingsDraftSchema = z.strictObject({
  id: Hash,
  workspaceId: Id,
  contentHash: Hash,
  state: z.literal('pending'),
  automaticEnabled: z.literal(false),
  identityVerified: z.literal(false),
  content: Content,
  createdAt: z.number().int().nonnegative()
})
export type LegacySettingsDraft = z.infer<typeof LegacySettingsDraftSchema>
export type LegacySettingsContent = z.infer<typeof Content>
export interface LegacySettingsImportResult {
  sourceSha256: string
  backupDirectory: string
  createdDrafts: number
  reusedDrafts: number
  automaticEnabled: false
  reviewRequired: true
}

export const LegacyReviewInputSchema = z.strictObject({
  sourceId: Id,
  draftId: Hash,
  expectedContentHash: Hash,
  expectedReviewRevision: z.number().int().nonnegative().safe(),
  decision: z.enum(['accept', 'reject', 'reopen']),
  reason: z.string().trim().min(1).max(2000),
  replyRules: z.string().trim().min(1).max(12000).optional()
})
export const LegacyReviewRecordSchema = LegacyReviewInputSchema.extend({
  workspaceId: Id,
  reviewer: z.string().trim().min(1).max(200),
  revision: z.number().int().positive().safe(),
  previousHash: Hash.nullable(),
  requestHash: Hash,
  recordHash: Hash,
  createdAt: z.number().int().nonnegative().safe(),
  automaticEnabled: z.literal(false),
  identityVerified: z.literal(false)
})
export type LegacyReviewInput = z.infer<typeof LegacyReviewInputSchema>
export type LegacyReviewRecord = z.infer<typeof LegacyReviewRecordSchema>
export interface LegacyReviewResult {
  record: LegacyReviewRecord
  currentReviewRevision: number
  isCurrent: boolean
}
