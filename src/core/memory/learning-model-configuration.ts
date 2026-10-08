import type {
  LearningSettings,
  ReviewModelConfiguration
} from '../../shared/contracts/learning-memory'
import { MAX_REVIEW_OUTPUT_TOKENS } from './learning-jobs'
import { LearningReviewFailure } from './learning-reviewer'
import {
  LearningModelDirectorySchema,
  type LearningModelDirectory
} from '../../shared/contracts/learning-model-directory'

interface HostModel {
  id: string
  name?: string
  provider: string
  modelName: string
  apiKey: string
  baseURL: string
  capabilities: readonly string[]
}
export function learningReviewModelDirectory(models: readonly HostModel[]): LearningModelDirectory {
  return LearningModelDirectorySchema.parse(
    models
      .filter(
        (model) =>
          model.apiKey.trim() &&
          model.modelName.trim() &&
          model.baseURL.trim() &&
          model.capabilities.includes('text')
      )
      .map((model) => ({ id: model.id, label: model.name?.trim() || model.modelName }))
  )
}
export interface ResolvedReviewModel extends ReviewModelConfiguration {
  modelName: string
  apiKey: string
  baseURL: string
}
/** This catalogue comes from host settings; no credential or endpoint is accepted from case text. */
export function resolveLearningReviewModel(
  settings: LearningSettings,
  models: readonly HostModel[],
  fallback: HostModel | null
): ResolvedReviewModel {
  const fail = (code: string): never => {
    throw new LearningReviewFailure(code, {
      inputTokens: 0,
      outputTokens: 0,
      measurement: 'not_dispatched'
    })
  }
  const selected = settings.reviewModelId
    ? models.find((model) => model.id === settings.reviewModelId)
    : fallback
  if (!selected)
    fail(settings.reviewModelId ? 'review_model_unavailable' : 'review_model_unconfigured')
  if (!selected!.apiKey.trim() || !selected!.modelName.trim()) fail('review_model_unconfigured')
  if (!selected!.capabilities.includes('text')) fail('review_text_model_required')
  const configured = selected!
  return {
    providerId: configured.provider,
    modelId: configured.id,
    modelName: configured.modelName,
    apiKey: configured.apiKey,
    baseURL: configured.baseURL,
    maxInputTokens: settings.maxReviewInputTokens,
    maxOutputTokens: MAX_REVIEW_OUTPUT_TOKENS
  }
}
