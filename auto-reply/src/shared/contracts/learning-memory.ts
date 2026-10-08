import { z } from 'zod'

const Identifier = z.string().trim().min(1).max(128)
const Timestamp = z.number().int().nonnegative().safe()
export const MemoryScopeSchema = z
  .strictObject({
    workspaceId: Identifier,
    platform: z.enum(['wechat', 'wework', 'generic']),
    tenantId: Identifier.optional(),
    accountId: Identifier.optional(),
    conversationId: Identifier.optional()
  })
  .refine(
    (scope) => Boolean(scope.tenantId) === Boolean(scope.accountId),
    'enterprise_scope_incomplete'
  )
export type MemoryScope = z.infer<typeof MemoryScopeSchema>

export const NewLearningEpisodeSchema = z
  .strictObject({
    identityStatus: z.enum(['verified', 'unassigned', 'account']).optional(),
    sourceId: Identifier,
    topic: z.string().trim().min(1).max(240),
    startedAt: Timestamp,
    endedAt: Timestamp.optional(),
    messages: z
      .array(
        z.strictObject({
          sourceId: Identifier,
          role: z.enum(['customer', 'employee', 'assistant']),
          text: z.string().max(10000)
        })
      )
      .max(100),
    draft: z.string().max(10000).optional(),
    correction: z.string().max(10000).optional(),
    correctionReason: z.string().trim().max(2000).optional(),
    outcome: z.enum(['resolved', 'corrected', 'failed', 'handoff', 'unknown'])
  })
  .refine(
    (episode) => episode.endedAt === undefined || episode.endedAt >= episode.startedAt,
    'invalid_episode_time'
  )
export type NewLearningEpisode = z.infer<typeof NewLearningEpisodeSchema>
export const LearningCorrectionInputSchema = z.strictObject({
  sourceId: Identifier,
  text: z.string().trim().min(1).max(10000),
  reason: z.string().trim().min(1).max(2000)
})
export type LearningCorrectionInput = z.infer<typeof LearningCorrectionInputSchema>
export const LearningResultInputSchema = z.strictObject({
  sourceId: Identifier,
  outcome: z.enum(['resolved', 'failed', 'handoff']),
  reason: z.string().trim().min(1).max(2000)
})
export type LearningResultInput = z.infer<typeof LearningResultInputSchema>
export const LearningHumanFeedbackInputSchema = z.strictObject({
  sourceId: Identifier,
  kind: z.enum(['adopted', 'fact_error', 'repeated_question', 'improper_commitment']),
  reason: z.string().trim().min(1).max(2000),
  memoryId: Identifier.optional()
})
export type LearningHumanFeedbackInput = z.infer<typeof LearningHumanFeedbackInputSchema>
export const LearningEpisodeSchema = NewLearningEpisodeSchema.safeExtend({
  id: Identifier,
  scope: MemoryScopeSchema,
  createdAt: Timestamp
})
export type LearningEpisode = z.infer<typeof LearningEpisodeSchema>

const MemoryRefSchema = z.strictObject({ id: Identifier, revision: z.number().int().positive() })
/** These events are host supplied. Renderer/model text cannot establish a problem identity. */
export const EpisodeMessageEventSchema = z.strictObject({
  scope: MemoryScopeSchema,
  problemId: Identifier,
  sourceId: Identifier,
  message: NewLearningEpisodeSchema.shape.messages.element,
  generationId: Identifier.optional(),
  loadedMemoryRefs: z.array(MemoryRefSchema).max(20).optional(),
  at: Timestamp
})
export type EpisodeMessageEvent = z.infer<typeof EpisodeMessageEventSchema>
export const EpisodeCloseEventSchema = z.strictObject({
  scope: MemoryScopeSchema,
  problemId: Identifier,
  sourceId: Identifier,
  outcome: NewLearningEpisodeSchema.shape.outcome,
  at: Timestamp
})
export type EpisodeCloseEvent = z.infer<typeof EpisodeCloseEventSchema>

export const MemoryContentSchema = z.strictObject({
  kind: z.enum(['preference', 'lesson', 'skill']),
  scenario: z.string().trim().min(1).max(1000),
  guidance: z.string().trim().min(1).max(6000),
  rationale: z.string().trim().max(2000).default(''),
  steps: z.array(z.string().trim().min(1).max(1000)).max(30).default([]),
  pitfalls: z.array(z.string().trim().min(1).max(1000)).max(20).default([]),
  verification: z.array(z.string().trim().min(1).max(1000)).max(20).default([])
})
export type MemoryContent = z.infer<typeof MemoryContentSchema>
export const MemoryEvidenceSchema = z.strictObject({ episodeId: Identifier })
export const MemoryProposalSchema = z.strictObject({
  content: MemoryContentSchema,
  evidence: z.array(MemoryEvidenceSchema).min(1).max(100),
  source: z.enum(['review', 'human', 'manual', 'curator']),
  reason: z.string().trim().min(1).max(2000),
  expiresAt: Timestamp.optional()
})
export type MemoryProposal = z.infer<typeof MemoryProposalSchema>
export type MemoryState = 'pending' | 'active' | 'stale' | 'archived'
export interface MemoryRecord {
  id: string
  scope: MemoryScope
  state: MemoryState
  currentRevision: number
  activeRevision: number | null
  pinned: boolean
  content: MemoryContent
  createdAt: number
  updatedAt: number
  expiresAt?: number
}
export interface MemoryRevision {
  memoryId: string
  revision: number
  contentHash: string
  content: MemoryContent
  evidence: MemoryProposal['evidence']
  source: MemoryProposal['source']
  reason: string
  createdAt: number
  expiresAt?: number
  activatedAt: number | null
  redactedEvidenceIds?: string[]
  quarantinedAt?: number
}
export interface RetentionReport {
  deletedEpisodes: number
  redactedEvidence: number
  invalidatedMethods: string[]
}
export const LearningFeedbackSchema = z.strictObject({
  sourceId: Identifier,
  episodeId: Identifier,
  kind: z.enum([
    'loaded',
    'model_reported',
    'adopted',
    'substantially_corrected',
    'delivery_confirmed',
    'outcome_confirmed',
    'fact_error',
    'repeated_question',
    'improper_commitment'
  ]),
  memoryRefs: z
    .array(z.strictObject({ id: Identifier, revision: z.number().int().positive() }))
    .max(20),
  at: Timestamp,
  reason: z.string().max(2000).optional()
})
export type LearningFeedback = z.infer<typeof LearningFeedbackSchema>
export type LearningMetrics = Record<LearningFeedback['kind'], number>
export const LearningSettingsSchema = z.strictObject({
  memoryEnabled: z.boolean().default(true),
  mode: z.enum(['off', 'suggest', 'auto']).default('suggest'),
  maxEntries: z.number().int().min(1).max(5).default(5),
  maxContextTokens: z.number().int().min(128).max(2000).default(2000),
  concurrency: z.literal(1).default(1),
  idleDelayMs: z.number().int().min(1000).max(300000).default(15000),
  reviewTimeoutMs: z.number().int().min(1000).max(120000).default(30000),
  maxReviewInputTokens: z.number().int().min(256).max(16000).default(8000),
  dailyReviewTokenBudget: z.number().int().min(0).max(1000000).default(50000),
  maxAttempts: z.number().int().min(1).max(5).default(3),
  caseRetentionDays: z.number().int().min(7).max(365).default(90),
  reviewModelId: z.string().trim().max(128).default(''),
  curationEnabled: z.boolean().default(true),
  curatorMergeEnabled: z.boolean().default(false)
})
export type LearningSettings = z.infer<typeof LearningSettingsSchema>
export const LearningSettingsPatchSchema = z.strictObject({
  memoryEnabled: LearningSettingsSchema.shape.memoryEnabled.removeDefault().optional(),
  mode: LearningSettingsSchema.shape.mode.removeDefault().optional(),
  maxEntries: LearningSettingsSchema.shape.maxEntries.removeDefault().optional(),
  maxContextTokens: LearningSettingsSchema.shape.maxContextTokens.removeDefault().optional(),
  concurrency: LearningSettingsSchema.shape.concurrency.removeDefault().optional(),
  idleDelayMs: LearningSettingsSchema.shape.idleDelayMs.removeDefault().optional(),
  reviewTimeoutMs: LearningSettingsSchema.shape.reviewTimeoutMs.removeDefault().optional(),
  maxReviewInputTokens: LearningSettingsSchema.shape.maxReviewInputTokens
    .removeDefault()
    .optional(),
  dailyReviewTokenBudget: LearningSettingsSchema.shape.dailyReviewTokenBudget
    .removeDefault()
    .optional(),
  maxAttempts: LearningSettingsSchema.shape.maxAttempts.removeDefault().optional(),
  caseRetentionDays: LearningSettingsSchema.shape.caseRetentionDays.removeDefault().optional(),
  reviewModelId: LearningSettingsSchema.shape.reviewModelId.removeDefault().optional(),
  curationEnabled: LearningSettingsSchema.shape.curationEnabled.removeDefault().optional(),
  curatorMergeEnabled: LearningSettingsSchema.shape.curatorMergeEnabled.removeDefault().optional()
})

export interface UnassignedMemory {
  id: string
  content: MemoryContent
  state: 'pending'
  legacyStats: { used: number; success: number }
  original: unknown
  importedAt: number
}

export interface MemorySnapshotItem {
  id: string
  revision: number
  scope: MemoryScope
  content: MemoryContent
  contentHash: string
  evidence: MemoryProposal['evidence']
  expiresAt?: number
}
export interface MemorySnapshot {
  snapshotId: string
  corpusVersion: string
  scope: MemoryScope
  items: MemorySnapshotItem[]
  estimatedTokens: number
  contextVersion?: string
  excludedCaseSourceId?: string
}

export const LearningTriggerSchema = z.enum([
  'correction',
  'completed',
  'repeated_failure',
  'severe_error',
  'manual'
])
export type LearningTrigger = z.infer<typeof LearningTriggerSchema>
export interface LearningJob {
  id: string
  scope: MemoryScope
  episodeIds: string[]
  triggers: LearningTrigger[]
  state: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  attempts: number
  availableAt: number
  createdAt: number
  updatedAt: number
  lastError: string | null
  leaseUntil: number | null
  claimToken: string | null
  proposedIds: string[]
}
export interface ClaimedLearningJob extends LearningJob {
  claimToken: string
  leaseUntil: number
  reservedTokens: number
}
export const ReviewUsageSchema = z
  .strictObject({
    inputTokens: z.number().int().nonnegative().safe(),
    outputTokens: z.number().int().nonnegative().safe(),
    measurement: z.enum(['reported', 'upper_bound', 'not_dispatched']).optional()
  })
  .refine(
    (usage) =>
      usage.measurement !== 'not_dispatched' ||
      (usage.inputTokens === 0 && usage.outputTokens === 0),
    'undispatched_usage_must_be_zero'
  )
export type ReviewUsage = z.infer<typeof ReviewUsageSchema>

const ReviewProposalSchema = MemoryProposalSchema.omit({ source: true })
export const LearningReviewOperationSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('create'), proposal: ReviewProposalSchema }),
  z.strictObject({
    action: z.literal('revise'),
    memoryId: Identifier,
    expectedRevision: z.number().int().positive(),
    proposal: ReviewProposalSchema
  })
])
export const LearningReviewResponseSchema = z.strictObject({
  operations: z.array(LearningReviewOperationSchema).max(5)
})
export type LearningReviewOperation = z.infer<typeof LearningReviewOperationSchema>
export interface LearningReviewRequest {
  episodes: LearningEpisode[]
  memories: MemoryRecord[]
  feedback: LearningFeedback[]
  settings: LearningSettings
  loadedRevisions?: Pick<MemoryRevision, 'memoryId' | 'revision' | 'contentHash' | 'content'>[]
}
export interface ReviewModelConfiguration {
  providerId: string
  modelId: string
  maxInputTokens: number
  maxOutputTokens: number
}
export interface LearningReviewResult {
  operations: LearningReviewOperation[]
  usage: ReviewUsage
}

export const LearningValidationCaseSchema = z.strictObject({
  caseId: Identifier,
  conversationId: Identifier,
  input: z.string().trim().min(1).max(10000),
  expectedMethod: z.string().trim().min(1).max(2000),
  requiredTerms: z.array(z.string().trim().min(1).max(240)).min(1).max(30).optional(),
  forbiddenClaims: z.array(z.string().trim().min(1).max(1000)).max(100),
  humanLabelled: z.boolean(),
  labelOrigin: z.enum(['human', 'synthetic', 'model', 'unknown']).optional()
})
export type LearningValidationCase = z.infer<typeof LearningValidationCaseSchema>
export function isHumanCalibrationCase(example: LearningValidationCase): boolean {
  return example.humanLabelled && example.labelOrigin === 'human'
}
export const LearningCalibrationInputSchema = z.strictObject({
  cases: z.array(LearningValidationCaseSchema).max(200),
  humanConfirmed: z.literal(true),
  modeId: Identifier.optional()
})
export type LearningCalibrationInput = z.infer<typeof LearningCalibrationInputSchema>
export interface LearningCalibrationSet {
  cases: LearningValidationCase[]
  modeId?: string
  authorId?: string
  importedAt?: number
}
export const LearningValidationEnvironmentSchema = z.strictObject({
  knowledgeVersion: Identifier,
  policyVersion: Identifier,
  validatorVersion: Identifier,
  datasetHash: z.string().regex(/^[a-f0-9]{64}$/)
})
export type LearningValidationEnvironment = z.infer<typeof LearningValidationEnvironmentSchema>
export interface LearningValidationResult {
  status: 'passed' | 'failed' | 'insufficient'
  reasons: string[]
  grantId?: string
  baselineCovered?: number
  candidateCovered?: number
  caseCount?: number
  activated?: boolean
  basisHash?: string
}
export interface LearningValidationReport {
  id: string
  memoryId: string
  revision: number
  createdAt: number
  result: LearningValidationResult
}
export interface MemoryActivationGrant extends LearningValidationEnvironment {
  validationPolicyVersion?: 'independent-human-origin-v2'
  id: string
  scope: MemoryScope
  memoryId: string
  revision: number
  contentHash: string
  evidenceHash: string
  corpusVersion: string
  environmentEpoch: number
  result: 'passed'
  issuedAt: number
  expiresAt: number
  baselineCovered: number
  candidateCovered: number
  caseIds: string[]
  usedAt: number | null
}
export const LearningRiskSemanticAssessmentSchema = z.strictObject({
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  units: z
    .array(
      z.strictObject({
        path: z.string().trim().min(1).max(128),
        category: z.enum([
          'method',
          'preference',
          'business_fact',
          'authority_change',
          'unsafe',
          'uncertain'
        ]),
        reason: z.string().trim().min(1).max(1000)
      })
    )
    .max(100)
})
export type LearningRiskSemanticAssessment = z.infer<typeof LearningRiskSemanticAssessmentSchema>

export interface LearningCurationItem {
  memoryId: string
  beforeRevision: number
  action: 'keep' | 'stale' | 'archive' | 'propose_merge'
  reason: string
  proposedId?: string
}
export interface LearningCurationReport {
  runId: string
  dryRun: boolean
  status: 'initialized' | 'waiting' | 'completed' | 'failed'
  reason?: string
  createdAt: number
  items: LearningCurationItem[]
  basisHash?: string
}
export interface LearningCurationState {
  observedAt: number | null
  lastRunAt: number | null
  lastActivityAt: number
  epoch: number
}
