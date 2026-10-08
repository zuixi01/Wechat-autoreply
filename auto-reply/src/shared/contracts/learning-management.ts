import { z } from 'zod'
import {
  MemoryScopeSchema,
  MemoryContentSchema,
  LearningEpisodeSchema,
  LearningSettingsSchema,
  LearningTriggerSchema,
  LearningCalibrationInputSchema,
  LearningValidationCaseSchema,
  LearningCorrectionInputSchema,
  LearningResultInputSchema,
  LearningHumanFeedbackInputSchema,
  MemoryProposalSchema,
  type MemoryRevision,
  type LearningCalibrationSet,
  type LearningValidationResult,
  type LearningCurationReport,
  type MemoryRecord,
  type LearningSettings
} from './learning-memory'
import type { LearningWorkbenchSnapshot } from './learning-desktop'
import { LearningActionSchema } from './learning-desktop'
import { LearningPublicationStatusSchema } from './learning-publication-status'

const Id = z.string().trim().min(1).max(128)
const Count = z.number().int().nonnegative().safe()
const Revision = z.number().int().positive().safe()
const Hash = z.string().regex(/^[a-f0-9]{64}$/)
const selector = { conversationId: Id.nullable() }
const actions = LearningActionSchema.options
const commands = z.union([
  actions[0].omit({ scope: true }),
  actions[1].omit({ scope: true }),
  actions[2].omit({ scope: true }),
  actions[3].omit({ scope: true }),
  actions[4].omit({ scope: true }),
  actions[5].omit({ scope: true }),
  actions[6].omit({ scope: true }),
  actions[7].omit({ scope: true })
])
export const LearningDesktopManagementRequests = {
  episode: z.strictObject({ ...selector, episodeId: z.uuid() }),
  'model-directory': z.strictObject(selector),
  'episode-correction': LearningCorrectionInputSchema.extend({ ...selector, episodeId: z.uuid() }),
  'episode-result': LearningResultInputSchema.extend({ ...selector, episodeId: z.uuid() }),
  'episode-feedback': LearningHumanFeedbackInputSchema.extend({ ...selector, episodeId: z.uuid() }),
  detail: z.strictObject({ ...selector, id: Id }),
  action: z.strictObject({ ...selector, command: commands }),
  manual: z.strictObject({
    ...selector,
    sourceId: Id,
    content: MemoryContentSchema,
    reason: z.string().trim().min(1).max(2000)
  }),
  review: z.strictObject({ ...selector, episodeId: z.uuid(), sourceId: Id }),
  cancel: z.strictObject({ ...selector, jobId: z.uuid() }),
  calibration: z.strictObject({ ...selector, input: LearningCalibrationInputSchema.optional() }),
  reports: z.strictObject(selector),
  search: z.strictObject({
    ...selector,
    query: z.string().trim().min(1).max(240),
    limit: z.number().int().min(1).max(20)
  }),
  validate: z.strictObject({ ...selector, id: Id, expectedRevision: Revision }),
  curate: z.strictObject({ ...selector, dryRun: z.boolean() })
}

/** Defaults are configuration conveniences, not permission to invent omitted server state. */
export const LearningSettingsResponseSchema: z.ZodType<LearningSettings> = z
  .record(z.string(), z.unknown())
  .refine(
    (raw) => Object.keys(LearningSettingsSchema.shape).every((key) => Object.hasOwn(raw, key)),
    'incomplete_learning_settings'
  )
  .pipe(LearningSettingsSchema)

export const LearningMemoryRecordResponseSchema: z.ZodType<MemoryRecord> = z
  .strictObject({
    id: Id,
    scope: MemoryScopeSchema,
    state: z.enum(['pending', 'active', 'stale', 'archived']),
    currentRevision: Revision,
    activeRevision: Revision.nullable(),
    pinned: z.boolean(),
    content: MemoryContentSchema,
    createdAt: Count,
    updatedAt: Count,
    expiresAt: Count.optional()
  })
  .refine(
    (record) =>
      record.updatedAt >= record.createdAt &&
      (record.activeRevision === null || record.activeRevision <= record.currentRevision) &&
      (record.state !== 'active' || record.activeRevision !== null),
    'inconsistent_memory_record'
  )

export const LearningMemoryRevisionResponseSchema: z.ZodType<MemoryRevision> = z.strictObject({
  memoryId: Id,
  revision: Revision,
  contentHash: Hash,
  content: MemoryContentSchema,
  evidence: MemoryProposalSchema.shape.evidence,
  source: MemoryProposalSchema.shape.source,
  reason: z.string().trim().min(1).max(2000),
  createdAt: Count,
  expiresAt: Count.optional(),
  activatedAt: Count.nullable(),
  redactedEvidenceIds: z.array(Id).max(100).optional(),
  quarantinedAt: Count.optional()
})
export const LearningDetailResponseSchema = z.strictObject({
  memory: LearningMemoryRecordResponseSchema,
  history: z.array(LearningMemoryRevisionResponseSchema).max(10000)
})
export const LearningCalibrationResponseSchema: z.ZodType<LearningCalibrationSet> = z.strictObject({
  cases: z.array(LearningValidationCaseSchema).max(200),
  modeId: Id.optional(),
  authorId: Id.optional(),
  importedAt: Count.optional()
})
export const LearningValidationResultResponseSchema: z.ZodType<LearningValidationResult> = z
  .strictObject({
    status: z.enum(['passed', 'failed', 'insufficient']),
    reasons: z.array(z.string().min(1).max(2000)).max(100),
    grantId: Id.optional(),
    baselineCovered: Count.optional(),
    candidateCovered: Count.optional(),
    caseCount: Count.optional(),
    activated: z.boolean().optional(),
    basisHash: Hash.optional()
  })
  .refine(
    (result) => result.status === 'passed' || (!result.grantId && !result.activated),
    'invalid_validation_authority'
  )
export const LearningCurationReportResponseSchema: z.ZodType<LearningCurationReport> =
  z.strictObject({
    runId: Id,
    dryRun: z.boolean(),
    status: z.enum(['initialized', 'waiting', 'completed', 'failed']),
    reason: z.string().min(1).max(2000).optional(),
    createdAt: Count,
    items: z
      .array(
        z.strictObject({
          memoryId: Id,
          beforeRevision: Revision,
          action: z.enum(['keep', 'stale', 'archive', 'propose_merge']),
          reason: z.string().min(1).max(2000),
          proposedId: Id.optional()
        })
      )
      .max(10000),
    basisHash: Hash.optional()
  })
export const LearningReportsResponseSchema = z.strictObject({
  validation: z
    .array(
      z.strictObject({
        id: Id,
        memoryId: Id,
        revision: Revision,
        createdAt: Count,
        result: LearningValidationResultResponseSchema
      })
    )
    .max(100),
  curation: z.array(LearningCurationReportResponseSchema).max(100)
})
export type LearningReports = z.infer<typeof LearningReportsResponseSchema>

export const LearningWorkbenchSnapshotSchema: z.ZodType<LearningWorkbenchSnapshot> = z.strictObject(
  {
    scope: MemoryScopeSchema,
    scopes: z.array(MemoryScopeSchema).max(502),
    settings: LearningSettingsResponseSchema,
    publication: LearningPublicationStatusSchema.optional(),
    memories: z
      .array(
        z.strictObject({
          record: LearningMemoryRecordResponseSchema,
          metrics: z.strictObject({
            loaded: Count,
            model_reported: Count,
            adopted: Count,
            substantially_corrected: Count,
            delivery_confirmed: Count,
            outcome_confirmed: Count,
            fact_error: Count,
            repeated_question: Count,
            improper_commitment: Count
          })
        })
      )
      .max(10000),
    episodes: z.array(LearningEpisodeSchema).max(100),
    jobs: z
      .array(
        z.strictObject({
          id: Id,
          scope: MemoryScopeSchema,
          episodeIds: z.array(Id).min(1).max(100),
          triggers: z.array(LearningTriggerSchema).min(1).max(5),
          state: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled']),
          attempts: Count,
          availableAt: Count,
          createdAt: Count,
          updatedAt: Count,
          lastError: z.string().max(2000).nullable(),
          leaseUntil: Count.nullable(),
          claimToken: Id.nullable(),
          proposedIds: z.array(Id).max(5)
        })
      )
      .max(100),
    usage: z.strictObject({
      reservedTokens: Count,
      inputTokens: Count,
      outputTokens: Count,
      requests: Count,
      estimatedRequests: Count,
      reportedRequests: Count,
      day: z.iso.date()
    }),
    unassigned: z
      .array(
        z.strictObject({
          id: Id,
          content: MemoryContentSchema,
          state: z.literal('pending'),
          legacyStats: z.strictObject({ used: Count, success: Count }),
          original: z.unknown(),
          importedAt: Count
        })
      )
      .max(10000)
  }
)
