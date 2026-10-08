import { describe, expect, it } from 'vitest'
import { evaluateMemoryDataset } from '../../evals/memory/metrics'
import { LearningEvaluationDatasetSchema } from '../../src/shared/contracts/learning-evaluation'

const hash = 'a'.repeat(64)
// All cases and labels are synthetic. Business/human strings below only simulate the acceptance
// contract for assertions; these unit outputs must never be used as business evidence.
function dataset() {
  const outcome = (correction: boolean) => ({
    reply: 'Synthetic test only',
    humanReviewed: true,
    substantialCorrection: correction,
    severeError: false,
    validAnswer: true,
    latencyMs: 100,
    latencyEvidenceRef: 'synthetic-observation-never-real-evidence',
    inputTokens: 1,
    outputTokens: 1,
    costUsd: 0,
    generatedAt: 2000,
    configurationHash: hash,
    memoryManifestHash: hash
  })
  const label = {
    origin: 'human',
    reviewerId: 'reviewer',
    evidenceRef: 'evidence',
    blinded: true,
    assignmentRef: 'assignment',
    labelledAt: 3000
  }
  return {
    version: 2,
    datasetId: 'synthetic-v2-contract',
    origin: 'business_observation',
    rubricRef: 'rubric',
    frozen: {
      frozenAt: 1000,
      sharedConfigurationHash: hash,
      noMemoryManifestHash: hash,
      staticMemoryManifestHash: hash,
      learnedMemoryManifestHash: hash,
      modelVersion: 'model',
      knowledgeVersion: 'knowledge',
      policyVersion: 'policy',
      retrievalVersion: 'retrieval',
      backgroundCostUsd: 0.25,
      latencyScope: 'foreground_end_to_end',
      methods: [{ id: 'method', revision: 1, contentHash: hash, sourceCaseIds: ['learn-0'] }]
    },
    cases: [
      ...['learn', 'calibrate'].flatMap((split) =>
        Array.from({ length: 100 }, (_, i) => ({
          caseId: `${split}-${i}`,
          conversationId: `${split}-${i}`,
          split,
          label: { ...label, blinded: false, labelledAt: 500 }
        }))
      ),
      ...Array.from({ length: 200 }, (_, i) => ({
        caseId: `eval-${i}`,
        conversationId: `eval-${Math.floor(i / 5)}`,
        split: 'evaluate',
        category: ['inquiry', 'complaint', 'handoff', 'multiple_intents'][i % 4],
        label,
        none: outcome(i < 110),
        baseline: outcome(i < 100),
        learned: outcome(i < 60)
      }))
    ]
  }
}

describe('three-arm independent memory evaluation', () => {
  it('marks recovered timing gaps insufficient and does not report their partial p95 as complete', () => {
    const raw = LearningEvaluationDatasetSchema.parse(dataset())
    const item = raw.cases.find((c) => c.split === 'evaluate')!
    item.learned.latencyComplete = false
    const report = evaluateMemoryDataset(raw)
    expect(report.assessment.status).toBe('insufficient')
    expect(report.assessment.reasons).toContain('incomplete_latency_observation')
    expect(report.arms.learned.p95LatencyMs).toBeNull()
    expect(report.comparison.addedP95LatencyMs).toBeNull()
    expect(report.uncertainty.conversationBootstrap.addedP95LatencyMs95).toBeNull()
    expect(report.strata[item.category!].arms.learned.p95LatencyMs).toBeNull()
    expect(report.strata[item.category!].comparison.addedP95LatencyMs).toBeNull()
    expect(report.strata[item.category!].conversationBootstrap.addedP95LatencyMs95).toBeNull()
    const completeCategory = Object.entries(report.strata).find(
      ([category]) => category !== item.category
    )![1]
    expect(completeCategory.arms.learned.p95LatencyMs).toBe(100)
  })
  it('cannot pass foreground latency acceptance using partial or unspecified timing', () => {
    const unscoped = LearningEvaluationDatasetSchema.parse(dataset())
    delete (unscoped.frozen as { latencyScope?: unknown }).latencyScope
    expect(evaluateMemoryDataset(unscoped).assessment).toMatchObject({
      status: 'insufficient',
      reasons: expect.arrayContaining(['foreground_latency_not_measured'])
    })
    for (const latencyScope of ['knowledge_preview', 'enterprise_pipeline']) {
      const partial = { ...dataset(), frozen: { ...dataset().frozen, latencyScope } }
      const report = evaluateMemoryDataset(partial)
      expect(report.assessment.status).toBe('insufficient')
      expect(report.assessment.reasons).toContain('foreground_latency_not_measured')
    }
    const missing = LearningEvaluationDatasetSchema.parse(dataset())
    const pair = missing.cases.find((c) => c.split === 'evaluate')!
    delete pair.none!.latencyEvidenceRef
    expect(evaluateMemoryDataset(missing).assessment.reasons).toContain(
      'missing_foreground_latency_evidence'
    )
  })
  it('reports every arm, frozen policy/retrieval, background fees and all business strata', () => {
    const report = evaluateMemoryDataset(dataset())
    expect(report.assessment.status).toBe('passed')
    expect(report.arms).toHaveProperty('none.correction.numerator', 110)
    expect(report.frozen).toMatchObject({
      policyVersion: 'policy',
      retrievalVersion: 'retrieval',
      backgroundCostUsd: 0.25
    })
    expect(report).toHaveProperty('strata.inquiry.sample.evaluate', 50)
    expect(report).toHaveProperty('strata.complaint.arms.none.correction.denominator', 50)
    expect(JSON.stringify(report)).not.toContain('Synthetic test only')
  })

  it('uses reviewed drafts as the correction denominator without omitting uncovered cases', () => {
    const raw = dataset()
    for (const item of raw.cases) {
      if ('learned' in item && item.learned && Number(item.caseId.slice(5)) >= 100) {
        item.learned = {
          ...item.learned,
          reply: null as unknown as string,
          humanReviewed: false,
          substantialCorrection: false,
          validAnswer: false
        }
      }
    }
    const report = evaluateMemoryDataset(raw)
    expect(report.arms.learned.correction).toMatchObject({
      numerator: 60,
      denominator: 100,
      rate: 0.6
    })
    expect(report.arms.learned.coverage.denominator).toBe(200)
    expect(report.assessment.failedGates).toEqual(
      expect.arrayContaining(['relativeCorrectionReduction', 'coverageDrop'])
    )
  })

  it('cannot treat an unreviewed draft as accepted or accept missing v2 arm/category evidence', () => {
    const raw = LearningEvaluationDatasetSchema.parse(dataset())
    const item = raw.cases.find((c) => c.split === 'evaluate')!
    item.learned.humanReviewed = false
    expect(() => evaluateMemoryDataset(raw)).toThrow()
    const missingArm = dataset()
    delete (missingArm.cases[200] as { none?: unknown }).none
    expect(() => evaluateMemoryDataset(missingArm)).toThrow()
    const missingCategory = dataset()
    delete (missingCategory.cases[200] as { category?: unknown }).category
    expect(() => evaluateMemoryDataset(missingCategory)).toThrow()
  })

  it('keeps legacy two-arm data readable but insufficient for the full acceptance contract', () => {
    const raw = dataset()
    raw.version = 1
    const report = evaluateMemoryDataset(raw)
    expect(report.assessment.status).toBe('insufficient')
    expect(report.assessment.reasons).toContain('legacy_two_arm_contract')
  })
})
