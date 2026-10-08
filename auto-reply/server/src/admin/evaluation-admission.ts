import { z } from 'zod'
import { Hash, Id } from '../../../src/shared/contracts/identity'
import { hashContext } from '../../../src/core/reply/hashes'
import {
  EvaluationDatasetSchema,
  evaluateDataset,
  type EvaluationReport
} from '../../../evals/jev/metrics'
import { PublicationSchema, type Publication } from '../generation/publication'
import { EVALUATION_METHOD, evaluationSnapshotHash } from '../generation/evaluation-authorization'

const Assignment = z.strictObject({
  caseId: Id,
  conversationGroup: Id,
  split: z.enum(['calibration', 'holdout']),
  inputHash: Hash.optional()
})
export const EvaluationPlanSchema = z
  .strictObject({
    datasetId: Id,
    assignments: z.array(Assignment).min(300).max(2000),
    replayProtocol: z.literal('jev-abc-v1').optional(),
    currency: z.enum(['CNY', 'USD']),
    maximumTurnCostMicros: z.number().int().positive().max(100_000_000),
    maximumP95LatencyMs: z.number().positive().max(300_000)
  })
  .superRefine((p, c) => {
    if (
      p.replayProtocol
        ? p.assignments.some((a) => !a.inputHash)
        : p.assignments.some((a) => a.inputHash !== undefined)
    )
      c.addIssue({
        code: 'custom',
        message: 'Replay protocol and every case input hash must be frozen together'
      })
    const ids = new Set<string>(),
      groups = new Map<string, string>()
    for (const a of p.assignments) {
      if (ids.has(a.caseId)) c.addIssue({ code: 'custom', message: 'Duplicate planned case' })
      ids.add(a.caseId)
      if (groups.has(a.conversationGroup) && groups.get(a.conversationGroup) !== a.split)
        c.addIssue({ code: 'custom', message: 'Planned conversation split leaked' })
      groups.set(a.conversationGroup, a.split)
    }
    if (
      p.assignments.filter((a) => a.split === 'calibration').length < 100 ||
      p.assignments.filter((a) => a.split === 'holdout').length < 200 ||
      new Set(p.assignments.filter((a) => a.split === 'holdout').map((a) => a.conversationGroup))
        .size < 30
    )
      c.addIssue({ code: 'custom', message: 'Insufficient frozen sample' })
  })
export const FreezeEvaluationSchema = z
  .strictObject({
    publication: PublicationSchema,
    plan: EvaluationPlanSchema
  })
  .superRefine((v, c) => {
    if (!v.publication.configuration.automaticEnabled || v.publication.evaluationApprovalId)
      c.addIssue({
        code: 'custom',
        message: 'Freeze the intended automatic publication without an approval reference'
      })
  })
const stages = z.strictObject({
  retrieval: z.number().nonnegative(),
  pre: z.number().nonnegative(),
  text: z.number().nonnegative(),
  post: z.number().nonnegative()
})
export const EvaluationSubmissionSchema = z.strictObject({
  executionPlanHash: Hash.optional(),
  dataKind: z.enum(['business', 'synthetic']),
  currency: z.enum(['CNY', 'USD']),
  dataset: EvaluationDatasetSchema,
  measurements: z
    .array(
      z.strictObject({
        caseId: Id,
        arm: z.enum(['A', 'B', 'C']),
        executedAt: z.number().int().nonnegative(),
        billedCostMicros: z.number().int().nonnegative().max(100_000_000),
        stageLatencyMs: stages
      })
    )
    .min(1)
    .max(6000)
})
export class EvaluationAdmissionError extends Error {
  readonly code = 'EVALUATION_REJECTED'
  constructor(readonly reason: string) {
    super(reason)
    this.name = 'EvaluationAdmissionError'
  }
}
function reject(reason: string): never {
  throw new EvaluationAdmissionError(reason)
}
export interface AdmissionReport {
  method: string
  metrics: EvaluationReport
  currency: 'CNY' | 'USD'
  maximumObservedCostMicros: number
  stageLatencyMs: Record<string, { p50: number; p95: number }>
}

/** Recompute from paired labels; an uploaded summary/pass flag has no authority.
 * Business labels and billing provenance remain the operator's responsibility. */
export function assessSubmission(
  input: unknown,
  frozen: { publication: Publication; plan: unknown; createdAt: number; now: number },
  reviewerId: string
): { submission: z.infer<typeof EvaluationSubmissionSchema>; report: AdmissionReport } {
  const s = EvaluationSubmissionSchema.parse(input),
    p = frozen.publication,
    plan = EvaluationPlanSchema.parse(frozen.plan),
    d = s.dataset
  if (s.dataKind !== 'business') reject('synthetic_data_cannot_enable_automatic_reply')
  if (
    plan.replayProtocol
      ? s.executionPlanHash !== hashContext(plan)
      : s.executionPlanHash !== undefined
  )
    reject('execution_plan_mismatch')
  if (d.adjudicatedBy === reviewerId) reject('independent_adjudicator_required')
  if (
    d.datasetId !== plan.datasetId ||
    s.currency !== plan.currency ||
    d.experimentSnapshotHash !== evaluationSnapshotHash(p) ||
    d.jevModelResolved !== p.configuration.modelResolved ||
    d.questionSetVersion !== p.configuration.questionSetVersion ||
    d.policyVersion !== p.configuration.decisionPolicyVersion
  )
    reject('snapshot_mismatch')
  const assignments = new Map(plan.assignments.map((a) => [a.caseId, a]))
  if (assignments.size !== d.cases.length) reject('planned_sample_mismatch')
  const measurements = new Map<string, (typeof s.measurements)[number]>()
  for (const m of s.measurements) {
    const key = JSON.stringify([m.caseId, m.arm])
    if (measurements.has(key)) reject('duplicate_measurement')
    measurements.set(key, m)
  }
  if (measurements.size !== d.cases.length * 3) reject('incomplete_measurements')
  let maximumObservedCostMicros = 0
  const stageValues: Record<string, number[]> = { retrieval: [], pre: [], text: [], post: [] }
  for (const item of d.cases) {
    const a = assignments.get(item.caseId)
    if (!a || a.split !== item.split || a.conversationGroup !== item.conversationGroup)
      reject('planned_sample_mismatch')
    for (const o of item.outcomes) {
      const m = measurements.get(JSON.stringify([item.caseId, o.arm]))
      if (
        !m ||
        m.executedAt > frozen.now ||
        (item.split === 'holdout' && m.executedAt < frozen.createdAt)
      )
        reject('execution_time_invalid')
      if (Object.values(m.stageLatencyMs).reduce((a, b) => a + b, 0) > o.latencyMs + 1e-6)
        reject('stage_timings_exceed_end_to_end')
      if (item.split === 'holdout' && o.arm === 'C') {
        maximumObservedCostMicros = Math.max(maximumObservedCostMicros, m.billedCostMicros)
        for (const [name, value] of Object.entries(m.stageLatencyMs)) stageValues[name].push(value)
      }
    }
  }
  const metrics = evaluateDataset(d)
  if (metrics.assessment.status !== 'observed_targets_met') reject('accuracy_targets_not_met')
  if (
    maximumObservedCostMicros > plan.maximumTurnCostMicros ||
    (metrics.arms.C.latencyMs.p95 ?? Infinity) > plan.maximumP95LatencyMs
  )
    reject('budget_exceeded')
  const percentile = (values: number[], q: number): number => {
    const v = values.sort((a, b) => a - b),
      i = (v.length - 1) * q
    return v[Math.floor(i)] + (v[Math.ceil(i)] - v[Math.floor(i)]) * (i - Math.floor(i))
  }
  return {
    submission: s,
    report: {
      method: EVALUATION_METHOD,
      metrics,
      currency: s.currency,
      maximumObservedCostMicros,
      stageLatencyMs: Object.fromEntries(
        Object.entries(stageValues).map(([stage, values]) => [
          stage,
          { p50: percentile(values, 0.5), p95: percentile(values, 0.95) }
        ])
      )
    }
  }
}
