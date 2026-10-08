import { createHash } from 'node:crypto'
import {
  LearningEvaluationDatasetSchema,
  type LearningEvaluationPair
} from '../../src/shared/contracts/learning-evaluation'

// Human-confirmed 2026-10-06. The CLI exposes no threshold-relaxation option.
export const MEMORY_EVALUATION_THRESHOLDS = Object.freeze({
  relativeCorrectionReduction: 0.2,
  severeErrors: 0,
  maxCoverageDropPp: 5,
  maxAddedP95LatencyMs: 500
})
// Engineering sample floor from the plan, not a statistical sufficiency guarantee.
export const MEMORY_EVALUATION_SAMPLE_FLOOR = Object.freeze({
  learn: 100,
  calibrate: 100,
  evaluate: 200,
  conversations: 30
})
interface Proportion {
  numerator: number
  denominator: number
  rate: number | null
  descriptiveWilson95: [number, number] | null
}
interface ArmSummary {
  correction: Proportion
  coverage: Proportion
  severeErrors: number
  p95LatencyMs: number | null
  tokens: { input: number; output: number }
  costUsd: number
}
interface Comparison {
  relativeCorrectionReduction: number | null
  coverageChangePp: number | null
  addedP95LatencyMs: number | null
  costUsdChange: number
}
export interface MemoryEvaluationReport {
  version: 2
  datasetId: string
  datasetHash: string
  origin: 'business_observation' | 'synthetic' | 'model'
  frozen: {
    sharedConfigurationHash: string
    staticMemoryManifestHash: string
    learnedMemoryManifestHash: string
    frozenAt: number
    modelVersion: string
    knowledgeVersion: string
    methodCount: number
    noMemoryManifestHash: string | null
    policyVersion: string | null
    retrievalVersion: string | null
    backgroundCostUsd: number | null
    latencyScope: 'knowledge_preview' | 'enterprise_pipeline' | 'foreground_end_to_end' | null
  }
  thresholds: typeof MEMORY_EVALUATION_THRESHOLDS
  sampleFloor: typeof MEMORY_EVALUATION_SAMPLE_FLOOR
  sample: { learn: number; calibrate: number; evaluate: number; conversations: number }
  arms: { none: ArmSummary | null; baseline: ArmSummary; learned: ArmSummary }
  strata: Record<
    string,
    {
      sample: { evaluate: number; conversations: number }
      arms: MemoryEvaluationReport['arms']
      comparison: Comparison
      conversationBootstrap: MemoryEvaluationReport['uncertainty']['conversationBootstrap']
    }
  >
  comparison: Comparison
  uncertainty: {
    conversationBootstrap: {
      replicates: number
      validRelativeCorrectionReplicates: number
      relativeCorrectionReduction95: [number, number] | null
      coverageChangePp95: [number, number] | null
      addedP95LatencyMs95: [number, number] | null
    }
  }
  assessment: {
    status: 'passed' | 'insufficient' | 'failed'
    reasons: string[]
    failedGates: string[]
    limitations: string[]
  }
}

function proportion(numerator: number, denominator: number): Proportion {
  if (!denominator) return { numerator, denominator, rate: null, descriptiveWilson95: null }
  const rate = numerator / denominator,
    z = 1.959963984540054,
    zz = z * z
  const divisor = 1 + zz / denominator
  const center = (rate + zz / (2 * denominator)) / divisor
  const radius =
    (z * Math.sqrt((rate * (1 - rate)) / denominator + zz / (4 * denominator ** 2))) / divisor
  return {
    numerator,
    denominator,
    rate,
    descriptiveWilson95: [Math.max(0, center - radius), Math.min(1, center + radius)]
  }
}
function percentile(values: number[], p: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]
}
function summarize(
  pairs: LearningEvaluationPair[],
  arm: 'none' | 'baseline' | 'learned'
): ArmSummary {
  const outcomes = pairs.flatMap((pair) => (pair[arm] ? [pair[arm]!] : []))
  // Legacy data remains readable, but can no longer pass the v2 acceptance contract.
  const reviewed = outcomes.filter((o) => o.humanReviewed ?? o.reply !== null)
  return {
    correction: proportion(reviewed.filter((o) => o.substantialCorrection).length, reviewed.length),
    coverage: proportion(outcomes.filter((o) => o.validAnswer).length, pairs.length),
    severeErrors: outcomes.filter((o) => o.severeError).length,
    p95LatencyMs: outcomes.some((o) => o.latencyComplete === false)
      ? null
      : percentile(
          outcomes.map((o) => o.latencyMs),
          0.95
        ),
    tokens: {
      input: outcomes.reduce((n, o) => n + o.inputTokens, 0),
      output: outcomes.reduce((n, o) => n + o.outputTokens, 0)
    },
    costUsd: outcomes.reduce((n, o) => n + o.costUsd, 0)
  }
}
function compare(a: ArmSummary, b: ArmSummary): Comparison {
  return {
    relativeCorrectionReduction:
      a.correction.rate !== null && a.correction.rate > 0 && b.correction.rate !== null
        ? (a.correction.rate - b.correction.rate) / a.correction.rate
        : null,
    coverageChangePp:
      a.coverage.rate !== null && b.coverage.rate !== null
        ? (b.coverage.rate - a.coverage.rate) * 100
        : null,
    addedP95LatencyMs:
      a.p95LatencyMs !== null && b.p95LatencyMs !== null ? b.p95LatencyMs - a.p95LatencyMs : null,
    costUsdChange: b.costUsd - a.costUsd
  }
}
function bootstrap(
  pairs: LearningEvaluationPair[]
): MemoryEvaluationReport['uncertainty']['conversationBootstrap'] {
  const groups = new Map<string, LearningEvaluationPair[]>()
  for (const pair of pairs) {
    const group = groups.get(pair.conversationId) ?? []
    group.push(pair)
    groups.set(pair.conversationId, group)
  }
  const blocks = [...groups.values()]
  const reduction: number[] = [],
    coverage: number[] = [],
    latency: number[] = []
  let state = 0x6d2b79f5
  const random = (): number => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x100000000
  }
  const replicates = blocks.length >= 2 ? 1000 : 0
  for (let i = 0; i < replicates; i++) {
    const sample: LearningEvaluationPair[] = []
    for (let j = 0; j < blocks.length; j++)
      sample.push(...blocks[Math.floor(random() * blocks.length)])
    const delta = compare(summarize(sample, 'baseline'), summarize(sample, 'learned'))
    if (delta.relativeCorrectionReduction !== null)
      reduction.push(delta.relativeCorrectionReduction)
    if (delta.coverageChangePp !== null) coverage.push(delta.coverageChangePp)
    if (delta.addedP95LatencyMs !== null) latency.push(delta.addedP95LatencyMs)
  }
  const interval = (values: number[]): [number, number] | null =>
    values.length ? [percentile(values, 0.025)!, percentile(values, 0.975)!] : null
  return {
    replicates,
    validRelativeCorrectionReplicates: reduction.length,
    relativeCorrectionReduction95: interval(reduction),
    coverageChangePp95: interval(coverage),
    addedP95LatencyMs95: pairs.some(
      (pair) => pair.baseline.latencyComplete === false || pair.learned.latencyComplete === false
    )
      ? null
      : interval(latency)
  }
}

export function evaluateMemoryDataset(raw: unknown): MemoryEvaluationReport {
  const dataset = LearningEvaluationDatasetSchema.parse(raw)
  const pairs = dataset.cases.filter((c): c is LearningEvaluationPair => c.split === 'evaluate')
  const sample = {
    learn: dataset.cases.filter((c) => c.split === 'learn').length,
    calibrate: dataset.cases.filter((c) => c.split === 'calibrate').length,
    evaluate: pairs.length,
    conversations: new Set(pairs.map((c) => c.conversationId)).size
  }
  const reasons = new Set<string>()
  if (dataset.frozen.latencyScope !== 'foreground_end_to_end')
    reasons.add('foreground_latency_not_measured')
  if (dataset.version === 1) reasons.add('legacy_two_arm_contract')
  if (dataset.origin !== 'business_observation') reasons.add('non_business_dataset')
  if (sample.learn < MEMORY_EVALUATION_SAMPLE_FLOOR.learn) reasons.add('too_few_learning_cases')
  if (sample.calibrate < MEMORY_EVALUATION_SAMPLE_FLOOR.calibrate)
    reasons.add('too_few_calibration_cases')
  if (sample.evaluate < MEMORY_EVALUATION_SAMPLE_FLOOR.evaluate)
    reasons.add('too_few_evaluation_cases')
  if (sample.conversations < MEMORY_EVALUATION_SAMPLE_FLOOR.conversations)
    reasons.add('too_few_independent_conversations')
  const splits = new Map<string, string>()
  for (const item of dataset.cases) {
    const old = splits.get(item.conversationId)
    if (old && old !== item.split) reasons.add('conversation_split_overlap')
    splits.set(item.conversationId, item.split)
    if (item.label.origin !== 'human') reasons.add('non_human_labels')
    if (!item.label.reviewerId || !item.label.evidenceRef) reasons.add('missing_human_provenance')
    if (item.split !== 'evaluate' && item.label.labelledAt > dataset.frozen.frozenAt)
      reasons.add('source_label_after_freeze')
  }
  const byId = new Map(dataset.cases.map((c) => [c.caseId, c]))
  for (const method of dataset.frozen.methods) {
    for (const id of method.sourceCaseIds) {
      if (byId.get(id)?.split !== 'learn') reasons.add('learning_source_not_in_learn_split')
    }
  }
  for (const pair of pairs) {
    if (!pair.label.blinded || !pair.label.assignmentRef) reasons.add('unblinded_evaluation')
    for (const arm of ['none', 'baseline', 'learned'] as const) {
      const output = pair[arm]
      if (!output) continue
      if (output.latencyComplete === false) reasons.add('incomplete_latency_observation')
      if (dataset.frozen.latencyScope === 'foreground_end_to_end' && !output.latencyEvidenceRef)
        reasons.add('missing_foreground_latency_evidence')
      if (output.reply !== null && output.humanReviewed === false)
        reasons.add('unreviewed_evaluation_reply')
      if (output.configurationHash !== dataset.frozen.sharedConfigurationHash)
        reasons.add('configuration_changed')
      const expected =
        arm === 'none'
          ? dataset.frozen.noMemoryManifestHash
          : arm === 'baseline'
            ? dataset.frozen.staticMemoryManifestHash
            : dataset.frozen.learnedMemoryManifestHash
      if (output.memoryManifestHash !== expected) reasons.add('memory_manifest_changed')
      if (output.generatedAt < dataset.frozen.frozenAt) reasons.add('generation_before_freeze')
      if (pair.label.labelledAt < output.generatedAt) reasons.add('label_before_generation')
    }
  }
  const summaries = (items: LearningEvaluationPair[]): MemoryEvaluationReport['arms'] => ({
    none: items.length && items.every((item) => item.none) ? summarize(items, 'none') : null,
    baseline: summarize(items, 'baseline'),
    learned: summarize(items, 'learned')
  })
  const arms = summaries(pairs)
  const strata = Object.fromEntries(
    ['inquiry', 'complaint', 'handoff', 'multiple_intents'].map((category) => {
      const items = pairs.filter((item) => item.category === category)
      const groupedArms = summaries(items)
      if (!items.length) reasons.add(`missing_category_${category}`)
      return [
        category,
        {
          sample: {
            evaluate: items.length,
            conversations: new Set(items.map((item) => item.conversationId)).size
          },
          arms: groupedArms,
          comparison: compare(groupedArms.baseline, groupedArms.learned),
          conversationBootstrap: bootstrap(items)
        }
      ]
    })
  )
  if (!arms.learned.correction.denominator) reasons.add('no_reviewed_learning_drafts')
  const comparison = compare(arms.baseline, arms.learned)
  if (comparison.relativeCorrectionReduction === null) reasons.add('zero_baseline_correction')
  const failedGates: string[] = []
  // Integer ratios avoid rejecting exactly 20% or 5pp due to floating-point roundoff.
  if (
    arms.baseline.correction.numerator > 0 &&
    arms.learned.correction.numerator * arms.baseline.correction.denominator * 5 >
      arms.baseline.correction.numerator * arms.learned.correction.denominator * 4
  ) {
    failedGates.push('relativeCorrectionReduction')
  }
  if (arms.learned.severeErrors > 0) failedGates.push('severeErrors')
  if ((arms.baseline.coverage.numerator - arms.learned.coverage.numerator) * 100 > 5 * pairs.length)
    failedGates.push('coverageDrop')
  if (comparison.addedP95LatencyMs !== null && comparison.addedP95LatencyMs > 500)
    failedGates.push('addedP95LatencyMs')
  return {
    version: 2,
    datasetId: dataset.datasetId,
    datasetHash: createHash('sha256').update(JSON.stringify(dataset)).digest('hex'),
    origin: dataset.origin,
    frozen: {
      sharedConfigurationHash: dataset.frozen.sharedConfigurationHash,
      staticMemoryManifestHash: dataset.frozen.staticMemoryManifestHash,
      learnedMemoryManifestHash: dataset.frozen.learnedMemoryManifestHash,
      frozenAt: dataset.frozen.frozenAt,
      modelVersion: dataset.frozen.modelVersion,
      knowledgeVersion: dataset.frozen.knowledgeVersion,
      methodCount: dataset.frozen.methods.length,
      noMemoryManifestHash: dataset.frozen.noMemoryManifestHash ?? null,
      policyVersion: dataset.frozen.policyVersion ?? null,
      retrievalVersion: dataset.frozen.retrievalVersion ?? null,
      backgroundCostUsd: dataset.frozen.backgroundCostUsd ?? null,
      latencyScope: dataset.frozen.latencyScope ?? null
    },
    thresholds: MEMORY_EVALUATION_THRESHOLDS,
    sampleFloor: MEMORY_EVALUATION_SAMPLE_FLOOR,
    sample,
    arms,
    strata,
    comparison,
    uncertainty: { conversationBootstrap: bootstrap(pairs) },
    assessment: {
      status: reasons.size ? 'insufficient' : failedGates.length ? 'failed' : 'passed',
      reasons: [...reasons],
      failedGates,
      limitations: [
        'Human provenance is declared input; verify the private adjudication and blind assignment records independently.',
        'Point-estimate gates describe this frozen sample, not a population guarantee or automatic publication grant.',
        'Conversation bootstrap preserves paired outcomes within each conversation; Wilson intervals ignore clustering and are descriptive only.',
        'Minimum sample counts are an engineering floor; the business reviewer must assess representativeness and uncertainty.',
        'Fees are supplied observed USD costs, not estimates from current model prices.',
        'Observed zero severe errors is not a guarantee of zero severe-error risk.',
        'Foreground timing scope and private observation references are declared evidence and require independent verification; partial pipeline timing cannot pass the full latency gate.'
      ]
    }
  }
}
