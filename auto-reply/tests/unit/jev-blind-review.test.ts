import { beforeAll, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import {
  assertJevBlindReviewFreeze,
  createJevBlindReview,
  importJevBlindLabels
} from '../../evals/jev/blind-review'
import { type AuthorizedReplaySource, type JevReplayArmArtifact } from '../../evals/jev/replay'
import { replayCaseInputHash } from '../../evals/jev/replay-input'
import { hashContext, hashDraft } from '../../src/core/reply/hashes'
import { PublicationSchema, type Publication } from '../../server/src/generation/publication'
import { evaluationSnapshotHash } from '../../server/src/generation/evaluation-authorization'
import { evaluationPlan } from '../fixtures/evaluation-data'
import { preQuestions, auditQuestions } from '../../server/src/reply/jev-pipeline'
import type { JevRequest, JevResponse } from '../../src/shared/contracts/decision'
import { prepareJevReplayCalibration } from '../../evals/jev/calibration-replay'

// Synthetic protocol checks only. Neither HTTP execution nor business accuracy
// is established by these fixtures or by an artifact's consistency hash.
let publication: Publication
beforeAll(async () => {
  publication = PublicationSchema.parse(
    JSON.parse(await readFile('server/admin/publication.example.json', 'utf8'))
  )
})
function syntheticResponse(questions: JevRequest['questions']): JevResponse {
  return {
    model: publication.policy.modelResolved,
    usage: { input_tokens: 2, output_tokens: 3 },
    answers: Object.fromEntries(
      Object.entries(questions).map(([id, question]) => [
        id,
        question.type === 'choice'
          ? {
              type: 'choice',
              choice: 'faq',
              confidence: 1,
              probabilities: Object.fromEntries(
                Object.keys(question.criteria).map((key) => [key, key === 'faq' ? 1 : 0])
              )
            }
          : {
              type: 'noul',
              noul: id === 'human_requested' || (id.startsWith('has_') && id !== 'has_faq') ? 0 : 1
            }
      ])
    )
  }
}
function fixture(knownUsage = true, split: 'calibration' | 'holdout' = 'calibration') {
  const plan = evaluationPlan()
  plan.replayProtocol = 'jev-abc-v1'
  const allCases = plan.assignments.map((a) => ({
    ...a,
    conversationId: 'synthetic-customer',
    inbound: [`Synthetic question ${a.caseId}`]
  }))
  plan.assignments.forEach((a, i) => {
    a.inputHash = replayCaseInputHash(allCases[i])
  })
  const frozen: AuthorizedReplaySource = {
    authenticatedScope: {
      tenantId: 'synthetic-tenant',
      accountId: 'synthetic-account',
      employeeId: 'synthetic-employee',
      platform: 'wechat'
    },
    runId: 'synthetic-run',
    publication: structuredClone(publication),
    plan,
    snapshotHash: evaluationSnapshotHash(publication),
    createdAt: new Date(1000),
    serverNow: new Date(10000),
    expiresAt: new Date(100000)
  }
  const rawCases = {
    datasetId: plan.datasetId,
    split,
    cases: allCases.filter((item) => item.split === split)
  }
  const artifacts: JevReplayArmArtifact[] = rawCases.cases.flatMap((c) =>
    (['A', 'B', 'C'] as const).map((arm) => {
      const stages =
        arm === 'A'
          ? (['text'] as const)
          : arm === 'B'
            ? (['pre', 'text'] as const)
            : (['pre', 'text', 'post'] as const)
      const pre = syntheticResponse(preQuestions()),
        post = syntheticResponse(auditQuestions())
      return {
        runId: frozen.runId,
        caseId: c.caseId,
        arm,
        assignmentId: `${c.caseId}-${arm}`,
        protocol: 'jev-abc-v1',
        baselineRoute: 'automatic-intents-with-scoped-evidence-v1',
        inputHash: replayCaseInputHash(c),
        executionPlanHash: hashContext(plan),
        snapshotHash: frozen.snapshotHash,
        status: 'candidate',
        wouldRelease: arm !== 'B',
        releaseAuthorized: false,
        factsVerified: true,
        intents: ['faq'],
        reasons: [],
        draft: {
          text: `Synthetic actual draft ${c.caseId} ${arm}`,
          evidenceIds: ['synthetic-evidence'],
          draftHash: hashDraft(`Synthetic actual draft ${c.caseId} ${arm}`)
        },
        pre: arm === 'A' ? null : pre,
        post: arm === 'C' ? post : null,
        stages: stages.map((stage) => ({ stage, durationMs: 4, completed: true })),
        latencyMs: 47,
        otherProcessingMs: 47 - 4 * stages.length,
        attempts: knownUsage
          ? stages.map((stage) => ({
              attemptId: `${c.caseId}-${arm}-${stage}`,
              stage,
              start: {
                provider: stage === 'text' ? 'text' : 'jev',
                requestedModel:
                  stage === 'text' ? 'synthetic-text-alias' : publication.policy.modelAlias,
                requestHash: hashContext({ arm, stage, caseId: c.caseId }),
                ...(stage === 'text'
                  ? {}
                  : {
                      questionHash: hashContext(stage === 'pre' ? preQuestions() : auditQuestions())
                    })
              },
              result: {
                outcome: 'response',
                durationMs: 4,
                actualModel:
                  stage === 'text' ? 'synthetic-text-resolved' : publication.policy.modelResolved,
                usage: { inputTokens: 2, outputTokens: 3 },
                ...(stage === 'text' ? {} : { answers: (stage === 'pre' ? pre : post).answers })
              }
            }))
          : null,
        usage: knownUsage
          ? { inputTokens: stages.length * 2, outputTokens: stages.length * 3 }
          : null,
        usageSource: knownUsage ? 'recorded_http_attempts' : 'unknown',
        billedCostMicros: null
      }
    })
  )
  const options = {
    frozen,
    rawCases,
    artifacts,
    priorAnnotations: {
      annotatedBy: 'synthetic-prior-annotator',
      cases: rawCases.cases.map((c) => ({
        caseId: c.caseId,
        category: 'synthetic-faq',
        eligible: true,
        expectedHandoff: false,
        intentCount: 1
      }))
    },
    dataKind: 'synthetic' as const,
    rubricRef: 'synthetic-rubric-v1'
  }
  return options
}
function labels(packet: ReturnType<typeof createJevBlindReview>) {
  return {
    adjudicatedBy: 'synthetic-business-adjudicator',
    annotationSource: 'blinded_business_adjudication',
    labels: packet.blind.map((v) => ({
      reviewId: v.reviewId,
      substantialCorrection: v.draft === null ? null : false,
      severeFactError: false,
      unauthorizedPromise: false,
      incorrectlyBlocked: false,
      coveredIntents: v.draft === null ? 0 : 1
    }))
  }
}
function seal(packet: ReturnType<typeof createJevBlindReview>['privatePacket']) {
  const { packetHash, ...body } = packet
  void packetHash
  return { ...body, packetHash: hashContext(body) }
}
function calibrationFixture(knownUsage = true, split: 'calibration' | 'holdout' = 'calibration') {
  const f = fixture(knownUsage, split)
  f.frozen.publication.policy.mode = 'enforced'
  f.frozen.publication.policy.evaluationApproved = true
  f.frozen.publication.configuration.automaticEnabled = true
  f.frozen.snapshotHash = evaluationSnapshotHash(f.frozen.publication)
  for (const artifact of f.artifacts) artifact.snapshotHash = f.frozen.snapshotHash
  return f
}
const calibrationSettings = (f: ReturnType<typeof fixture>) => ({
  candidates: [f.frozen.publication.policy],
  targets: {
    maximumErrorReleaseRate: 0.01,
    minimumAutomaticCoverage: 0.5,
    minimumAutomaticReplies: 30
  }
})

describe('private Jev blind review and independent label import', () => {
  it('derives complete C observations and exact C reviewer labels without substituting A/B labels', () => {
    const f = calibrationFixture(),
      packet = createJevBlindReview(f),
      review = labels(packet)
    const c = packet.privatePacket.mapping.find(
      (m) => m.caseId === f.rawCases.cases[0].caseId && m.arm === 'C'
    )!
    review.labels.find((label) => label.reviewId === c.reviewId)!.substantialCorrection = true
    const prepared = prepareJevReplayCalibration(
      packet.privatePacket,
      f.artifacts,
      review,
      calibrationSettings(f)
    )
    expect(prepared.input.samples).toHaveLength(100)
    expect(prepared.input.adjudicatedBy).toBe(review.adjudicatedBy)
    expect(prepared.input.experimentSnapshotHash).toBe(f.frozen.snapshotHash)
    expect(prepared.input.samples[0]).toMatchObject({
      substantialCorrection: true,
      factsVerified: true,
      assessedIntents: ['faq'],
      explicitHumanRequest: false,
      deterministicPreconditionsPassed: true,
      pre: f.artifacts.find((a) => a.arm === 'C')!.pre
    })
    expect(prepared.adjudication.approvalSubmission).toBeNull()
    expect(prepared.adjudication.releaseAuthorized).toBe(false)
  })

  it('preserves unknown aggregate usage instead of filling zero while deriving independent observations', () => {
    const f = calibrationFixture(false),
      packet = createJevBlindReview(f)
    const prepared = prepareJevReplayCalibration(
      packet.privatePacket,
      f.artifacts,
      labels(packet),
      calibrationSettings(f)
    )
    expect(prepared.input.samples).toHaveLength(100)
    expect(prepared.adjudication).toMatchObject({
      status: 'usage_incomplete',
      dataset: null,
      billedCostMicros: null
    })
  })

  it('refuses the complete 200-case holdout split for threshold selection', () => {
    const f = calibrationFixture(true, 'holdout'),
      packet = createJevBlindReview(f)
    expect(f.rawCases.cases).toHaveLength(200)
    expect(() =>
      prepareJevReplayCalibration(
        packet.privatePacket,
        f.artifacts,
        labels(packet),
        calibrationSettings(f)
      )
    ).toThrow('calibration_split_required')
  })

  it('refuses settings that change automatic intent scope and missing original C assignments', () => {
    const f = calibrationFixture(),
      packet = createJevBlindReview(f),
      settings = calibrationSettings(f)
    settings.candidates = [{ ...settings.candidates[0], automaticIntents: ['faq', 'price'] }]
    expect(() =>
      prepareJevReplayCalibration(packet.privatePacket, f.artifacts, labels(packet), settings)
    ).toThrow('Only the six')
    expect(() =>
      prepareJevReplayCalibration(
        packet.privatePacket,
        f.artifacts.slice(1),
        labels(packet),
        calibrationSettings(f)
      )
    ).toThrow('artifacts_incomplete')
  })

  it('does not hide a nonhuman missing observation behind an inferred false prerequisite', () => {
    const f = calibrationFixture(),
      artifact = f.artifacts.find((a) => a.arm === 'C')!
    Object.assign(artifact, {
      status: 'handoff',
      wouldRelease: false,
      factsVerified: false,
      intents: [],
      draft: null,
      pre: null,
      post: null,
      stages: [],
      attempts: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      reasons: ['unknown_predecision']
    })
    const packet = createJevBlindReview(f)
    expect(() =>
      prepareJevReplayCalibration(
        packet.privatePacket,
        f.artifacts,
        labels(packet),
        calibrationSettings(f)
      )
    ).toThrow('Observed predecision required')
  })

  it('refuses contradictory C model observations even when a human-request packet is locally resealed consistently', () => {
    const f = calibrationFixture(),
      item = f.rawCases.cases[0]
    item.inbound = ['请转人工客服']
    f.frozen.plan.assignments.find((a) => a.caseId === item.caseId)!.inputHash =
      replayCaseInputHash(item)
    for (const artifact of f.artifacts) {
      artifact.executionPlanHash = hashContext(f.frozen.plan)
      if (artifact.caseId === item.caseId) artifact.inputHash = replayCaseInputHash(item)
    }
    const packet = createJevBlindReview(f)
    expect(() =>
      prepareJevReplayCalibration(
        packet.privatePacket,
        f.artifacts,
        labels(packet),
        calibrationSettings(f)
      )
    ).toThrow('calibration_human_observation_changed')
  })

  it('requires the private packet to match a fresh database freeze including actual dates and account identity', () => {
    const f = fixture(),
      packet = createJevBlindReview(f).privatePacket
    const current = structuredClone(f.frozen)
    current.serverNow = new Date(20000)
    expect(() => assertJevBlindReviewFreeze(current, packet)).not.toThrow()
    for (const change of ['date', 'employee', 'plan', 'run'] as const) {
      const changed = structuredClone(current)
      if (change === 'date') changed.createdAt = new Date(2000)
      if (change === 'employee') changed.authenticatedScope.employeeId = 'different-employee'
      if (change === 'plan') changed.plan.assignments[299].inputHash = 'f'.repeat(64)
      if (change === 'run') changed.runId = 'other-run'
      expect(() => assertJevBlindReviewFreeze(changed, packet)).toThrow('database_freeze_mismatch')
    }
    current.serverNow = new Date(current.expiresAt)
    expect(() => assertJevBlindReviewFreeze(current, packet)).toThrow(
      'evaluation_run_expired_or_invalid'
    )
  })

  it('does not let a resealed private file establish future server time or replace the authenticated freeze', () => {
    const f = fixture(),
      original = createJevBlindReview(f).privatePacket
    const future = structuredClone(original)
    future.frozen.serverNow = new Date(20000).toISOString()
    expect(() => assertJevBlindReviewFreeze(f.frozen, seal(future))).toThrow(
      'packet_server_time_in_future'
    )
    const changed = structuredClone(original)
    changed.frozen.createdAt = new Date(2000).toISOString()
    expect(() => assertJevBlindReviewFreeze(f.frozen, seal(changed))).toThrow(
      'database_freeze_mismatch'
    )
  })

  it('uses opaque randomized reviews hiding all arm, gate and provider metadata', () => {
    const options = fixture(),
      p = createJevBlindReview(options),
      q = createJevBlindReview(options)
    expect(p.blind).toHaveLength(300)
    expect(new Set(p.blind.map((r) => r.reviewId)).size).toBe(300)
    expect(p.blind.every((r) => /^[a-f0-9-]{36}$/.test(r.reviewId))).toBe(true)
    expect(p.blind.map((r) => r.reviewId)).not.toEqual(
      p.privatePacket.mapping.map((m) => m.reviewId)
    )
    expect(p.blind.map((r) => r.reviewId)).not.toEqual(q.blind.map((r) => r.reviewId))
    for (const r of p.blind) {
      expect(Object.keys(r).sort()).toEqual(['context', 'draft', 'inbound', 'reviewId'])
      const m = p.privatePacket.mapping.find((m) => m.reviewId === r.reviewId)!
      expect(r.draft).toBe(
        options.artifacts.find((a) => a.assignmentId === m.assignmentId)!.draft!.text
      )
    }
  })
  it('imports only quality labels and preserves actual projections, tokens and latency', () => {
    const f = fixture(),
      p = createJevBlindReview(f),
      l = labels(p)
    const review = p.privatePacket.mapping.find((m) => m.arm === 'C')!
    l.labels.find((l) => l.reviewId === review.reviewId)!.substantialCorrection = true
    const result = importJevBlindLabels(JSON.parse(JSON.stringify(p.privatePacket)), f.artifacts, l)
    expect(result.status).toBe('dataset_ready_cost_unknown')
    expect(result.dataset!.cases[0].outcomes.find((o) => o.arm === 'C')).toMatchObject({
      automatic: true,
      inputTokens: 6,
      outputTokens: 9,
      latencyMs: 47,
      substantialCorrection: true
    })
    expect(result.dataset!.cases[0].outcomes.find((o) => o.arm === 'B')!.automatic).toBe(false)
    expect(result).toMatchObject({
      billedCostMicros: null,
      releaseAuthorized: false,
      approvalSubmission: null
    })
    expect(result.limitations.join(' ')).toContain('Synthetic data')
  })
  it('keeps unknown usage null and refuses to manufacture a computable token dataset', () => {
    const f = fixture(false),
      p = createJevBlindReview(f)
    const r = importJevBlindLabels(p.privatePacket, f.artifacts, labels(p))
    expect(r).toMatchObject({
      status: 'usage_incomplete',
      dataset: null,
      billedCostMicros: null,
      approvalSubmission: null
    })
    expect(r.cases[0].outcomes[0]).toMatchObject({ inputTokens: null, outputTokens: null })
    const completedWithoutUsage = fixture()
    delete completedWithoutUsage.artifacts[0].attempts![0].result!.usage
    completedWithoutUsage.artifacts[0].usage = null
    completedWithoutUsage.artifacts[0].usageSource = 'unknown'
    const q = createJevBlindReview(completedWithoutUsage)
    expect(
      importJevBlindLabels(q.privatePacket, completedWithoutUsage.artifacts, labels(q)).dataset
    ).toBeNull()
    completedWithoutUsage.artifacts[0].attempts![0].result = null
    expect(() => createJevBlindReview(completedWithoutUsage)).toThrow('Replay attempt incomplete')
  })
  it.each([
    'missing',
    'duplicate-arm',
    'duplicate-assignment',
    'cross-case',
    'cross-run',
    'input-hash',
    'snapshot',
    'plan',
    'invalid',
    'cancelled'
  ])('rejects incomplete or unbound artifact set: %s', (kind) => {
    const f = fixture()
    if (kind === 'missing') f.artifacts.pop()
    if (kind === 'duplicate-arm') f.artifacts[1].arm = 'A'
    if (kind === 'duplicate-assignment') f.artifacts[1].assignmentId = f.artifacts[0].assignmentId
    if (kind === 'cross-case') f.artifacts[0].caseId = 'case-299'
    if (kind === 'cross-run') f.artifacts[0].runId = 'other-run'
    if (kind === 'input-hash') f.artifacts[0].inputHash = '0'.repeat(64)
    if (kind === 'snapshot') f.artifacts[0].snapshotHash = '0'.repeat(64)
    if (kind === 'plan') f.artifacts[0].executionPlanHash = '0'.repeat(64)
    if (kind === 'invalid' || kind === 'cancelled') f.artifacts[0].status = kind
    expect(() => createJevBlindReview(f)).toThrow()
  })
  it('requires all planned case inputs and separate complete unique case priors', () => {
    const f = fixture()
    f.priorAnnotations.cases.pop()
    expect(() => createJevBlindReview(f)).toThrow('prior_annotations')
    const g = fixture()
    g.rawCases.cases[0].inbound = ['changed input']
    expect(() => createJevBlindReview(g)).toThrow('replay_case_changed')
  })
  it.each(['draft', 'release', 'latency', 'tokens'])(
    'detects original artifact tampering: %s',
    (kind) => {
      const f = fixture(),
        p = createJevBlindReview(f)
      if (kind === 'draft') {
        f.artifacts[0].draft!.text = 'changed draft'
        f.artifacts[0].draft!.draftHash = hashDraft('changed draft')
      }
      if (kind === 'release') f.artifacts[0].wouldRelease = false
      if (kind === 'latency') f.artifacts[0].latencyMs++
      if (kind === 'tokens') {
        f.artifacts[0].usage!.inputTokens++
        f.artifacts[0].attempts![0].result!.usage!.inputTokens++
      }
      expect(() => importJevBlindLabels(p.privatePacket, f.artifacts, labels(p))).toThrow(
        'review_mapping_changed'
      )
    }
  )
  it('detects packet changes, including serialized freeze dates', () => {
    const f = fixture(),
      p = createJevBlindReview(f)
    p.privatePacket.frozen.serverNow = new Date(11000).toISOString()
    expect(() => importJevBlindLabels(p.privatePacket, f.artifacts, labels(p))).toThrow(
      'private_packet_changed'
    )
  })
  it('rejects rehashed duplicate or cross-case mapping', () => {
    const f = fixture(),
      p = createJevBlindReview(f)
    p.privatePacket.mapping[0].caseId = 'case-1'
    expect(() => importJevBlindLabels(seal(p.privatePacket), f.artifacts, labels(p))).toThrow(
      'review_mapping_changed'
    )
    const q = createJevBlindReview(f)
    q.privatePacket.mapping[0].reviewId = q.privatePacket.mapping[1].reviewId
    expect(() => importJevBlindLabels(seal(q.privatePacket), f.artifacts, labels(q))).toThrow(
      'review_mapping_changed'
    )
  })
  it.each(['missing', 'duplicate', 'unknown'])(
    'rejects incomplete label identity set: %s',
    (kind) => {
      const f = fixture(),
        p = createJevBlindReview(f),
        l = labels(p)
      if (kind === 'missing') l.labels.pop()
      if (kind === 'duplicate') l.labels[0].reviewId = l.labels[1].reviewId
      if (kind === 'unknown') l.labels[0].reviewId = '00000000-0000-4000-8000-000000000000'
      expect(() => importJevBlindLabels(p.privatePacket, f.artifacts, l)).toThrow(
        'blind_labels_incomplete_or_unknown'
      )
    }
  )
  it.each(['automatic', 'draft', 'latencyMs', 'inputTokens', 'caseId', 'arm', 'modelScore'])(
    'refuses label override field: %s',
    (key) => {
      const f = fixture(),
        p = createJevBlindReview(f),
        l = labels(p)
      Object.assign(l.labels[0], { [key]: true })
      expect(() => importJevBlindLabels(p.privatePacket, f.artifacts, l)).toThrow()
    }
  )
  it('rejects unknown private packet, artifact and nested provider fields', () => {
    const f = fixture(),
      p = createJevBlindReview(f)
    expect(() =>
      importJevBlindLabels({ ...p.privatePacket, unknown: 1 }, f.artifacts, labels(p))
    ).toThrow()
    Object.assign(f.artifacts[0], { unknown: 1 })
    expect(() => createJevBlindReview(f)).toThrow()
    const g = fixture()
    Object.assign(g.artifacts[1].pre!.answers.human_requested, { modelScore: 1 })
    expect(() => createJevBlindReview(g)).toThrow()
  })
  it('rejects dishonest totals and incomplete stage accounting', () => {
    const f = fixture()
    f.artifacts[2].attempts = f.artifacts[2].attempts!.filter((a) => a.stage === 'text')
    f.artifacts[2].usage = { inputTokens: 2, outputTokens: 3 }
    expect(() => createJevBlindReview(f)).toThrow('Usage ledger incomplete')
    const g = fixture()
    g.artifacts[0].usage!.inputTokens++
    expect(() => createJevBlindReview(g)).toThrow('Usage total changed')
    const h = fixture()
    h.artifacts[0].stages[0].completed = false
    expect(() => createJevBlindReview(h)).toThrow('Replay stage incomplete')
  })
  it('supports actual absent reply without fabricated error claims', () => {
    const f = fixture(false)
    Object.assign(f.artifacts[0], {
      draft: null,
      status: 'handoff',
      wouldRelease: false,
      factsVerified: false
    })
    const p = createJevBlindReview(f),
      l = labels(p)
    const m = p.privatePacket.mapping.find((m) => m.assignmentId === f.artifacts[0].assignmentId)!
    const label = l.labels.find((l) => l.reviewId === m.reviewId)!
    expect(
      importJevBlindLabels(p.privatePacket, f.artifacts, l).cases[0].outcomes[0]
    ).toMatchObject({ suggested: false, substantialCorrection: null })
    label.severeFactError = true
    expect(() => importJevBlindLabels(p.privatePacket, f.artifacts, l)).toThrow(
      'blind_label_contradicts'
    )
  })
  it('rejects quality labels inconsistent with fixed independent intent count', () => {
    const f = fixture(),
      p = createJevBlindReview(f),
      l = labels(p)
    l.labels[0].coveredIntents = 2
    expect(() => importJevBlindLabels(p.privatePacket, f.artifacts, l)).toThrow(
      'blind_label_contradicts'
    )
    l.labels[0].coveredIntents = 1
    l.labels[0].severeFactError = true
    expect(() => importJevBlindLabels(p.privatePacket, f.artifacts, l)).toThrow(
      'blind_label_contradicts'
    )
  })
  it.each(['pre-questions', 'post-questions', 'pre-model', 'post-model'])(
    'rejects a response that disagrees with frozen Jev questions/model: %s',
    (kind) => {
      const f = fixture(false)
      const a = f.artifacts[2]
      if (kind === 'pre-questions') a.pre!.answers = { synthetic: { type: 'noul', noul: 1 } }
      if (kind === 'post-questions') a.post!.answers = a.pre!.answers
      if (kind === 'pre-model') a.pre!.model = 'other-jev-model'
      if (kind === 'post-model') a.post!.model = 'other-jev-model'
      expect(() => createJevBlindReview(f)).toThrow()
    }
  )
  it.each([
    'A-pre',
    'A-jev-stage',
    'B-post',
    'C-missing-post',
    'C-stage-order',
    'attempt-provider',
    'attempt-alias',
    'attempt-model',
    'attempt-question-hash',
    'text-model-drift'
  ])('rejects arm-stage and attempt binding inconsistency: %s', (kind) => {
    const f = fixture(
      !kind.includes('-stage') && !['A-pre', 'B-post', 'C-missing-post'].includes(kind)
    )
    if (kind === 'A-pre') f.artifacts[0].pre = syntheticResponse(preQuestions())
    if (kind === 'A-jev-stage')
      f.artifacts[0].stages = [
        { stage: 'pre', durationMs: 4, completed: true },
        ...f.artifacts[0].stages
      ]
    if (kind === 'B-post') {
      f.artifacts[1].post = syntheticResponse(auditQuestions())
      f.artifacts[1].stages.push({ stage: 'post', durationMs: 4, completed: true })
    }
    if (kind === 'C-missing-post') {
      f.artifacts[2].post = null
      f.artifacts[2].stages.pop()
    }
    if (kind === 'C-stage-order') f.artifacts[2].stages.reverse()
    const attempt = f.artifacts[2].attempts?.[0]
    if (kind === 'attempt-provider') attempt!.start.provider = 'text'
    if (kind === 'attempt-alias') attempt!.start.requestedModel = 'other-jev-alias'
    if (kind === 'attempt-model') attempt!.result!.actualModel = 'other-jev-model'
    if (kind === 'attempt-question-hash')
      attempt!.start.questionHash = hashContext(auditQuestions())
    if (kind === 'text-model-drift')
      f.artifacts[0].attempts![0].result!.actualModel = 'other-text-model'
    expect(() => createJevBlindReview(f)).toThrow()
  })
})
