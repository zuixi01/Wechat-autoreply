import { describe, expect, it } from 'vitest'
import {
  evaluateDataset,
  evaluateCalibratedHoldout,
  type EvaluationDataset
} from '../../evals/jev/metrics'

function dataset(): EvaluationDataset {
  return {
    datasetId: 'synthetic-only',
    experimentSnapshotHash: 'a'.repeat(64),
    jevModelResolved: 'jev-test',
    questionSetVersion: 'q1',
    policyVersion: 'p1',
    annotationSource: 'blinded_business_adjudication',
    adjudicatedBy: 'synthetic-test-fixture',
    thresholdsFrozenBeforeHoldout: true,
    cases: Array.from({ length: 300 }, (_, i) => ({
      caseId: `case-${i}`,
      conversationGroup: `conversation-${i}`,
      split: i < 100 ? 'calibration' : 'holdout',
      category: 'faq',
      eligible: true,
      expectedHandoff: false,
      intentCount: 1,
      outcomes: (['A', 'B', 'C'] as const).map((arm) => ({
        arm,
        automatic: true,
        suggested: true,
        substantialCorrection: arm === 'A' ? i % 2 === 0 : arm === 'B' ? i % 4 === 0 : i % 10 === 0,
        severeFactError: false,
        unauthorizedPromise: false,
        incorrectlyBlocked: false,
        coveredIntents: 1,
        latencyMs: i + 10,
        inputTokens: 10,
        outputTokens: 2
      }))
    }))
  }
}
describe('independently annotated paired evaluation metrics', () => {
  it('counts numerators and denominators and compares on the holdout only', () => {
    const report = evaluateDataset(dataset(), { replicates: 200 })
    expect(report.arms.A.errorRelease).toMatchObject({
      numerator: 100,
      denominator: 200,
      rate: 0.5
    })
    expect(report.arms.C.errorRelease).toMatchObject({ numerator: 20, denominator: 200, rate: 0.1 })
    expect(report.comparisons.AtoC).toEqual({ relativeErrorReduction: 0.8, coverageChange: 0 })
    expect(report.assessment.status).toBe('observed_targets_met')
    expect(report.arms.C.tokens).toEqual({ input: 2000, output: 400 })
  })
  it('rejects calibration/test conversation leakage and missing paired arms', () => {
    const data = dataset()
    data.cases[100].conversationGroup = data.cases[0].conversationGroup
    expect(() => evaluateDataset(data)).toThrow('Conversation leaked')
    const paired = dataset()
    paired.cases[0].outcomes[2].arm = 'A'
    expect(() => evaluateDataset(paired)).toThrow('Exactly one paired')
  })
  it('does not turn sending nothing into a successful accuracy assessment', () => {
    const data = dataset()
    for (const item of data.cases)
      Object.assign(item.outcomes[2], {
        automatic: false,
        suggested: false,
        substantialCorrection: null,
        coveredIntents: 0
      })
    const report = evaluateDataset(data, { replicates: 100 })
    expect(report.arms.C.errorRelease.rate).toBeNull()
    expect(report.arms.C.errorRelease.descriptiveWilson95).toBeNull()
    expect(report.assessment.status).toBe('insufficient_evidence')
    expect(report.assessment.reasons).toContain('coverage_target_not_met')
  })
  it('does not claim improvement with no baseline errors or too few independent conversations', () => {
    const data = dataset()
    for (const item of data.cases) {
      for (const o of item.outcomes) o.substantialCorrection = false
      item.conversationGroup = item.split
    }
    const report = evaluateDataset(data, { replicates: 100 })
    expect(report.comparisons.AtoC.relativeErrorReduction).toBeNull()
    expect(report.assessment.reasons).toContain('too_few_baseline_errors')
    expect(report.assessment.reasons).toContain('too_few_independent_conversations')
  })
  it('reports serious releases and blocks inaccurate labels instead of hiding them', () => {
    const data = dataset()
    data.cases[100].outcomes[2].severeFactError = true
    const report = evaluateDataset(data, { replicates: 100 })
    expect(report.assessment.status).toBe('targets_not_met')
    expect(report.assessment.reasons).toContain('unsafe_automatic_release')
    data.cases[100].outcomes[2].substantialCorrection = false
    expect(() => evaluateDataset(data)).toThrow('Severe errors require')
  })
  it('uses the pre-labelled eligible denominator and retains paired conversation groups', () => {
    const data = dataset()
    for (let i = 100; i < 120; i++) {
      data.cases[i].eligible = false
      data.cases[i].expectedHandoff = true
    }
    const report = evaluateDataset(data, { replicates: 100, seed: 12 })
    expect(report.arms.C.automaticCoverage.denominator).toBe(180)
    expect(report.arms.C.inappropriateRelease.numerator).toBe(20)
    expect(report.pairedConversationBootstrap.independentConversationGroups).toBe(200)
    expect(evaluateDataset(data, { replicates: 100, seed: 12 })).toEqual(report)
  })
})

describe('calibration lineage with distinct holdout snapshot statistics', () => {
  function splits() {
    const original = dataset()
    return {
      calibration: { ...original, cases: original.cases.slice(0, 100) },
      holdout: {
        ...original,
        experimentSnapshotHash: 'b'.repeat(64),
        policyVersion: 'p2',
        cases: original.cases.slice(100)
      }
    }
  }
  it('preserves both snapshots and uses only held-out outcomes with the full bootstrap budget', () => {
    const { calibration, holdout } = splits()
    const report = evaluateCalibratedHoldout(calibration, holdout)
    expect(report.calibration).toMatchObject({
      experimentSnapshotHash: 'a'.repeat(64),
      policyVersion: 'p1',
      sampleCount: 100
    })
    expect(report.holdout).toMatchObject({
      experimentSnapshotHash: 'b'.repeat(64),
      versions: { policyVersion: 'p2' },
      sample: { holdout: 200 }
    })
    expect(report.holdout.pairedConversationBootstrap.replicates).toBe(2000)
    expect(report.holdout.arms.A.errorRelease).toMatchObject({ numerator: 100, denominator: 200 })
    expect(report.holdout.assessment.status).toBe('observed_targets_met')
    expect(report.releaseAuthorized).toBe(false)
    expect(report.dataKind).toBe('unverified')
    expect(report.businessTruthVerified).toBe(false)
    for (const c of calibration.cases) for (const o of c.outcomes) o.substantialCorrection = false
    expect(evaluateCalibratedHoldout(calibration, holdout)).toEqual(report)
  })
  it('does not replace missing calibration or holdout observations with a claimed sample count', () => {
    const { calibration, holdout } = splits()
    const report = evaluateCalibratedHoldout(
      { ...calibration, cases: calibration.cases.slice(1) },
      { ...holdout, cases: holdout.cases.slice(1) }
    )
    expect(report.holdout.assessment.status).toBe('insufficient_evidence')
    expect(report.holdout.assessment.reasons).toContain('calibration_below_100')
    expect(report.holdout.assessment.reasons).toContain('holdout_below_200')
    expect(() => evaluateCalibratedHoldout({ ...calibration, sampleCount: 100 }, holdout)).toThrow()
  })
  it('rejects mixed splits, reused versions, changed models/datasets/questions and cross-snapshot leakage', () => {
    for (const change of [
      (c, h) => {
        h.cases[0].conversationGroup = c.cases[0].conversationGroup
      },
      (c, h) => {
        h.cases[0].caseId = c.cases[0].caseId
      },
      (_c, h) => {
        h.cases[0].split = 'calibration'
      },
      (c, h) => {
        h.experimentSnapshotHash = c.experimentSnapshotHash
      },
      (c, h) => {
        h.policyVersion = c.policyVersion
      },
      (_c, h) => {
        h.jevModelResolved = 'changed'
      },
      (_c, h) => {
        h.questionSetVersion = 'changed'
      },
      (_c, h) => {
        h.datasetId = 'changed'
      }
    ] as ((c: EvaluationDataset, h: EvaluationDataset) => void)[]) {
      const { calibration, holdout } = splits()
      change(calibration, holdout)
      expect(() => evaluateCalibratedHoldout(calibration, holdout)).toThrow()
    }
  })
  it('keeps no-baseline-error and serious-release refusals on the holdout', () => {
    const { calibration, holdout } = splits()
    for (const c of holdout.cases) for (const o of c.outcomes) o.substantialCorrection = false
    const report = evaluateCalibratedHoldout(calibration, holdout)
    expect(report.holdout.assessment.status).toBe('insufficient_evidence')
    expect(report.holdout.assessment.reasons).toContain('too_few_baseline_errors')
    holdout.cases[0].outcomes[2].severeFactError = true
    holdout.cases[0].outcomes[2].substantialCorrection = true
    expect(evaluateCalibratedHoldout(calibration, holdout).holdout.assessment.reasons).toContain(
      'unsafe_automatic_release'
    )
  })
  it('does not qualify calibration from many rounds in one conversation', () => {
    const { calibration, holdout } = splits()
    for (const item of calibration.cases) item.conversationGroup = 'one-calibration-conversation'
    const report = evaluateCalibratedHoldout(calibration, holdout)
    expect(report.holdout.assessment.status).toBe('insufficient_evidence')
    expect(report.holdout.assessment.reasons).toContain(
      'calibration_too_few_independent_conversations'
    )
  })
})
