import { afterEach, describe, expect, it, vi } from 'vitest'
import { LearningStore } from '../../src/core/memory/learning-store'
import { LearningValidator, validationDatasetHash } from '../../src/core/memory/learning-validation'
import { memorySemanticUnits } from '../../src/core/memory/learning-risk'
import type {
  LearningValidationCase,
  MemoryRevision
} from '../../src/shared/contracts/learning-memory'

const scope = { workspaceId: 'profile', platform: 'generic' as const, conversationId: 'training' }
const stores: LearningStore[] = []
afterEach(() => stores.splice(0).forEach((store) => store.close()))
const cases = (): LearningValidationCase[] =>
  Array.from({ length: 5 }, (_, index) => ({
    caseId: `calibration-${index}`,
    conversationId: `independent-${index}`,
    input: '客户要求报价',
    expectedMethod: '询问型号和数量',
    requiredTerms: ['型号', '数量'],
    forbiddenClaims: ['保证退款', '一律100元'],
    humanLabelled: true,
    labelOrigin: 'human' as const // Simulated human declaration for engineering tests only.
  }))
const semantic = async (revision: MemoryRevision) => ({
  contentHash: revision.contentHash,
  units: memorySemanticUnits(revision.content).map((unit) => ({
    path: unit.path,
    category: 'method' as const,
    reason: '仅描述核对需求的步骤'
  }))
})
function setup() {
  let now = 1000
  const store = new LearningStore(':memory:', () => now)
  stores.push(store)
  const episode = store.recordEpisode(scope, {
    sourceId: 'correction',
    identityStatus: 'verified',
    topic: '报价前确认需求',
    startedAt: 1000,
    messages: [],
    correction: '先问型号和数量',
    outcome: 'corrected'
  })
  const memory = store.propose(scope, {
    source: 'review',
    reason: '员工纠正',
    evidence: [{ episodeId: episode.id }],
    content: {
      kind: 'skill',
      scenario: '报价前确认需求',
      guidance: '先询问型号和数量，再查询有效资料',
      rationale: '',
      steps: ['询问型号和数量'],
      pitfalls: ['不要猜价格'],
      verification: ['需求已完整']
    }
  })
  const data = cases()
  store.validation.setEnvironment(scope, {
    knowledgeVersion: 'knowledge-1',
    policyVersion: 'policy-1',
    validatorVersion: 'validator-1',
    datasetHash: validationDatasetHash(data)
  })
  const replay = vi.fn(async () => ({
    text: '请问具体型号和采购数量？',
    covered: true,
    severeErrors: [] as string[]
  }))
  const validator = new LearningValidator(store, { replay, assessRisk: semantic })
  const input = {
    scope,
    memoryId: memory.id,
    revision: 1,
    cases: data,
    knowledgeVersion: 'knowledge-1',
    policyVersion: 'policy-1'
  }
  return {
    store,
    memory,
    validator,
    input,
    replay,
    advance: (value: number) => {
      now += value
    }
  }
}
describe('source-backed behaviour validation', () => {
  it('never replays or grants from synthetic, model or legacy unspecified label origins', async () => {
    const { validator, input, replay, store, memory } = setup()
    for (const labelOrigin of ['synthetic', 'model', undefined] as const) {
      expect(
        await validator.validate(
          {
            ...input,
            cases: input.cases.map((entry) => ({ ...entry, humanLabelled: true, labelOrigin }))
          },
          new AbortController().signal
        )
      ).toMatchObject({ status: 'insufficient', reasons: ['independent_human_cases_required'] })
    }
    expect(replay).not.toHaveBeenCalled()
    expect(store.get(scope, memory.id).activeRevision).toBeNull()
  })
  it('returns insufficient without human labels or five independent conversations and never calls a model', async () => {
    const { validator, input, replay } = setup()
    for (const data of [
      [],
      input.cases.map((item) => ({ ...item, humanLabelled: false })),
      input.cases.map((item) => ({ ...item, conversationId: 'one-conversation' }))
    ]) {
      expect(
        await validator.validate({ ...input, cases: data }, new AbortController().signal)
      ).toMatchObject({ status: 'insufficient' })
    }
    expect(replay).not.toHaveBeenCalled()
  })
  it('replays independently without publishing the temporary candidate, and issues a persisted grant', async () => {
    const { store, memory, validator, input, replay } = setup()
    replay.mockImplementation(async () => {
      expect(store.active(scope)).toEqual([])
      return { text: '请提供型号及数量', covered: false, severeErrors: [] }
    })
    const result = await validator.validate(input, new AbortController().signal)
    expect(result.status).toBe('passed')
    expect(replay).toHaveBeenCalledTimes(10)
    expect(store.validation.grant(scope, result.grantId!)).toMatchObject({
      memoryId: memory.id,
      revision: 1,
      result: 'passed',
      knowledgeVersion: 'knowledge-1',
      policyVersion: 'policy-1'
    })
    expect(store.get(scope, memory.id).state).toBe('pending')
  })
  it('does not trust a model-reported covered flag when the human required terms are missing', async () => {
    const { validator, input, replay } = setup()
    replay.mockResolvedValue({ text: '已为您处理完毕。', covered: true, severeErrors: [] })
    expect(await validator.validate(input, new AbortController().signal)).toMatchObject({
      status: 'failed',
      reasons: expect.arrayContaining(['candidate_coverage_missing'])
    })
  })
  it('fails forbidden claims or severe errors even when coverage is present', async () => {
    const { validator, input, replay } = setup()
    replay.mockResolvedValue({
      text: '请提供型号和数量，保证退款',
      covered: true,
      severeErrors: []
    })
    expect(await validator.validate(input, new AbortController().signal)).toMatchObject({
      status: 'failed'
    })
    replay.mockResolvedValue({
      text: '请提供型号和数量',
      covered: true,
      severeErrors: ['unsupported_fact']
    })
    expect(await validator.validate(input, new AbortController().signal)).toMatchObject({
      status: 'failed'
    })
  })
  it('rejects semantic fact/authority changes that a keyword-only filter would miss', async () => {
    const { store, input, replay } = setup()
    const validator = new LearningValidator(store, {
      replay,
      assessRisk: async (revision) => ({
        contentHash: revision.contentHash,
        units: memorySemanticUnits(revision.content).map((unit) => ({
          path: unit.path,
          category: unit.path === 'guidance' ? 'authority_change' : 'method',
          reason: '更改业务权限'
        }))
      })
    })
    expect(await validator.validate(input, new AbortController().signal)).toMatchObject({
      status: 'failed',
      reasons: expect.arrayContaining(['memory_authority_change'])
    })
    expect(replay).not.toHaveBeenCalled()
  })
  it('stays insufficient if semantic coverage is missing or a preference needs human confirmation', async () => {
    const { store, memory, input, replay } = setup()
    const partial = new LearningValidator(store, {
      replay,
      assessRisk: async (revision) => ({ contentHash: revision.contentHash, units: [] })
    })
    expect(await partial.validate(input, new AbortController().signal)).toMatchObject({
      status: 'insufficient'
    })
    store.revise(scope, memory.id, 1, {
      evidence: store.history(scope, memory.id)[0].evidence,
      reason: '客户偏好',
      source: 'review',
      content: { ...memory.content, kind: 'preference' }
    })
    const preferences = new LearningValidator(store, { replay, assessRisk: semantic })
    expect(
      await preferences.validate({ ...input, revision: 2 }, new AbortController().signal)
    ).toMatchObject({
      status: 'insufficient',
      reasons: expect.arrayContaining(['preference_requires_human'])
    })
  })
  it('refuses stale knowledge, policy, dataset, content or source after an in-flight replay', async () => {
    const { store, memory, validator, input, replay } = setup()
    replay.mockImplementation(async () => {
      store.validation.setEnvironment(scope, {
        knowledgeVersion: 'knowledge-2',
        policyVersion: 'policy-1',
        validatorVersion: 'validator-1',
        datasetHash: validationDatasetHash(input.cases)
      })
      return { text: '请提供型号和数量', covered: true, severeErrors: [] }
    })
    expect(await validator.validate(input, new AbortController().signal)).toMatchObject({
      status: 'failed',
      reasons: expect.arrayContaining(['validation_environment_changed'])
    })
    expect(store.get(scope, memory.id).state).toBe('pending')
  })
  it('rejects training evidence reused as independent calibration and cancelled late responses', async () => {
    const { validator, input, replay } = setup()
    expect(
      await validator.validate(
        {
          ...input,
          cases: input.cases.map((item) => ({ ...item, conversationId: scope.conversationId }))
        },
        new AbortController().signal
      )
    ).toMatchObject({ status: 'insufficient' })
    const controller = new AbortController()
    replay.mockImplementation(async () => {
      controller.abort()
      return { text: '型号数量', covered: true, severeErrors: [] }
    })
    expect(await validator.validate(input, controller.signal)).toMatchObject({
      status: 'failed',
      reasons: expect.arrayContaining(['validation_cancelled'])
    })
  })
  it('auto activation requires the exact unexpired grant and current bound environment', async () => {
    const { store, memory, validator, input, advance } = setup()
    const result = await validator.validate(input, new AbortController().signal)
    expect(() => store.activateValidated(scope, memory.id, 1, 'forged')).toThrow(
      'validation_grant_missing'
    )
    expect(() => store.activateValidated(scope, memory.id, 1, result.grantId!)).toThrow(
      'automatic_activation_disabled'
    )
    store.settings(scope, { mode: 'auto' })
    advance(86400000)
    expect(() => store.activateValidated(scope, memory.id, 1, result.grantId!)).toThrow(
      'validation_grant_expired'
    )
  })
})
