import { z } from 'zod'
import { LearningActionSchema } from '../../../src/shared/contracts/learning-desktop'
import { LearningDesktopManagementRequests } from '../../../src/shared/contracts/learning-management'
import {
  LearningTaskCorrectionSchema,
  LearningTaskResultSchema,
  LearningTaskFeedbackSchema
} from '../../../src/shared/contracts/learning-events'
import {
  LearningSettingsPatchSchema,
  LearningCalibrationInputSchema,
  MemoryContentSchema
} from '../../../src/shared/contracts/learning-memory'

const Id = z.string().trim().min(1).max(128)
const scope = { conversationId: Id.nullable().default(null) }
export const LearningManagementOperations = [
  'episode',
  'model-directory',
  'snapshot',
  'correction',
  'result',
  'feedback',
  'episode-correction',
  'episode-result',
  'episode-feedback',
  'detail',
  'settings',
  'action',
  'manual',
  'review',
  'cancel',
  'forget-scope',
  'calibration',
  'reports',
  'search',
  'validate',
  'curate'
] as const
export type LearningManagementOperation = (typeof LearningManagementOperations)[number]
const actions = LearningActionSchema.options
const variants = [
  actions[0].omit({ scope: true }),
  actions[1].omit({ scope: true }),
  actions[2].omit({ scope: true }),
  actions[3].omit({ scope: true }),
  actions[4].omit({ scope: true }),
  actions[5].omit({ scope: true }),
  actions[6].omit({ scope: true }),
  actions[7].omit({ scope: true })
] as const
export const LearningManagementRequests = {
  episode: LearningDesktopManagementRequests.episode,
  'model-directory': LearningDesktopManagementRequests['model-directory'],
  'episode-correction': LearningDesktopManagementRequests['episode-correction'],
  'episode-result': LearningDesktopManagementRequests['episode-result'],
  'episode-feedback': LearningDesktopManagementRequests['episode-feedback'],
  correction: LearningTaskCorrectionSchema,
  result: LearningTaskResultSchema,
  feedback: LearningTaskFeedbackSchema,
  snapshot: z.strictObject(scope),
  detail: z.strictObject({ ...scope, id: Id }),
  settings: z.strictObject({ ...scope, patch: LearningSettingsPatchSchema.optional() }),
  action: z.strictObject({ ...scope, command: z.union(variants) }),
  manual: z.strictObject({
    ...scope,
    sourceId: Id,
    content: MemoryContentSchema,
    reason: z.string().trim().min(1).max(2000)
  }),
  review: z.strictObject({ ...scope, episodeId: z.uuid(), sourceId: Id }),
  cancel: z.strictObject({ ...scope, jobId: z.uuid() }),
  'forget-scope': z.strictObject(scope),
  calibration: z.strictObject({ ...scope, input: LearningCalibrationInputSchema.optional() }),
  reports: z.strictObject(scope),
  search: z.strictObject({
    ...scope,
    query: z.string().trim().min(1).max(240),
    limit: z.number().int().min(1).max(20).default(10)
  }),
  validate: z.strictObject({ ...scope, id: Id, expectedRevision: z.number().int().positive() }),
  curate: z.strictObject({ ...scope, dryRun: z.boolean().default(true) })
}
export class LearningManagementError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code)
  }
}
const conflicts = new Set([
  'memory_revision_conflict',
  'memory_revision_not_found',
  'memory_pinned',
  'memory_expired',
  'memory_evidence_unavailable',
  'memory_forgotten',
  'memory_revision_quarantined',
  'episode_source_conflict',
  'episode_forgotten',
  'learning_event_conflict',
  'feedback_memory_not_loaded',
  'feedback_source_conflict',
  'calibration_human_labels_required',
  'calibration_duplicate_case',
  'curation_replacement_changed',
  'curation_merge_evidence_incomplete',
  'learning_disabled',
  'learning_background_busy',
  'validation_context_changed',
  'review_model_unavailable'
])
/** Only host-defined failures become public codes. SQL/upstream messages remain private. */
export function mapLearningManagementFailure(error: unknown): never {
  if (error instanceof Error) {
    if (['memory_not_found', 'learning_job_not_found', 'episode_not_found'].includes(error.message))
      throw new LearningManagementError(404, error.message)
    if (conflicts.has(error.message)) throw new LearningManagementError(409, error.message)
  }
  throw error
}
