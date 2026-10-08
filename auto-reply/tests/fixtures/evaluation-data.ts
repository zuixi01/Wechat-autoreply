import type { Publication } from '../../server/src/generation/publication'
import { evaluationSnapshotHash } from '../../server/src/generation/evaluation-authorization'
import type { z } from 'zod'
import type {
  EvaluationPlanSchema,
  EvaluationSubmissionSchema
} from '../../server/src/admin/evaluation-admission'

/** Entirely synthetic protocol fixtures; the business marker only exercises the
 * trusted operator admission branch. It is not evidence of business accuracy. */
export function evaluationPlan(): z.infer<typeof EvaluationPlanSchema> {
  return {
    datasetId: 'synthetic-protocol',
    currency: 'CNY',
    maximumTurnCostMicros: 10000,
    maximumP95LatencyMs: 1000,
    assignments: Array.from({ length: 300 }, (_, i) => ({
      caseId: `case-${i}`,
      conversationGroup: `conversation-${i}`,
      split: i < 100 ? 'calibration' : 'holdout'
    }))
  }
}
export function evaluationSubmission(
  p: Publication,
  executedAt: number
): z.infer<typeof EvaluationSubmissionSchema> {
  const plan = evaluationPlan()
  return {
    dataKind: 'business',
    currency: plan.currency,
    dataset: {
      datasetId: plan.datasetId,
      experimentSnapshotHash: evaluationSnapshotHash(p),
      jevModelResolved: p.configuration.modelResolved,
      questionSetVersion: p.configuration.questionSetVersion,
      policyVersion: p.configuration.decisionPolicyVersion,
      annotationSource: 'blinded_business_adjudication',
      adjudicatedBy: 'adjudicator-A',
      thresholdsFrozenBeforeHoldout: true,
      cases: plan.assignments.map((a, i) => ({
        ...a,
        category: 'faq',
        eligible: true,
        expectedHandoff: false,
        intentCount: 1,
        outcomes: (['A', 'B', 'C'] as const).map((arm) => ({
          arm,
          automatic: true,
          suggested: true,
          substantialCorrection: i % (arm === 'A' ? 2 : arm === 'B' ? 4 : 20) === 0,
          severeFactError: false,
          unauthorizedPromise: false,
          incorrectlyBlocked: false,
          coveredIntents: 1,
          latencyMs: 100,
          inputTokens: 10,
          outputTokens: 10
        }))
      }))
    },
    measurements: plan.assignments.flatMap((a) =>
      (['A', 'B', 'C'] as const).map((arm) => ({
        caseId: a.caseId,
        arm,
        executedAt,
        billedCostMicros: 5000,
        stageLatencyMs: { retrieval: 10, pre: 20, text: 30, post: 20 }
      }))
    )
  }
}
