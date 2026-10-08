import {
  LearningSettingsSchema,
  type LearningSettings
} from '../../shared/contracts/learning-memory'
import { learningHash } from './learning-scope'

export type SafeLearningSettings = Omit<LearningSettings, 'reviewModelId'> & {
  reviewModelIdHash: string
}
export interface LearningSettingsAuditChange {
  beforeHash: string
  afterHash: string
  changedFields: (keyof SafeLearningSettings)[]
  before: SafeLearningSettings
  after: SafeLearningSettings
}

/** The strict settings contract is the allowlist; model identifiers never enter audit text. */
function safeSettings(raw: LearningSettings): SafeLearningSettings {
  const { reviewModelId, ...primitives } = LearningSettingsSchema.parse(raw)
  return { ...primitives, reviewModelIdHash: learningHash(reviewModelId) }
}

/** Only an actual effective value change is an audit event; explicit patches remain in settings. */
export function buildLearningSettingsAudit(
  before: LearningSettings,
  after: LearningSettings
): LearningSettingsAuditChange | null {
  const effectiveBefore = safeSettings(before)
  const effectiveAfter = safeSettings(after)
  const fields = Object.keys(effectiveBefore) as (keyof SafeLearningSettings)[]
  const changedFields = fields
    .filter((field) => effectiveBefore[field] !== effectiveAfter[field])
    .sort()
  // Persisting the first explicit default still changes inheritance, but is not a value change.
  if (!changedFields.length) return null
  return {
    beforeHash: learningHash(effectiveBefore),
    afterHash: learningHash(effectiveAfter),
    changedFields,
    before: effectiveBefore,
    after: effectiveAfter
  }
}
