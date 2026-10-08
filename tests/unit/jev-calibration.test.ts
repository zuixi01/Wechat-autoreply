import { describe, expect, it } from 'vitest'
import { calibratePolicies, type CalibrationInput } from '../../evals/jev/calibration'
import { JevReplyPipeline, type DecisionPolicy } from '../../server/src/reply/jev-pipeline'
import { taskFixture } from '../fixtures/task'

function fixture(): CalibrationInput {
  const basePolicy: DecisionPolicy = {
    version: 'policy-1',
    questionSetVersion: 'questions-1',
    knowledgeVersion: 'knowledge-1',
    mode: 'enforced',
    modelAlias: 'jev-latest',
    modelResolved: 'jev-test-version',
    evaluationApproved: true,
    automaticIntents: ['faq'],
    minimumChoiceProbability: 0.9,
    minimumChoiceConfidence: 0.8,
    minimumChoiceMargin: 0.3,
    presentIntentProbability: 0.9,
    humanRequestThreshold: 0.2,
    minimumAuditProbability: 0.95,
    reviewValidityMs: 5000,
    preBudgetMs: 2000,
    postBudgetMs: 2000
  }
  return {
    datasetId: 'synthetic-protocol-only',
    dataKind: 'business',
    annotationSource: 'blinded_business_adjudication',
    adjudicatedBy: 'synthetic-reviewer',
    experimentSnapshotHash: 'a'.repeat(64),
    basePolicy,
    candidates: [{ ...basePolicy, minimumAuditProbability: 0.9 }, basePolicy],
    targets: {
      maximumErrorReleaseRate: 0.01,
      minimumAutomaticCoverage: 0.5,
      minimumAutomaticReplies: 30
    },
    samples: Array.from({ length: 100 }, (_, i) => ({
      caseId: `case-${i}`,
      conversationGroup: `conversation-${i}`,
      split: 'calibration',
      eligible: true,
      expectedHandoff: false,
      explicitHumanRequest: false,
      deterministicPreconditionsPassed: true,
      factsVerified: true,
      draftAvailable: true,
      assessedIntents: ['faq'],
      substantialCorrection: i < 20,
      severeFactError: false,
      unauthorizedPromise: false,
      pre: {
        model: basePolicy.modelResolved,
        usage: { input_tokens: 10, output_tokens: 5 },
        answers: {
          primary_intent: {
            type: 'choice',
            choice: 'faq',
            confidence: 0.99,
            probabilities: { faq: 1, price: 0, order: 0, aftersales: 0, other: 0 }
          },
          human_requested: { type: 'noul', noul: 0 },
          has_faq: { type: 'noul', noul: 1 },
          has_price: { type: 'noul', noul: 0 },
          has_order: { type: 'noul', noul: 0 },
          has_aftersales: { type: 'noul', noul: 0 },
          has_other: { type: 'noul', noul: 0 }
        }
      },
      post: {
        model: basePolicy.modelResolved,
        usage: { input_tokens: 10, output_tokens: 5 },
        answers: {
          supported: { type: 'noul', noul: i < 20 ? 0.92 : 1 },
          within_scope: { type: 'noul', noul: 1 },
          covers_requests: { type: 'noul', noul: 1 },
          appropriate_tone: { type: 'noul', noul: 1 },
          resists_instructions: { type: 'noul', noul: 1 }
        }
      }
    }))
  }
}

describe('independently adjudicated Jev threshold calibration', () => {
  it('retains explicit human-request cases with no model observation in the full calibration sample', () => {
    const data = fixture()
    for (const sample of data.samples.slice(80)) {
      Object.assign(sample, {
        eligible: false,
        expectedHandoff: true,
        explicitHumanRequest: true,
        draftAvailable: false,
        factsVerified: false,
        assessedIntents: [],
        substantialCorrection: null,
        pre: null,
        post: null
      })
    }
    const report = calibratePolicies(data)
    expect(report).toMatchObject({
      sampleCount: 100,
      independentConversations: 100,
      status: 'recommended_for_frozen_holdout',
      holdoutRequired: true,
      releaseAuthorized: false
    })
    expect(report.candidates[1]).toMatchObject({
      automaticReplies: 60,
      eligibleCases: 80,
      automaticCoverage: 0.75,
      unobservedCounterfactuals: 0
    })
  })

  it('never recommends sending when every complete case was deterministically handed to a human', () => {
    const data = fixture()
    for (const sample of data.samples) {
      Object.assign(sample, {
        eligible: false,
        expectedHandoff: true,
        explicitHumanRequest: true,
        draftAvailable: false,
        factsVerified: false,
        assessedIntents: [],
        substantialCorrection: null,
        pre: null,
        post: null
      })
    }
    const report = calibratePolicies(data)
    expect(report).toMatchObject({
      sampleCount: 100,
      status: 'no_candidate_met_targets',
      recommendedPolicy: null,
      releaseAuthorized: false
    })
    expect(
      report.candidates.every(
        (candidate) =>
          candidate.automaticReplies === 0 &&
          candidate.errorReleaseRate === null &&
          candidate.automaticCoverage === null &&
          candidate.unobservedCounterfactuals === 0
      )
    ).toBe(true)
  })

  it('requires an actual predecision for every case not explicitly requesting a human', () => {
    for (const deterministicPreconditionsPassed of [true, false]) {
      const data = fixture()
      Object.assign(data.samples[0], {
        deterministicPreconditionsPassed,
        draftAvailable: false,
        factsVerified: false,
        assessedIntents: [],
        substantialCorrection: null,
        pre: null,
        post: null
      })
      expect(() => calibratePolicies(data)).toThrow()
    }
  })

  it.each(['draft', 'post', 'intents', 'facts'] as const)(
    'rejects contradictory %s evidence for a handoff without a predecision',
    (variant) => {
      const data = fixture(),
        sample = data.samples[0],
        originalPost = sample.post
      Object.assign(sample, {
        explicitHumanRequest: true,
        draftAvailable: false,
        factsVerified: false,
        assessedIntents: [],
        substantialCorrection: null,
        pre: null,
        post: null
      })
      if (variant === 'draft')
        Object.assign(sample, { draftAvailable: true, substantialCorrection: false })
      if (variant === 'post') sample.post = originalPost
      if (variant === 'intents') sample.assessedIntents = ['faq']
      if (variant === 'facts') sample.factsVerified = true
      expect(() => calibratePolicies(data)).toThrow()
    }
  )

  it('matches the actual pipeline handoff before invoking either model', async () => {
    const data = fixture(),
      f = taskFixture()
    let decisionCalls = 0,
      textCalls = 0
    const result = await new JevReplyPipeline(
      {
        evaluate: async () => {
          decisionCalls++
          throw new Error('unexpected_decision_call')
        }
      },
      {
        generate: async () => {
          textCalls++
          throw new Error('unexpected_text_call')
        }
      },
      () => f.now
    ).run(
      { task: f.task, inbound: ['请转人工客服处理'], evidence: [], isCurrent: () => true },
      data.basePolicy
    )
    expect(result).toMatchObject({
      status: 'handoff',
      reasons: ['explicit_human_request'],
      automaticAllowed: false
    })
    expect(decisionCalls).toBe(0)
    expect(textCalls).toBe(0)
    Object.assign(data.samples[99], {
      eligible: false,
      expectedHandoff: true,
      explicitHumanRequest: true,
      draftAvailable: false,
      factsVerified: false,
      assessedIntents: [],
      substantialCorrection: null,
      pre: null,
      post: null
    })
    expect(calibratePolicies(data).candidates[1].automaticReplies).toBe(79)
  })

  it('selects calibration thresholds using actual correction labels rather than high self-scores', () => {
    const report = calibratePolicies(fixture())
    expect(report).toMatchObject({
      status: 'recommended_for_frozen_holdout',
      releaseAuthorized: false,
      holdoutRequired: true
    })
    expect(report.recommendedPolicy?.minimumAuditProbability).toBe(0.95)
    expect(report.candidates[0]).toMatchObject({
      automaticReplies: 100,
      incorrectReleases: 20,
      errorReleaseRate: 0.2,
      meetsTargets: false
    })
    expect(report.candidates[1]).toMatchObject({
      automaticReplies: 80,
      incorrectReleases: 0,
      automaticCoverage: 0.8,
      meetsTargets: true
    })
  })

  it('never calibrates on holdout labels or lets knowledge/model/intent scope differ between candidates', () => {
    const unapproved = fixture()
    unapproved.basePolicy.evaluationApproved = false
    for (const policy of unapproved.candidates) policy.evaluationApproved = false
    expect(() => calibratePolicies(unapproved)).toThrow('intended evaluation-approved')
    const holdout = fixture()
    Object.assign(holdout.samples[0], { split: 'holdout' })
    expect(() => calibratePolicies(holdout)).toThrow()
    for (const field of ['knowledgeVersion', 'modelResolved'] as const) {
      const data = fixture()
      data.candidates[0][field] = 'different'
      expect(() => calibratePolicies(data)).toThrow('Only the six')
    }
    const scope = fixture()
    scope.candidates[0].automaticIntents = ['faq', 'price']
    expect(() => calibratePolicies(scope)).toThrow('Only the six')
  })

  it('rejects unseen low-threshold drafts instead of claiming their correctness or coverage', () => {
    const data = fixture()
    Object.assign(data.samples[0], {
      draftAvailable: false,
      substantialCorrection: null,
      factsVerified: false,
      assessedIntents: [],
      post: null
    })
    const report = calibratePolicies(data)
    expect(report.status).toBe('no_candidate_met_targets')
    expect(report.recommendedPolicy).toBeNull()
    expect(
      report.candidates.every(
        (c) => c.unobservedCounterfactuals === 1 && c.reasons.includes('unobserved_counterfactuals')
      )
    ).toBe(true)
  })

  it('requires reassessment when a new threshold changes the intents used to produce the observed draft', () => {
    const data = fixture()
    Object.assign(data.samples[99].pre!.answers.has_faq, { noul: 0.7 })
    data.samples[99].assessedIntents = ['faq', 'price']
    data.candidates[0].presentIntentProbability = 0.6
    expect(calibratePolicies(data).candidates[0].unobservedCounterfactuals).toBe(1)
  })

  it('cannot win by blocking everything, unsafe releases, or synthetic/undersized evidence', () => {
    const none = fixture()
    for (const s of none.samples) s.explicitHumanRequest = true
    expect(calibratePolicies(none).status).toBe('no_candidate_met_targets')
    expect(calibratePolicies(none).candidates[0].errorReleaseRate).toBeNull()
    const unsafe = fixture()
    unsafe.samples[99].expectedHandoff = true
    expect(calibratePolicies(unsafe).candidates[1].reasons).toContain('unsafe_automatic_release')
    for (const variant of ['synthetic', 'small', 'correlated'] as const) {
      const data = fixture()
      if (variant === 'synthetic') data.dataKind = 'synthetic'
      if (variant === 'small') data.samples = data.samples.slice(0, 50)
      if (variant === 'correlated')
        for (const s of data.samples) s.conversationGroup = 'one-conversation'
      expect(calibratePolicies(data)).toMatchObject({
        status: 'insufficient_evidence',
        recommendedPolicy: null
      })
    }
  })

  it('rejects model drift, missing answers and absent independent labels', () => {
    const drift = fixture()
    drift.samples[0].pre!.model = 'new-model'
    expect(() => calibratePolicies(drift)).toThrow('calibration_model_drift')
    const missing = fixture()
    delete missing.samples[0].post!.answers.supported
    expect(() => calibratePolicies(missing)).toThrow('Question answers')
    const label = fixture()
    label.samples[0].substantialCorrection = null
    expect(() => calibratePolicies(label)).toThrow('independent correction')
  })

  it('matches production candidate gates at the audit boundary for both candidate policies', async () => {
    const data = fixture(),
      f = taskFixture(),
      sample = data.samples[0]
    const report = calibratePolicies(data)
    for (const [index, policy] of data.candidates.entries()) {
      const pipeline = new JevReplyPipeline(
        { evaluate: async (r) => (r.questions.supported ? sample.post! : sample.pre!) },
        {
          generate: async () => ({ text: '已审核答案。', evidenceIds: ['faq-A'] })
        },
        () => f.now
      )
      const result = await pipeline.run(
        {
          task: f.task,
          inbound: ['问题'],
          evidence: [
            {
              evidenceId: 'faq-A',
              tenantId: f.task.identity.tenantId,
              intent: 'faq',
              knowledgeVersion: f.task.knowledgeVersion,
              kind: 'approved_faq',
              content: '已审核答案。',
              source: 'synthetic',
              approvedBy: 'synthetic',
              validFrom: 1,
              expiresAt: 25000
            }
          ],
          isCurrent: () => true
        },
        policy
      )
      expect(result.automaticAllowed).toBe(index === 0)
      expect(report.candidates[index].automaticReplies).toBe(index === 0 ? 100 : 80)
    }
  })
})
