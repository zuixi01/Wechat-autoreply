import { beforeAll, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { PublicationSchema, type Publication } from '../../server/src/generation/publication'
import {
  assessSubmission,
  FreezeEvaluationSchema
} from '../../server/src/admin/evaluation-admission'
import { evaluationPlan, evaluationSubmission } from '../fixtures/evaluation-data'
let publication: Publication
beforeAll(async () => {
  publication = PublicationSchema.parse(
    JSON.parse(await readFile('server/admin/publication.example.json', 'utf8'))
  )
  publication.configuration.automaticEnabled = true
  publication.policy.mode = 'enforced'
  publication.policy.evaluationApproved = true
})
const assess = (s: unknown) =>
  assessSubmission(
    s,
    { publication, plan: evaluationPlan(), createdAt: 1000, now: 2000 },
    'admin-A'
  )
describe('admission rejects unsupported evaluation evidence', () => {
  it('rejects a frozen plan with insufficient samples or conversation leakage', () => {
    const leaked = evaluationPlan()
    leaked.assignments[100].conversationGroup = leaked.assignments[0].conversationGroup
    expect(() => FreezeEvaluationSchema.parse({ publication, plan: leaked })).toThrow(
      'Planned conversation split leaked'
    )
    const small = evaluationPlan()
    small.assignments.pop()
    expect(() => FreezeEvaluationSchema.parse({ publication, plan: small })).toThrow()
    expect(() =>
      FreezeEvaluationSchema.parse({
        publication: { ...publication, evaluationApprovalId: 'old' },
        plan: evaluationPlan()
      })
    ).toThrow()
  })
  it('rejects a claimed pass report and an unrelated question/model/publication fingerprint', () => {
    const data = evaluationSubmission(publication, 1500)
    expect(() =>
      assess({ ...data, report: { assessment: { status: 'observed_targets_met' } } })
    ).toThrow()
    for (const field of [
      'experimentSnapshotHash',
      'jevModelResolved',
      'questionSetVersion',
      'policyVersion'
    ] as const) {
      const copy = structuredClone(data)
      copy.dataset[field] = field === 'experimentSnapshotHash' ? 'a'.repeat(64) : 'changed'
      expect(() => assess(copy)).toThrow('snapshot_mismatch')
    }
  })
  it('rejects duplicate/wrong-arm measurements, impossible stage timings and future execution', () => {
    const duplicate = evaluationSubmission(publication, 1500)
    duplicate.measurements[1] = duplicate.measurements[0]
    expect(() => assess(duplicate)).toThrow('duplicate_measurement')
    const wrong = evaluationSubmission(publication, 1500)
    wrong.measurements[0].caseId = 'unknown'
    expect(() => assess(wrong)).toThrow('execution_time_invalid')
    const timings = evaluationSubmission(publication, 1500)
    timings.measurements[0].stageLatencyMs.pre = 500
    expect(() => assess(timings)).toThrow('stage_timings_exceed_end_to_end')
    const future = evaluationSubmission(publication, 2500)
    expect(() => assess(future)).toThrow('execution_time_invalid')
  })
  it('enforces frozen latency and currency budgets', () => {
    const slow = evaluationSubmission(publication, 1500)
    for (const c of slow.dataset.cases) c.outcomes.find((o) => o.arm === 'C')!.latencyMs = 1001
    expect(() => assess(slow)).toThrow('budget_exceeded')
    const currency = evaluationSubmission(publication, 1500)
    currency.currency = 'USD'
    expect(() => assess(currency)).toThrow('snapshot_mismatch')
  })
})
