import { randomInt, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { Hash, Id, IdentitySchema } from '../../src/shared/contracts/identity'
import {
  AnswerSchema,
  JevResponseSchema,
  parseJevResponse
} from '../../src/shared/contracts/decision'
import { hashContext, hashDraft } from '../../src/core/reply/hashes'
import { PublicationSchema } from '../../server/src/generation/publication'
import { EvaluationPlanSchema } from '../../server/src/admin/evaluation-admission'
import { ModelCallResultSchema } from '../../server/src/generation/model-call-contracts'
import { preQuestions, auditQuestions } from '../../server/src/reply/jev-pipeline'
import { EvaluationDatasetSchema, type EvaluationDataset } from './metrics'
import { ReplayInputSchema, validateFrozenReplayInputs } from './replay-input'
import {
  JEV_BASELINE_ROUTE,
  JEV_REPLAY_PROTOCOL,
  ReplayAttemptSchema,
  type AuthorizedReplaySource
} from './replay'

const Arm = z.enum(['A', 'B', 'C'])
const Tokens = z.strictObject({
  inputTokens: z.number().int().nonnegative().safe(),
  outputTokens: z.number().int().nonnegative().safe()
})
const Answers = z.record(
  z.string().min(1),
  z.discriminatedUnion('type', [
    AnswerSchema.options[0].strict(),
    AnswerSchema.options[1].strict(),
    AnswerSchema.options[2].strict()
  ])
)
const Response = JevResponseSchema.strict().extend({
  answers: Answers,
  usage: JevResponseSchema.shape.usage.strict()
})
const Attempt = ReplayAttemptSchema.extend({
  result: ModelCallResultSchema.extend({ answers: Answers.optional() }).nullable()
})
/** Private replay records, never a sending contract or proof of HTTP execution. */
export const BlindReviewArtifactSchema = z
  .strictObject({
    runId: Id,
    caseId: Id,
    arm: Arm,
    assignmentId: Id,
    protocol: z.literal(JEV_REPLAY_PROTOCOL),
    baselineRoute: z.literal(JEV_BASELINE_ROUTE),
    inputHash: Hash,
    executionPlanHash: Hash,
    snapshotHash: Hash,
    status: z.enum(['candidate', 'handoff', 'invalid', 'cancelled']),
    wouldRelease: z.boolean(),
    releaseAuthorized: z.literal(false),
    factsVerified: z.boolean(),
    intents: z.array(z.string()),
    reasons: z.array(z.string()),
    draft: z
      .strictObject({ text: z.string().min(1), evidenceIds: z.array(Id), draftHash: Hash })
      .nullable(),
    pre: Response.nullable(),
    post: Response.nullable(),
    stages: z.array(
      z.strictObject({
        stage: z.enum(['pre', 'text', 'post']),
        durationMs: z.number().nonnegative(),
        completed: z.boolean()
      })
    ),
    latencyMs: z.number().nonnegative(),
    otherProcessingMs: z.number().nonnegative(),
    attempts: z.array(Attempt).max(100).nullable(),
    usage: Tokens.nullable(),
    usageSource: z.enum(['recorded_http_attempts', 'unknown']),
    billedCostMicros: z.null()
  })
  .superRefine((a, c) => {
    const bad = (message: string): void => c.addIssue({ code: 'custom', message })
    if (a.status === 'invalid' || a.status === 'cancelled') bad('Replay incomplete')
    if (a.draft && hashDraft(a.draft.text) !== a.draft.draftHash) bad('Draft hash changed')
    if (a.status === 'candidate' && !a.draft) bad('Candidate draft missing')
    if (a.wouldRelease && (a.status !== 'candidate' || !a.draft || !a.factsVerified))
      bad('Release projection contradicts artifact')
    if (new Set(a.stages.map((s) => s.stage)).size !== a.stages.length) bad('Duplicate stage')
    if (a.stages.some((s) => !s.completed)) bad('Replay stage incomplete')
    if ((a.usage !== null) !== (a.usageSource === 'recorded_http_attempts'))
      bad('Usage provenance contradicts artifact')
    if (a.attempts && new Set(a.attempts.map((t) => t.attemptId)).size !== a.attempts.length)
      bad('Duplicate attempt')
    if (a.attempts?.some((t) => t.result === null)) bad('Replay attempt incomplete')
    if (a.usage) {
      const attempts = a.attempts
      if (
        !attempts ||
        a.stages.some((s) => !attempts.some((t) => t.stage === s.stage)) ||
        attempts.some((t) => !t.result?.usage || !a.stages.some((s) => s.stage === t.stage))
      ) {
        bad('Usage ledger incomplete')
      } else {
        const total = attempts.reduce(
          (n, t) => ({
            inputTokens: n.inputTokens + t.result!.usage!.inputTokens,
            outputTokens: n.outputTokens + t.result!.usage!.outputTokens
          }),
          { inputTokens: 0, outputTokens: 0 }
        )
        if (hashContext(total) !== hashContext(a.usage)) bad('Usage total changed')
      }
    }
  })
const Prior = z.strictObject({
  caseId: Id,
  category: Id,
  eligible: z.boolean(),
  expectedHandoff: z.boolean(),
  intentCount: z.number().int().positive()
})
const PriorAnnotations = z.strictObject({ annotatedBy: Id, cases: z.array(Prior).min(1) })
const Frozen = z.strictObject({
  authenticatedScope: IdentitySchema.pick({
    tenantId: true,
    accountId: true,
    employeeId: true,
    platform: true
  }),
  runId: Id,
  snapshotHash: Hash,
  publication: PublicationSchema,
  plan: EvaluationPlanSchema,
  // Explicit strings are essential: hashContext canonicalizes Date objects as {}.
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  serverNow: z.iso.datetime()
})
const PacketBody = z.strictObject({
  protocol: z.literal('jev-blind-review-v1'),
  packetId: z.uuid(),
  dataKind: z.enum(['business', 'synthetic']),
  rubricRef: Id,
  frozen: Frozen,
  input: ReplayInputSchema,
  priorAnnotations: PriorAnnotations,
  mapping: z
    .array(
      z.strictObject({
        reviewId: z.uuid(),
        caseId: Id,
        arm: Arm,
        assignmentId: Id,
        artifactHash: Hash
      })
    )
    .min(3)
})
export const PrivateBlindReviewPacketSchema = PacketBody.extend({ packetHash: Hash })

/** A packet/file cannot authenticate itself. The CLI supplies a fresh record
 * read using the database administrator's authenticated connection. */
export function assertJevBlindReviewFreeze(
  source: AuthorizedReplaySource,
  rawPacket: unknown
): void {
  const packet = PrivateBlindReviewPacketSchema.parse(rawPacket)
  const { serverNow: _packetTime, ...saved } = packet.frozen
  const current = Frozen.parse({
    ...source,
    createdAt: source.createdAt.toISOString(),
    expiresAt: source.expiresAt.toISOString(),
    serverNow: source.serverNow.toISOString()
  })
  const { serverNow: _currentTime, ...actual } = current
  if (Date.parse(_packetTime) > Date.parse(_currentTime))
    throw new Error('packet_server_time_in_future')
  if (hashContext(saved) !== hashContext(actual)) throw new Error('database_freeze_mismatch')
  validateFrozenReplayInputs(source, packet.input, source.publication.textGeneratorVersion)
}
export const BlindLabelsSchema = z.strictObject({
  adjudicatedBy: Id,
  annotationSource: z.literal('blinded_business_adjudication'),
  labels: z
    .array(
      z.strictObject({
        reviewId: z.uuid(),
        substantialCorrection: z.boolean().nullable(),
        severeFactError: z.boolean(),
        unauthorizedPromise: z.boolean(),
        incorrectlyBlocked: z.boolean(),
        coveredIntents: z.number().int().nonnegative()
      })
    )
    .min(3)
})

type ReviewArtifact = z.infer<typeof BlindReviewArtifactSchema>
export type PrivateBlindReviewPacket = z.infer<typeof PrivateBlindReviewPacketSchema>
export interface JevBlindReviewPackage {
  blind: {
    reviewId: string
    inbound: string[]
    context: NonNullable<z.infer<typeof ReplayInputSchema>['cases'][number]['context']>
    draft: string | null
  }[]
  privatePacket: PrivateBlindReviewPacket
}
type PendingOutcome = Omit<
  EvaluationDataset['cases'][number]['outcomes'][number],
  'inputTokens' | 'outputTokens'
> & {
  inputTokens: number | null
  outputTokens: number | null
}
export interface JevBlindImportResult {
  dataKind: 'business' | 'synthetic'
  status: 'dataset_ready_cost_unknown' | 'usage_incomplete'
  dataset: EvaluationDataset | null
  cases: (Omit<EvaluationDataset['cases'][number], 'outcomes'> & { outcomes: PendingOutcome[] })[]
  billedCostMicros: null
  releaseAuthorized: false
  approvalSubmission: null
  limitations: string[]
}
function bindArtifacts(
  frozen: AuthorizedReplaySource,
  rawCases: unknown,
  raw: unknown
): {
  input: z.infer<typeof ReplayInputSchema>
  artifacts: ReviewArtifact[]
} {
  const { input, summary } = validateFrozenReplayInputs(
    frozen,
    rawCases,
    frozen.publication.textGeneratorVersion
  )
  const artifacts = z.array(BlindReviewArtifactSchema).parse(raw)
  if (hashContext(raw) !== hashContext(artifacts)) throw new Error('artifact_normalization_changed')
  if (artifacts.length !== input.cases.length * 3) throw new Error('artifacts_incomplete')
  const planned = new Map(frozen.plan.assignments.map((a) => [a.caseId, a]))
  const cases = new Set(input.cases.map((a) => a.caseId))
  const assignments = new Set<string>(),
    pairs = new Set<string>()
  // The text fingerprint is opaque. These sets verify consistency of observed
  // text models, not their identity against an independently frozen oracle.
  const requestedTextModels = new Set<string>(),
    resolvedTextModels = new Set<string>()
  for (const a of artifacts) {
    const pair = `${a.caseId}\0${a.arm}`
    if (
      !cases.has(a.caseId) ||
      a.runId !== frozen.runId ||
      a.snapshotHash !== frozen.snapshotHash ||
      a.executionPlanHash !== summary.executionPlanHash ||
      a.inputHash !== planned.get(a.caseId)?.inputHash ||
      assignments.has(a.assignmentId) ||
      pairs.has(pair)
    )
      throw new Error('artifact_changed_or_unplanned')
    const expected =
      a.arm === 'A' ? ['text'] : a.arm === 'B' ? ['pre', 'text'] : ['pre', 'text', 'post']
    const stages = a.stages.map((s) => s.stage)
    if (
      stages.some((stage, i) => stage !== expected[i]) ||
      (a.status === 'candidate' && stages.length !== expected.length) ||
      (a.pre !== null) !== stages.includes('pre') ||
      (a.post !== null) !== stages.includes('post')
    )
      throw new Error('artifact_arm_stage_mismatch')
    for (const stage of ['pre', 'post'] as const) {
      const response = a[stage]
      if (response) {
        if (response.model !== frozen.publication.policy.modelResolved)
          throw new Error('artifact_jev_model_mismatch')
        parseJevResponse(
          {
            model: frozen.publication.policy.modelAlias,
            state: '',
            questions: stage === 'pre' ? preQuestions() : auditQuestions()
          },
          response
        )
      }
    }
    for (const attempt of a.attempts ?? []) {
      const { stage, start, result } = attempt
      if (
        !stages.includes(stage) ||
        (stage === 'text') !== (start.provider === 'text') ||
        (stage === 'text' && start.questionHash !== undefined) ||
        (stage !== 'text' &&
          (start.requestedModel !== frozen.publication.policy.modelAlias ||
            start.questionHash !==
              hashContext(stage === 'pre' ? preQuestions() : auditQuestions()) ||
            (result?.actualModel !== undefined &&
              result.actualModel !== frozen.publication.policy.modelResolved))) ||
        (result?.outcome === 'response' && !result.actualModel)
      )
        throw new Error('artifact_attempt_scope_mismatch')
      if (stage === 'text') {
        requestedTextModels.add(start.requestedModel)
      }
      if (!result) continue
      if (stage === 'text') {
        if (result.outcome === 'response') resolvedTextModels.add(result.actualModel!)
        if (result.answers !== undefined) throw new Error('artifact_text_attempt_has_jev_answers')
      } else if (result.answers !== undefined) {
        parseJevResponse(
          {
            model: frozen.publication.policy.modelAlias,
            state: '',
            questions: stage === 'pre' ? preQuestions() : auditQuestions()
          },
          {
            model: result.actualModel ?? frozen.publication.policy.modelResolved,
            answers: result.answers,
            usage: a[stage]!.usage
          }
        )
      }
    }
    assignments.add(a.assignmentId)
    pairs.add(pair)
  }
  if (requestedTextModels.size > 1 || resolvedTextModels.size > 1)
    throw new Error('artifact_text_model_inconsistent')
  return { input, artifacts }
}

/** All outputs contain private customer data. Save the mapping separately from
 * the shuffled reviewer view. The caller supplies a database-authenticated
 * freeze; a file claiming to be frozen cannot establish that authority. */
export function createJevBlindReview(options: {
  frozen: AuthorizedReplaySource
  rawCases: unknown
  artifacts: unknown
  priorAnnotations: unknown
  dataKind: 'business' | 'synthetic'
  rubricRef: string
}): JevBlindReviewPackage {
  const { input, artifacts } = bindArtifacts(options.frozen, options.rawCases, options.artifacts)
  const priorAnnotations = PriorAnnotations.parse(options.priorAnnotations)
  const ids = new Set(priorAnnotations.cases.map((p) => p.caseId))
  if (
    ids.size !== input.cases.length ||
    priorAnnotations.cases.length !== input.cases.length ||
    input.cases.some((c) => !ids.has(c.caseId))
  )
    throw new Error('prior_annotations_incomplete_or_changed')
  const mapping = artifacts.map((a) => ({
    reviewId: randomUUID(),
    caseId: a.caseId,
    arm: a.arm,
    assignmentId: a.assignmentId,
    artifactHash: hashContext(a)
  }))
  const body = PacketBody.parse({
    protocol: 'jev-blind-review-v1',
    packetId: randomUUID(),
    dataKind: options.dataKind,
    rubricRef: options.rubricRef,
    frozen: {
      ...options.frozen,
      createdAt: options.frozen.createdAt.toISOString(),
      expiresAt: options.frozen.expiresAt.toISOString(),
      serverNow: options.frozen.serverNow.toISOString()
    },
    input,
    priorAnnotations,
    mapping
  })
  const blind = artifacts.map((a, i) => {
    const item = input.cases.find((c) => c.caseId === a.caseId)!
    return {
      reviewId: mapping[i].reviewId,
      inbound: item.inbound,
      context: item.context ?? [],
      draft: a.draft?.text ?? null
    }
  })
  for (let i = blind.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    ;[blind[i], blind[j]] = [blind[j], blind[i]]
  }
  return structuredClone({
    blind,
    privatePacket: { ...body, packetHash: hashContext(body) }
  })
}

/** Labels may only select a reviewId and annotate reply quality. Original
 * artifacts are required again to detect packet/artifact inconsistency. Hashes
 * prove preservation only, not real HTTP calls, human identity, or the time at
 * which case priors were collected. No approval submission is ever returned. */
export function importJevBlindLabels(
  rawPacket: unknown,
  originalArtifacts: unknown,
  rawLabels: unknown
): JevBlindImportResult {
  const packet = PrivateBlindReviewPacketSchema.parse(rawPacket)
  const { packetHash, ...body } = packet
  if (hashContext(body) !== packetHash) throw new Error('private_packet_changed')
  const frozen: AuthorizedReplaySource = {
    ...packet.frozen,
    createdAt: new Date(packet.frozen.createdAt),
    expiresAt: new Date(packet.frozen.expiresAt),
    serverNow: new Date(packet.frozen.serverNow)
  }
  const { input, artifacts } = bindArtifacts(frozen, packet.input, originalArtifacts)
  const byAssignment = new Map(artifacts.map((a) => [a.assignmentId, a]))
  const reviews = new Set<string>(),
    assignments = new Set<string>()
  if (packet.mapping.length !== artifacts.length) throw new Error('mapping_incomplete')
  for (const m of packet.mapping) {
    const a = byAssignment.get(m.assignmentId)
    if (
      !a ||
      m.caseId !== a.caseId ||
      m.arm !== a.arm ||
      m.artifactHash !== hashContext(a) ||
      reviews.has(m.reviewId) ||
      assignments.has(m.assignmentId)
    )
      throw new Error('review_mapping_changed')
    reviews.add(m.reviewId)
    assignments.add(m.assignmentId)
  }
  const priors = new Map(packet.priorAnnotations.cases.map((p) => [p.caseId, p]))
  if (
    priors.size !== input.cases.length ||
    packet.priorAnnotations.cases.length !== input.cases.length ||
    input.cases.some((c) => !priors.has(c.caseId))
  )
    throw new Error('prior_annotations_changed')
  const labels = BlindLabelsSchema.parse(rawLabels)
  const byReview = new Map(labels.labels.map((l) => [l.reviewId, l]))
  if (
    labels.labels.length !== reviews.size ||
    byReview.size !== reviews.size ||
    labels.labels.some((l) => !reviews.has(l.reviewId))
  )
    throw new Error('blind_labels_incomplete_or_unknown')
  const rows = input.cases.map((item) => {
    const prior = priors.get(item.caseId)!
    const outcomes = packet.mapping
      .filter((m) => m.caseId === item.caseId)
      .map((m) => {
        const a = byAssignment.get(m.assignmentId)!,
          l = byReview.get(m.reviewId)!
        const suggested = a.draft !== null
        if (
          suggested !== (l.substantialCorrection !== null) ||
          (!suggested && (l.severeFactError || l.unauthorizedPromise || l.coveredIntents !== 0)) ||
          ((l.severeFactError || l.unauthorizedPromise) && l.substantialCorrection !== true) ||
          l.coveredIntents > prior.intentCount ||
          (a.wouldRelease && l.incorrectlyBlocked)
        )
          throw new Error('blind_label_contradicts_reply_or_prior')
        return {
          arm: a.arm,
          automatic: a.wouldRelease,
          suggested,
          substantialCorrection: l.substantialCorrection,
          severeFactError: l.severeFactError,
          unauthorizedPromise: l.unauthorizedPromise,
          incorrectlyBlocked: l.incorrectlyBlocked,
          coveredIntents: l.coveredIntents,
          latencyMs: a.latencyMs,
          inputTokens: a.usage?.inputTokens ?? null,
          outputTokens: a.usage?.outputTokens ?? null
        }
      })
    return { ...prior, conversationGroup: item.conversationGroup, split: item.split, outcomes }
  })
  const usageComplete = artifacts.every((a) => a.usage !== null)
  const dataset = usageComplete
    ? EvaluationDatasetSchema.parse({
        datasetId: input.datasetId,
        experimentSnapshotHash: frozen.snapshotHash,
        jevModelResolved: frozen.publication.configuration.modelResolved,
        questionSetVersion: frozen.publication.configuration.questionSetVersion,
        policyVersion: frozen.publication.configuration.decisionPolicyVersion,
        annotationSource: labels.annotationSource,
        adjudicatedBy: labels.adjudicatedBy,
        thresholdsFrozenBeforeHoldout: true,
        cases: rows
      })
    : null
  return {
    dataKind: packet.dataKind,
    status: usageComplete ? ('dataset_ready_cost_unknown' as const) : ('usage_incomplete' as const),
    dataset,
    cases: rows,
    billedCostMicros: null,
    releaseAuthorized: false as const,
    approvalSubmission: null,
    limitations: [
      'Consistency hashes do not authenticate HTTP execution or human annotation identity.',
      'The collection time of independent case priors is not proven.',
      'thresholdsFrozenBeforeHoldout inherits the frozen experiment protocol only when the caller uses an authoritative database freeze and its execution core; this package does not prove holdout timing. Business admission still requires server journal timestamps.',
      'Fees and execution timestamps are unavailable; no admission submission is produced.',
      ...(packet.dataKind === 'synthetic'
        ? ['Synthetic data does not demonstrate business accuracy.']
        : [])
    ]
  }
}
