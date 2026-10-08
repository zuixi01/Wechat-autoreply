import { z } from 'zod'
import { Hash, Id } from '../../src/shared/contracts/identity'
import { JevResponseSchema, parseJevResponse } from '../../src/shared/contracts/decision'
import { hashContext } from '../../src/core/reply/hashes'
import {
  DecisionPolicySchema,
  preQuestions,
  auditQuestions,
  type DecisionPolicy
} from '../../server/src/reply/jev-pipeline'

const intents = ['faq', 'price', 'order', 'aftersales', 'other'] as const
const audits = [
  'supported',
  'within_scope',
  'covers_requests',
  'appropriate_tone',
  'resists_instructions'
] as const
const tunable = [
  'minimumChoiceProbability',
  'minimumChoiceConfidence',
  'minimumChoiceMargin',
  'presentIntentProbability',
  'humanRequestThreshold',
  'minimumAuditProbability'
] as const

const Sample = z
  .strictObject({
    caseId: Id,
    conversationGroup: Id,
    split: z.literal('calibration'),
    eligible: z.boolean(),
    expectedHandoff: z.boolean(),
    // These are observed deterministic pipeline gates, never Jev's self-confidence.
    explicitHumanRequest: z.boolean(),
    deterministicPreconditionsPassed: z.boolean(),
    factsVerified: z.boolean(),
    draftAvailable: z.boolean(),
    assessedIntents: z.array(z.enum(intents)).max(5),
    substantialCorrection: z.boolean().nullable(),
    severeFactError: z.boolean(),
    unauthorizedPromise: z.boolean(),
    pre: JevResponseSchema.nullable(),
    post: JevResponseSchema.nullable()
  })
  .superRefine((s, c) => {
    if (s.pre === null && !s.explicitHumanRequest)
      c.addIssue({
        code: 'custom',
        message: 'Observed predecision required except explicit human handoff'
      })
    if (s.pre === null && (s.draftAvailable || s.post !== null || s.assessedIntents.length))
      c.addIssue({
        code: 'custom',
        message: 'Human handoff without predecision cannot have downstream observations'
      })
    if (
      s.draftAvailable !== (s.substantialCorrection !== null) ||
      (s.post !== null && !s.draftAvailable)
    )
      c.addIssue({
        code: 'custom',
        message: 'Observed draft and independent correction label required'
      })
    if ((s.severeFactError || s.unauthorizedPromise) && s.substantialCorrection !== true)
      c.addIssue({ code: 'custom', message: 'Severe errors require independent correction' })
    if (s.factsVerified && !s.draftAvailable)
      c.addIssue({ code: 'custom', message: 'Missing draft cannot be fact verified' })
    if (
      new Set(s.assessedIntents).size !== s.assessedIntents.length ||
      (s.draftAvailable && !s.assessedIntents.length)
    )
      c.addIssue({ code: 'custom', message: 'Observed draft intent scope required' })
  })

export const CalibrationInputSchema = z
  .strictObject({
    datasetId: Id,
    dataKind: z.enum(['business', 'synthetic']),
    annotationSource: z.literal('blinded_business_adjudication'),
    adjudicatedBy: Id,
    experimentSnapshotHash: Hash,
    basePolicy: DecisionPolicySchema,
    // Declare the finite candidates before comparing them on calibration labels.
    candidates: z.array(DecisionPolicySchema).min(1).max(500),
    targets: z.strictObject({
      maximumErrorReleaseRate: z.number().min(0).max(1),
      minimumAutomaticCoverage: z.number().positive().max(1),
      minimumAutomaticReplies: z.number().int().min(30).max(2000)
    }),
    samples: z.array(Sample).min(1).max(2000)
  })
  .superRefine((data, c) => {
    const fixed = (p: DecisionPolicy): string =>
      hashContext(
        Object.fromEntries(
          Object.entries(p).filter(([key]) => !tunable.includes(key as (typeof tunable)[number]))
        )
      )
    if (data.basePolicy.mode !== 'enforced')
      c.addIssue({ code: 'custom', message: 'Calibrate the intended enforced policy' })
    if (!data.basePolicy.evaluationApproved)
      c.addIssue({
        code: 'custom',
        message: 'Calibrate the intended evaluation-approved policy; this tool grants no approval'
      })
    if (data.basePolicy.presentIntentProbability <= 0.5)
      c.addIssue({ code: 'custom', message: 'Intent-presence threshold must exceed 0.5' })
    const ids = new Set<string>(),
      versions = new Set<string>()
    for (const sample of data.samples) {
      if (ids.has(sample.caseId))
        c.addIssue({ code: 'custom', message: 'Duplicate calibration case' })
      ids.add(sample.caseId)
    }
    for (const candidate of data.candidates) {
      if (fixed(candidate) !== fixed(data.basePolicy))
        c.addIssue({ code: 'custom', message: 'Only the six decision thresholds may differ' })
      const hash = hashContext(candidate)
      if (versions.has(hash)) c.addIssue({ code: 'custom', message: 'Duplicate candidate policy' })
      versions.add(hash)
      if (candidate.presentIntentProbability <= 0.5)
        c.addIssue({ code: 'custom', message: 'Intent-presence threshold must exceed 0.5' })
    }
  })
export type CalibrationInput = z.infer<typeof CalibrationInputSchema>
type Sample = z.infer<typeof Sample>

function preAllows(s: Sample, p: DecisionPolicy): boolean {
  const pre = s.pre
  if (s.explicitHumanRequest || !s.deterministicPreconditionsPassed || !pre) return false
  const human = pre.answers.human_requested
  if (human.type !== 'noul' || human.noul >= p.humanRequestThreshold) return false
  const primary = pre.answers.primary_intent
  if (primary.type !== 'choice') return false
  const second = Math.max(
    ...Object.entries(primary.probabilities)
      .filter(([id]) => id !== primary.choice)
      .map(([, value]) => value)
  )
  if (
    primary.confidence < p.minimumChoiceConfidence ||
    primary.probabilities[primary.choice] < p.minimumChoiceProbability ||
    primary.probabilities[primary.choice] - second < p.minimumChoiceMargin
  )
    return false
  const present = intents.filter((intent) => {
    const answer = pre.answers[`has_${intent}`]
    return answer.type === 'noul' && answer.noul >= p.presentIntentProbability
  })
  if (!present.includes(primary.choice as (typeof intents)[number])) return false
  if (
    intents.some((intent) => {
      const a = pre.answers[`has_${intent}`]
      return (
        a.type === 'noul' &&
        a.noul > 1 - p.presentIntentProbability &&
        a.noul < p.presentIntentProbability
      )
    })
  )
    return false
  return present.every((intent) => p.automaticIntents.includes(intent))
}

export interface CalibratedCandidate {
  policyHash: string
  thresholds: Pick<DecisionPolicy, (typeof tunable)[number]>
  automaticReplies: number
  incorrectReleases: number
  errorReleaseRate: number | null
  eligibleAutomaticReplies: number
  eligibleCases: number
  automaticCoverage: number | null
  severeAutomaticErrors: number
  unauthorizedAutomaticPromises: number
  inappropriateReleases: number
  unobservedCounterfactuals: number
  meetsTargets: boolean
  reasons: string[]
}
export interface CalibrationReport {
  datasetId: string
  inputHash: string
  experimentSnapshotHash: string
  dataKind: 'business' | 'synthetic'
  sampleCount: number
  independentConversations: number
  status: 'insufficient_evidence' | 'no_candidate_met_targets' | 'recommended_for_frozen_holdout'
  recommendedPolicy: DecisionPolicy | null
  candidates: CalibratedCandidate[]
  holdoutRequired: true
  releaseAuthorized: false
  limitations: string[]
}

/** Calibration selection is descriptive; the untouched paired A/B/C holdout and
 * server evaluation approval remain mandatory. No provider calls or policy writes. */
export function calibratePolicies(raw: unknown): CalibrationReport {
  const data = CalibrationInputSchema.parse(raw)
  for (const sample of data.samples) {
    if (sample.pre) {
      sample.pre = parseJevResponse(
        { model: data.basePolicy.modelAlias, state: {}, questions: preQuestions() },
        sample.pre
      )
      if (sample.pre.model !== data.basePolicy.modelResolved)
        throw new Error('calibration_model_drift')
    }
    if (sample.post) {
      sample.post = parseJevResponse(
        { model: data.basePolicy.modelAlias, state: {}, questions: auditQuestions() },
        sample.post
      )
      if (sample.post.model !== data.basePolicy.modelResolved)
        throw new Error('calibration_model_drift')
    }
  }
  const groups = new Set(data.samples.map((s) => s.conversationGroup)).size
  const candidates = data.candidates.map((policy): CalibratedCandidate => {
    const automatic: Sample[] = []
    let unobserved = 0
    for (const sample of data.samples) {
      const pre = sample.pre
      if (!pre || !preAllows(sample, policy)) continue
      // A lower threshold can expose a previously blocked case. Its unseen text
      // and postreview cannot be inferred from scores or treated as a safe reply.
      if (!sample.draftAvailable || !sample.post) {
        unobserved++
        continue
      }
      const replayedIntents = intents.filter((intent) => {
        const answer = pre.answers[`has_${intent}`]
        return answer.type === 'noul' && answer.noul >= policy.presentIntentProbability
      })
      if (
        hashContext([...replayedIntents].sort()) !== hashContext([...sample.assessedIntents].sort())
      ) {
        unobserved++
        continue
      }
      if (!sample.factsVerified) continue
      if (
        audits.every((name) => {
          const answer = sample.post!.answers[name]
          return answer.type === 'noul' && answer.noul >= policy.minimumAuditProbability
        })
      )
        automatic.push(sample)
    }
    const eligible = data.samples.filter((s) => s.eligible).length
    const eligibleAutomatic = automatic.filter((s) => s.eligible).length
    const incorrect = automatic.filter((s) => s.substantialCorrection).length
    const errorRate = automatic.length ? incorrect / automatic.length : null
    const coverage = eligible ? eligibleAutomatic / eligible : null
    const severe = automatic.filter((s) => s.severeFactError).length
    const unauthorized = automatic.filter((s) => s.unauthorizedPromise).length
    const handoff = automatic.filter((s) => s.expectedHandoff).length
    const reasons: string[] = []
    if (automatic.length < data.targets.minimumAutomaticReplies)
      reasons.push('too_few_automatic_replies')
    if (errorRate === null || errorRate > data.targets.maximumErrorReleaseRate)
      reasons.push('error_target_not_met')
    if (coverage === null || coverage < data.targets.minimumAutomaticCoverage)
      reasons.push('coverage_target_not_met')
    if (severe || unauthorized || handoff) reasons.push('unsafe_automatic_release')
    if (unobserved) reasons.push('unobserved_counterfactuals')
    return {
      policyHash: hashContext(policy),
      thresholds: Object.fromEntries(
        tunable.map((key) => [key, policy[key]])
      ) as CalibratedCandidate['thresholds'],
      automaticReplies: automatic.length,
      incorrectReleases: incorrect,
      errorReleaseRate: errorRate,
      eligibleAutomaticReplies: eligibleAutomatic,
      eligibleCases: eligible,
      automaticCoverage: coverage,
      severeAutomaticErrors: severe,
      unauthorizedAutomaticPromises: unauthorized,
      inappropriateReleases: handoff,
      unobservedCounterfactuals: unobserved,
      meetsTargets: !reasons.length,
      reasons
    }
  })
  const ranked = candidates
    .filter((c) => c.meetsTargets)
    .sort(
      (a, b) =>
        (b.automaticCoverage ?? -1) - (a.automaticCoverage ?? -1) ||
        (a.errorReleaseRate ?? 1) - (b.errorReleaseRate ?? 1) ||
        a.policyHash.localeCompare(b.policyHash)
    )
  const sufficient = data.dataKind === 'business' && data.samples.length >= 100 && groups >= 30
  return {
    datasetId: data.datasetId,
    inputHash: hashContext(data),
    experimentSnapshotHash: data.experimentSnapshotHash,
    dataKind: data.dataKind,
    sampleCount: data.samples.length,
    independentConversations: groups,
    status: !sufficient
      ? 'insufficient_evidence'
      : ranked.length
        ? 'recommended_for_frozen_holdout'
        : 'no_candidate_met_targets',
    recommendedPolicy:
      sufficient && ranked.length
        ? data.candidates.find((p) => hashContext(p) === ranked[0].policyHash)!
        : null,
    candidates,
    holdoutRequired: true,
    releaseAuthorized: false,
    limitations: [
      'Labels and deterministic fact flags must come from independent business review and observed pipeline records, never Jev self-scores.',
      'Selection uses calibration only. Freeze the selected full publication and new snapshot before running the untouched paired A/B/C holdout.',
      'Changing knowledge, question wording, text generator or automatic intent scope requires new assessments rather than threshold replay.',
      'A business marker cannot establish that annotations or model observations are authentic.',
      'Observed calibration rates do not establish future risk or authorize automatic sending.'
    ]
  }
}
