import { describe, expect, it } from 'vitest'
import { resolveLearningReviewModel } from '../../src/core/memory/learning-model-configuration'
import * as modelConfiguration from '../../src/core/memory/learning-model-configuration'
import { LearningSettingsSchema } from '../../src/shared/contracts/learning-memory'

const normal = {
  id: 'normal',
  provider: 'openai',
  modelName: 'normal-model',
  apiKey: 'test-only',
  baseURL: 'https://example.com/v1',
  capabilities: ['text']
}
const review = { ...normal, id: 'review', provider: 'custom', modelName: 'review-model' }
describe('trusted independent review model configuration', () => {
  it('publishes names only for configured text-capable host models', () => {
    const directory = modelConfiguration.learningReviewModelDirectory([
      { ...review, name: '专用复盘模型' },
      { ...normal, id: 'vision-only', capabilities: ['vision'] },
      { ...normal, id: 'missing-key', apiKey: ' ' },
      { ...normal, id: 'missing-model', modelName: '' },
      { ...normal, id: 'missing-endpoint', baseURL: '' },
      normal
    ])
    expect(directory).toEqual([
      { id: 'review', label: '专用复盘模型' },
      { id: 'normal', label: 'normal-model' }
    ])
    expect(JSON.stringify(directory)).not.toContain('test-only')
    expect(JSON.stringify(directory)).not.toContain('https://example.com')
  })
  it('inherits the configured reply model by default and exposes bounded review limits', () => {
    expect(
      resolveLearningReviewModel(LearningSettingsSchema.parse({}), [normal, review], normal)
    ).toMatchObject({
      providerId: 'openai',
      modelId: 'normal',
      modelName: 'normal-model',
      maxInputTokens: 8000,
      maxOutputTokens: 2000
    })
  })
  it('selects a dedicated host model and never silently substitutes a missing selection', () => {
    const settings = LearningSettingsSchema.parse({ reviewModelId: 'review' })
    expect(resolveLearningReviewModel(settings, [normal, review], normal)).toMatchObject({
      modelId: 'review',
      modelName: 'review-model'
    })
    expect(() => resolveLearningReviewModel(settings, [normal], normal)).toThrow(
      'review_model_unavailable'
    )
  })
  it('reports missing credentials and unsupported text capability explicitly', () => {
    const settings = LearningSettingsSchema.parse({})
    expect(() => resolveLearningReviewModel(settings, [], null)).toThrow(
      'review_model_unconfigured'
    )
    expect(() => resolveLearningReviewModel(settings, [], { ...normal, apiKey: '' })).toThrow(
      'review_model_unconfigured'
    )
    expect(() =>
      resolveLearningReviewModel(settings, [], { ...normal, capabilities: ['vision'] })
    ).toThrow('review_text_model_required')
  })
})
