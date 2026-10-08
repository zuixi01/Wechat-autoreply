import { beforeAll, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import {
  replayCaseInputHash,
  validateFrozenReplayInputs,
  type FrozenReplaySource,
  type ReplayCaseInput
} from '../../evals/jev/replay-input'
import { hashContext } from '../../src/core/reply/hashes'
import { PublicationSchema, type Publication } from '../../server/src/generation/publication'
import { evaluationSnapshotHash } from '../../server/src/generation/evaluation-authorization'
import { EvaluationPlanSchema, assessSubmission } from '../../server/src/admin/evaluation-admission'
import { evaluationPlan, evaluationSubmission } from '../fixtures/evaluation-data'

let publication: Publication
beforeAll(async () => {
  publication = PublicationSchema.parse(
    JSON.parse(await readFile('server/admin/publication.example.json', 'utf8'))
  )
  publication.configuration.automaticEnabled = true
  publication.policy.mode = 'enforced'
  publication.policy.evaluationApproved = true
  publication.evidence = [
    {
      evidenceId: 'synthetic-faq',
      tenantId: 'synthetic-tenant',
      intent: 'faq',
      knowledgeVersion: publication.configuration.knowledgeVersion,
      kind: 'approved_faq',
      content: '合成已审答案',
      source: 'synthetic',
      approvedBy: 'synthetic-reviewer',
      validFrom: 0,
      expiresAt: 100000000
    }
  ]
})
function fixture() {
  const plan = evaluationPlan()
  const cases: ReplayCaseInput[] = plan.assignments.map((a, index) => ({
    caseId: a.caseId,
    conversationGroup: a.conversationGroup,
    split: a.split,
    conversationId: `synthetic-peer-${index}`,
    inbound: ['合成产品问题'],
    context: [
      {
        sequence: 1,
        sourceMessageId: `message-${index}`,
        direction: 'inbound',
        kind: 'text',
        text: '合成产品问题'
      }
    ]
  }))
  plan.replayProtocol = 'jev-abc-v1'
  plan.assignments = plan.assignments.map((a, i) => ({
    ...a,
    inputHash: replayCaseInputHash(cases[i])
  }))
  const frozen: FrozenReplaySource = {
    runId: 'synthetic-frozen-run',
    snapshotHash: evaluationSnapshotHash(publication),
    publication: structuredClone(publication),
    plan,
    createdAt: new Date(1000),
    expiresAt: new Date(3000),
    serverNow: new Date(2000)
  }
  return {
    frozen,
    input: { datasetId: plan.datasetId, split: 'holdout' as const, cases: cases.slice(100) }
  }
}

describe('database-frozen Jev replay inputs', () => {
  it('checks a complete split and exposes counts without model calls, labels or customer text', () => {
    const { frozen, input } = fixture()
    const result = validateFrozenReplayInputs(frozen, input, publication.textGeneratorVersion)
    expect(result.summary).toMatchObject({
      caseCount: 200,
      maximumLogicalModelCalls: 1200,
      modelsCalled: false,
      releaseAuthorized: false
    })
    expect(result.summary.executionPlanHash).toBe(hashContext(frozen.plan))
    expect(JSON.stringify(result.summary)).not.toContain('合成产品问题')
  })

  it('refuses content/context/customer substitutions even with unchanged case IDs', () => {
    for (const change of ['inbound', 'context', 'customer'] as const) {
      const { frozen, input } = fixture()
      if (change === 'inbound') input.cases[0].inbound[0] = '换一批业务问题'
      if (change === 'context') input.cases[0].context![0].text = '换一批历史原文'
      if (change === 'customer') input.cases[0].conversationId = 'another-peer'
      expect(() =>
        validateFrozenReplayInputs(frozen, input, publication.textGeneratorVersion)
      ).toThrow('replay_case_changed_or_unplanned')
    }
  })

  it('rejects missing, duplicate, cross-split cases and independent labels in model input', () => {
    const missing = fixture()
    missing.input.cases.pop()
    expect(() =>
      validateFrozenReplayInputs(missing.frozen, missing.input, publication.textGeneratorVersion)
    ).toThrow('replay_sample_incomplete')
    const duplicate = fixture()
    duplicate.input.cases[1] = duplicate.input.cases[0]
    expect(() =>
      validateFrozenReplayInputs(
        duplicate.frozen,
        duplicate.input,
        publication.textGeneratorVersion
      )
    ).toThrow('replay_case_changed_or_unplanned')
    const crossed = fixture()
    crossed.input.cases[0].split = 'calibration'
    expect(() =>
      validateFrozenReplayInputs(crossed.frozen, crossed.input, publication.textGeneratorVersion)
    ).toThrow('replay_case_changed_or_unplanned')
    const labels = fixture()
    Object.assign(labels.input.cases[0], { expectedAnswer: '不能进入模型输入的人工标签' })
    expect(() =>
      validateFrozenReplayInputs(labels.frozen, labels.input, publication.textGeneratorVersion)
    ).toThrow()
  })

  it('refuses legacy unbound plans, expired runs, generator drift and altered publications', () => {
    const legacy = fixture()
    legacy.frozen.plan = evaluationPlan()
    expect(() =>
      validateFrozenReplayInputs(legacy.frozen, legacy.input, publication.textGeneratorVersion)
    ).toThrow('replay_inputs_not_frozen')
    const expired = fixture()
    expired.frozen.serverNow = expired.frozen.expiresAt
    expect(() =>
      validateFrozenReplayInputs(expired.frozen, expired.input, publication.textGeneratorVersion)
    ).toThrow('evaluation_run_expired_or_invalid')
    const drift = fixture()
    expect(() =>
      validateFrozenReplayInputs(drift.frozen, drift.input, 'different-generator')
    ).toThrow('text_generator_changed')
    drift.frozen.publication.evidence[0].content = '知识内容已变'
    expect(() =>
      validateFrozenReplayInputs(drift.frozen, drift.input, publication.textGeneratorVersion)
    ).toThrow('frozen_snapshot_invalid')
  })

  it('requires protocol and all input hashes together rather than silently enabling old freezes', () => {
    const missing = fixture().frozen.plan
    delete missing.assignments[0].inputHash
    expect(() => EvaluationPlanSchema.parse(missing)).toThrow('must be frozen together')
    const legacy = fixture().frozen.plan
    delete legacy.replayProtocol
    expect(() => EvaluationPlanSchema.parse(legacy)).toThrow('must be frozen together')
  })

  it('binds new admissions to the exact input plan, while preserving historical manual submissions', () => {
    const { frozen } = fixture()
    const submission = evaluationSubmission(publication, 1500)
    const assess = (value: unknown, plan = frozen.plan) =>
      assessSubmission(value, { publication, plan, createdAt: 1000, now: 2000 }, 'admin-A')
    expect(() => assess(submission)).toThrow('execution_plan_mismatch')
    submission.executionPlanHash = hashContext(frozen.plan)
    expect(() => assess(submission)).not.toThrow()
    frozen.plan.assignments[0].inputHash = 'b'.repeat(64)
    expect(() => assess(submission)).toThrow('execution_plan_mismatch')
    expect(() => assess(submission, evaluationPlan())).toThrow('execution_plan_mismatch')
    delete submission.executionPlanHash
    expect(() => assess(submission, evaluationPlan())).not.toThrow()
  })
})
