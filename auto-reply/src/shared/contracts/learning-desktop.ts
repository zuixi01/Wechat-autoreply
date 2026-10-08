import { z } from 'zod'
import type { LearningModelDirectory } from './learning-model-directory'
import {
  MemoryScopeSchema,
  MemoryContentSchema,
  LearningCalibrationInputSchema,
  LearningSettingsPatchSchema,
  MemoryProposalSchema,
  LearningResultInputSchema,
  LearningHumanFeedbackInputSchema,
  type LearningSettings,
  type MemoryScope,
  type MemoryRecord,
  type MemoryRevision,
  type LearningEpisode,
  type LearningMetrics,
  type LearningJob,
  type UnassignedMemory,
  type MemoryProposal
} from './learning-memory'
import type {
  LearningCalibrationInput,
  LearningCalibrationSet,
  LearningValidationResult,
  LearningCurationReport
} from './learning-memory'
import type { LearningReports } from './learning-management'
import type { LearningPublicationStatus } from './learning-publication-status'

const Id = z.string().trim().min(1).max(128)
const target = { scope: MemoryScopeSchema, id: Id, expectedRevision: z.number().int().positive() }
const proposal = MemoryProposalSchema.omit({ source: true }).shape
export const LearningActionSchema = z.discriminatedUnion('action', [
  z.strictObject({ scope: MemoryScopeSchema, action: z.literal('propose'), ...proposal }),
  z.strictObject({ ...target, action: z.literal('revise'), ...proposal }),
  z.strictObject({ ...target, action: z.literal('activate') }),
  z.strictObject({ ...target, action: z.literal('pin'), pinned: z.boolean() }),
  z.strictObject({ ...target, action: z.literal('archive') }),
  z.strictObject({ ...target, action: z.literal('restore') }),
  z.strictObject({ ...target, action: z.literal('forget') }),
  z.strictObject({
    ...target,
    action: z.literal('rollback'),
    targetRevision: z.number().int().positive()
  })
])
export type LearningAction = z.infer<typeof LearningActionSchema>
export const LearningCorrectionSchema = z.strictObject({
  scope: MemoryScopeSchema,
  episodeId: Id,
  sourceId: Id,
  text: z.string().trim().min(1).max(10000),
  reason: z.string().trim().min(1).max(2000)
})
export const LearningResultSchema = LearningResultInputSchema.extend({
  scope: MemoryScopeSchema,
  episodeId: Id
})
export const LearningHumanFeedbackSchema = LearningHumanFeedbackInputSchema.extend({
  scope: MemoryScopeSchema,
  episodeId: Id
})
export { LearningSettingsPatchSchema } from './learning-memory'
export const LearningDesktopRequests = {
  episode: z.strictObject({ scope: MemoryScopeSchema, episodeId: z.uuid() }),
  'model-directory': z.strictObject({ scope: MemoryScopeSchema }),
  snapshot: z.strictObject({ scope: MemoryScopeSchema.optional() }),
  detail: z.strictObject({ scope: MemoryScopeSchema, id: Id }),
  settings: z.strictObject({ scope: MemoryScopeSchema, patch: LearningSettingsPatchSchema }),
  act: LearningActionSchema,
  correct: LearningCorrectionSchema,
  result: LearningResultSchema,
  feedback: LearningHumanFeedbackSchema,
  review: z.strictObject({ scope: MemoryScopeSchema, episodeId: Id, sourceId: Id }),
  cancel: z.strictObject({ scope: MemoryScopeSchema, jobId: Id }),
  'forget-scope': z.strictObject({ scope: MemoryScopeSchema }),
  manual: z.strictObject({
    scope: MemoryScopeSchema,
    sourceId: Id,
    content: MemoryContentSchema,
    reason: z.string().trim().min(1).max(2000)
  }),
  'assign-legacy': z.strictObject({ scope: MemoryScopeSchema, legacyId: Id, sourceId: Id }),
  calibration: z.strictObject({ scope: MemoryScopeSchema }),
  'import-calibration': z.strictObject({
    scope: MemoryScopeSchema,
    input: LearningCalibrationInputSchema
  }),
  validate: z.strictObject(target),
  curate: z.strictObject({ scope: MemoryScopeSchema, dryRun: z.boolean() }),
  search: z.strictObject({
    scope: MemoryScopeSchema,
    query: z.string().trim().min(1).max(240),
    limit: z.number().int().min(1).max(20).default(10)
  }),
  reports: z.strictObject({ scope: MemoryScopeSchema })
}
export interface LearningUsageReport {
  reservedTokens: number
  inputTokens: number
  outputTokens: number
  requests: number
  estimatedRequests: number
  reportedRequests: number
  day: string
}
export interface LearningWorkbenchSnapshot {
  scope: MemoryScope
  scopes: MemoryScope[]
  settings: LearningSettings
  memories: { record: MemoryRecord; metrics: LearningMetrics }[]
  episodes: LearningEpisode[]
  jobs: LearningJob[]
  usage: LearningUsageReport
  unassigned: UnassignedMemory[]
  publication?: LearningPublicationStatus
}
export interface LearningMemoryDesktopApi {
  episode(input: { scope: MemoryScope; episodeId: string }): Promise<LearningEpisode>
  modelDirectory(input: { scope: MemoryScope }): Promise<LearningModelDirectory>
  snapshot(input?: { scope?: MemoryScope }): Promise<LearningWorkbenchSnapshot>
  detail(input: {
    scope: MemoryScope
    id: string
  }): Promise<{ memory: MemoryRecord; history: MemoryRevision[] }>
  settings(input: {
    scope: MemoryScope
    patch: Partial<LearningSettings>
  }): Promise<LearningSettings>
  act(input: LearningAction): Promise<MemoryRecord | null>
  correct(input: z.infer<typeof LearningCorrectionSchema>): Promise<LearningEpisode>
  confirmResult(input: z.infer<typeof LearningResultSchema>): Promise<LearningEpisode>
  feedback(input: z.infer<typeof LearningHumanFeedbackSchema>): Promise<void>
  review(input: {
    scope: MemoryScope
    episodeId: string
    sourceId: string
  }): Promise<{ jobId: string | null }>
  cancel(input: { scope: MemoryScope; jobId: string }): Promise<void>
  forgetScope(input: { scope: MemoryScope }): Promise<void>
  manual(input: {
    scope: MemoryScope
    sourceId: string
    content: MemoryProposal['content']
    reason: string
  }): Promise<MemoryRecord>
  assignLegacy(input: {
    scope: MemoryScope
    legacyId: string
    sourceId: string
  }): Promise<MemoryRecord>
  calibration(input: { scope: MemoryScope }): Promise<LearningCalibrationSet>
  importCalibration(input: {
    scope: MemoryScope
    input: LearningCalibrationInput
  }): Promise<LearningCalibrationSet>
  validate(input: {
    scope: MemoryScope
    id: string
    expectedRevision: number
  }): Promise<LearningValidationResult>
  curate(input: { scope: MemoryScope; dryRun: boolean }): Promise<LearningCurationReport>
  searchEpisodes(input: {
    scope: MemoryScope
    query: string
    limit?: number
  }): Promise<LearningEpisode[]>
  reports(input: { scope: MemoryScope }): Promise<LearningReports>
}
