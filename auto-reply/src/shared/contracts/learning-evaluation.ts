import { z } from 'zod'
import { Hash, Id } from './identity'

export const LEARNING_EVALUATION_MAX_CASES = 100000

const timestamp = z.number().int().nonnegative().safe()
const label = z.strictObject({
  origin: z.enum(['human', 'synthetic', 'model']),
  reviewerId: Id.optional(),
  evidenceRef: Id.optional(),
  blinded: z.boolean(),
  assignmentRef: Id.optional(),
  labelledAt: timestamp
})
const outcome = z
  .strictObject({
    reply: z.string().min(1).max(16000).nullable(),
    humanReviewed: z.boolean().optional(),
    substantialCorrection: z.boolean(),
    severeError: z.boolean(),
    validAnswer: z.boolean(),
    latencyMs: z.number().finite().nonnegative(),
    latencyComplete: z.boolean().optional(),
    latencyEvidenceRef: Id.optional(),
    inputTokens: z.number().int().nonnegative().safe(),
    outputTokens: z.number().int().nonnegative().safe(),
    costUsd: z.number().finite().nonnegative(),
    generatedAt: timestamp,
    configurationHash: Hash,
    memoryManifestHash: Hash
  })
  .superRefine((value, ctx) => {
    if (
      value.humanReviewed === false &&
      (value.substantialCorrection || value.severeError || value.validAnswer)
    ) {
      ctx.addIssue({ code: 'custom', message: 'unreviewed_output_cannot_have_positive_labels' })
    }
    if (value.humanReviewed === true && value.reply === null) {
      ctx.addIssue({ code: 'custom', message: 'reviewed_draft_requires_reply' })
    }
    if (value.severeError && (!value.substantialCorrection || value.reply === null)) {
      ctx.addIssue({ code: 'custom', message: 'severe_error_requires_reply_and_correction' })
    }
    if (value.validAnswer && value.reply === null) {
      ctx.addIssue({ code: 'custom', message: 'valid_answer_requires_reply' })
    }
  })
const source = { caseId: Id, conversationId: Id, label }
export const LearningEvaluationCaseSchema = z.discriminatedUnion('split', [
  z.strictObject({ ...source, split: z.literal('learn') }),
  z.strictObject({ ...source, split: z.literal('calibrate') }),
  z.strictObject({
    ...source,
    split: z.literal('evaluate'),
    category: z.enum(['inquiry', 'complaint', 'handoff', 'multiple_intents']).optional(),
    none: outcome.optional(),
    baseline: outcome,
    learned: outcome
  })
])
export const LearningEvaluationDatasetSchema = z
  .strictObject({
    version: z.union([z.literal(1), z.literal(2)]),
    datasetId: Id,
    origin: z.enum(['business_observation', 'synthetic', 'model']),
    rubricRef: Id,
    frozen: z.strictObject({
      frozenAt: timestamp,
      sharedConfigurationHash: Hash,
      staticMemoryManifestHash: Hash,
      learnedMemoryManifestHash: Hash,
      noMemoryManifestHash: Hash.optional(),
      modelVersion: Id,
      knowledgeVersion: Id,
      policyVersion: Id.optional(),
      retrievalVersion: Id.optional(),
      backgroundCostUsd: z.number().finite().nonnegative().optional(),
      latencyScope: z
        .enum(['knowledge_preview', 'enterprise_pipeline', 'foreground_end_to_end'])
        .optional(),
      methods: z
        .array(
          z.strictObject({
            id: Id,
            revision: z.number().int().positive().safe(),
            contentHash: Hash,
            sourceCaseIds: z.array(Id).min(1).max(10000)
          })
        )
        .min(1)
        .max(10000)
    }),
    cases: z.array(LearningEvaluationCaseSchema).min(1).max(LEARNING_EVALUATION_MAX_CASES)
  })
  .superRefine((value, ctx) => {
    if (value.version === 2) {
      for (const key of [
        'noMemoryManifestHash',
        'policyVersion',
        'retrievalVersion',
        'backgroundCostUsd'
      ] as const) {
        if (value.frozen[key] === undefined)
          ctx.addIssue({
            code: 'custom',
            path: ['frozen', key],
            message: 'v2_frozen_evidence_required'
          })
      }
      value.cases.forEach((item, index) => {
        if (item.split !== 'evaluate') return
        if (!item.none || !item.category)
          ctx.addIssue({
            code: 'custom',
            path: ['cases', index],
            message: 'v2_three_arms_and_category_required'
          })
        for (const arm of ['none', 'baseline', 'learned'] as const) {
          if (item[arm]?.humanReviewed === undefined)
            ctx.addIssue({
              code: 'custom',
              path: ['cases', index, arm],
              message: 'v2_review_status_required'
            })
        }
      })
    }
    const ids = value.cases.map((item) => item.caseId)
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: 'custom', message: 'duplicate_case_id' })
    }
    const methods = value.frozen.methods.map((item) => item.id)
    if (new Set(methods).size !== methods.length) {
      ctx.addIssue({ code: 'custom', message: 'duplicate_method_id' })
    }
  })
export type LearningEvaluationDataset = z.infer<typeof LearningEvaluationDatasetSchema>
export type LearningEvaluationCase = z.infer<typeof LearningEvaluationCaseSchema>
export type LearningEvaluationPair = Extract<LearningEvaluationCase, { split: 'evaluate' }>
