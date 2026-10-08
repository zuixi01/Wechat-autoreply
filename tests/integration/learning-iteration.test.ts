import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LearningStore } from '../../src/core/memory/learning-store'
import { LearningService } from '../../src/main/services/learning-service'
import { LearningValidator, validationDatasetHash } from '../../src/core/memory/learning-validation'
import { memorySemanticUnits } from '../../src/core/memory/learning-risk'
import { retrieveLearningContext } from '../../src/core/memory/learning-context'
import type {
  LearningValidationCase,
  MemoryRevision
} from '../../src/shared/contracts/learning-memory'

const scope = { workspaceId: 'profile', platform: 'generic' as const, conversationId: 'customer' }
const stores: LearningStore[] = [],
  directories: string[] = []
afterEach(() => {
  stores.splice(0).forEach((store) => store.close())
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }))
})
const calibration: LearningValidationCase[] = Array.from({ length: 5 }, (_, i) => ({
  caseId: `synthetic-${i}`,
  conversationId: `calibration-${i}`,
  input: '设备询价',
  expectedMethod: '确认型号和数量',
  requiredTerms: ['型号', '数量'],
  forbiddenClaims: ['保证退款'],
  humanLabelled: true,
  labelOrigin: 'human' as const // Simulated human declaration for engineering tests only.
}))
const dependencies = {
  replay: async () => ({ text: '请告知型号和采购数量。', covered: true, severeErrors: [] }),
  assessRisk: async (revision: MemoryRevision) => ({
    contentHash: revision.contentHash,
    units: memorySemanticUnits(revision.content).map((unit) => ({
      path: unit.path,
      category: 'method' as const,
      reason: '流程而非业务事实'
    }))
  })
}
function setup(path = ':memory:') {
  let now = 1000
  const store = new LearningStore(path, () => now)
  stores.push(store)
  store.validation.setEnvironment(scope, {
    knowledgeVersion: 'k1',
    policyVersion: 'p1',
    validatorVersion: 'v1',
    datasetHash: validationDatasetHash(calibration)
  })
  const evidence = store.recordEpisode(scope, {
    sourceId: 'employee',
    topic: '设备询价',
    startedAt: 1000,
    correction: '核对型号数量',
    messages: [],
    outcome: 'corrected'
  })
  const memory = store.propose(scope, {
    source: 'human',
    reason: '初始方法',
    evidence: [{ episodeId: evidence.id }],
    content: {
      kind: 'lesson',
      scenario: '设备询价',
      guidance: '询问型号',
      rationale: '',
      steps: [],
      pitfalls: [],
      verification: []
    }
  })
  store.activate(scope, memory.id, 1)
  const service = new LearningService(
    store,
    { review: async () => ({ operations: [], usage: { inputTokens: 1, outputTokens: 1 } }) },
    {
      workspaceId: 'profile',
      now: () => now,
      validation: {
        ...dependencies,
        dataset: async () => ({
          cases: calibration,
          knowledgeVersion: 'k1',
          policyVersion: 'p1',
          validatorVersion: 'v1'
        })
      }
    }
  )
  const revise = () =>
    store.revise(scope, memory.id, store.get(scope, memory.id).currentRevision, {
      source: 'review',
      reason: '员工纠正要求一次问全',
      evidence: [{ episodeId: evidence.id }],
      content: { ...memory.content, guidance: '同时询问型号和数量' }
    })
  const validate = (revision: number) =>
    new LearningValidator(store, dependencies).validate(
      {
        scope,
        memoryId: memory.id,
        revision,
        cases: calibration,
        knowledgeVersion: 'k1',
        policyVersion: 'p1'
      },
      new AbortController().signal
    )
  return {
    store,
    memory,
    evidence,
    service,
    revise,
    validate,
    advance: (ms: number) => {
      now += ms
    }
  }
}
describe('immutable versions and exact validation activation', () => {
  it('keeps V1 active while V2 awaits calibration, publishes verified V2, records real use and rolls back as V3', async () => {
    const { store, memory, service, revise } = setup()
    const v2 = revise()
    expect(store.active(scope)[0]).toMatchObject({
      activeRevision: 1,
      content: { guidance: '询问型号' }
    })
    store.settings(scope, { mode: 'auto' })
    expect(await service.validateCandidate(scope, memory.id, 2)).toMatchObject({
      status: 'passed',
      activated: true
    })
    expect(store.active(scope)[0]).toMatchObject({
      activeRevision: 2,
      content: { guidance: v2.content.guidance }
    })
    const context = retrieveLearningContext(store, scope, '设备询价')
    const generated = service.onDraft(
      { screenshot: '', appType: 'generic', extractedText: '设备询价', learningGenerationId: 'g1' },
      context,
      '请问型号数量？',
      scope
    )
    service.humanFeedback(scope, generated.id, {
      sourceId: 'employee-adopts',
      kind: 'adopted',
      reason: '员工确认采用了核对方法'
    })
    expect(store.metrics(scope, memory.id)).toMatchObject({ loaded: 1, adopted: 1 })
    const restored = store.rollback(scope, memory.id, 2, 1)
    expect(restored).toMatchObject({
      currentRevision: 3,
      activeRevision: 3,
      content: { guidance: '询问型号' }
    })
    expect(store.history(scope, memory.id)).toHaveLength(3)
  })
  it('suggest validates without publishing and off does not replay', async () => {
    const { store, memory, service, revise } = setup()
    revise()
    expect(await service.validateCandidate(scope, memory.id, 2)).toMatchObject({
      status: 'passed',
      activated: false
    })
    expect(store.active(scope)[0].activeRevision).toBe(1)
    store.settings(scope, { mode: 'off' })
    expect(await service.validateCandidate(scope, memory.id, 2)).toMatchObject({
      status: 'failed',
      reasons: ['learning_disabled']
    })
  })
  it.each(['knowledgeVersion', 'policyVersion', 'validatorVersion', 'datasetHash'] as const)(
    'invalidates a grant after bound %s changes, even if it later changes back',
    async (field) => {
      const { store, memory, revise, validate } = setup()
      revise()
      store.settings(scope, { mode: 'auto' })
      const result = await validate(2)
      const original = {
        knowledgeVersion: 'k1',
        policyVersion: 'p1',
        validatorVersion: 'v1',
        datasetHash: validationDatasetHash(calibration)
      }
      store.validation.setEnvironment(scope, {
        ...original,
        [field]: field === 'datasetHash' ? 'a'.repeat(64) : 'changed'
      })
      store.validation.setEnvironment(scope, original)
      expect(() => store.activateValidated(scope, memory.id, 2, result.grantId!)).toThrow(
        'validation_environment_changed'
      )
      expect(store.active(scope)[0].activeRevision).toBe(1)
    }
  )
  it('a grant survives disk reopening but cannot cross scope, change revision or be reused', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'learning-grant-'))
    directories.push(directory)
    const path = join(directory, 'memory.sqlite'),
      original = setup(path)
    original.revise()
    original.store.settings(scope, { mode: 'auto' })
    const result = await original.validate(2)
    original.store.close()
    const store = new LearningStore(path, () => 1000)
    stores.push(store)
    expect(() =>
      store.activateValidated(
        { ...scope, conversationId: 'other' },
        original.memory.id,
        2,
        result.grantId!
      )
    ).toThrow('validation_grant_missing')
    expect(() => store.activateValidated(scope, original.memory.id, 1, result.grantId!)).toThrow(
      'validation_grant_mismatch'
    )
    expect(
      store.activateValidated(scope, original.memory.id, 2, result.grantId!).activeRevision
    ).toBe(2)
    expect(() => store.activateValidated(scope, original.memory.id, 2, result.grantId!)).toThrow(
      'validation_grant_used'
    )
  })
  it('forgotten or expired evidence cannot activate a previously passing grant', async () => {
    const { store, memory, revise, validate } = setup()
    revise()
    store.settings(scope, { mode: 'auto' })
    const result = await validate(2)
    store.forgetScope(scope)
    expect(() => store.activateValidated(scope, memory.id, 2, result.grantId!)).toThrow(
      'validation_grant_missing'
    )
  })
  it('source retention invalidates a still-unexpired grant before maintenance has run', async () => {
    const { store, memory, revise, validate, advance } = setup()
    revise()
    store.settings(scope, { mode: 'auto' })
    advance(89.75 * 86400000)
    const result = await validate(2)
    expect(result.status).toBe('passed')
    advance(0.5 * 86400000)
    expect(() => store.activateValidated(scope, memory.id, 2, result.grantId!)).toThrow(
      'evidence_expired'
    )
    expect(store.get(scope, memory.id).activeRevision).toBe(1)
  })
  it('the employee can blame only a selected loaded method; another loaded method remains active', () => {
    const { store, memory, service, evidence } = setup()
    const other = store.propose(scope, {
      source: 'human',
      reason: '另一方法',
      evidence: [{ episodeId: evidence.id }],
      content: { ...memory.content, guidance: '友好礼貌确认需求' }
    })
    store.activate(scope, other.id, 1)
    const generation = service.onDraft(
      {
        screenshot: '',
        appType: 'generic',
        extractedText: '设备询价',
        learningGenerationId: 'many'
      },
      retrieveLearningContext(store, scope, '设备询价'),
      '草稿',
      scope
    )
    service.humanFeedback(scope, generation.id, {
      sourceId: 'one-error',
      kind: 'fact_error',
      memoryId: memory.id,
      reason: '此方法导致错误'
    })
    expect(store.get(scope, memory.id).state).toBe('stale')
    expect(store.get(scope, other.id).state).toBe('active')
    expect(() =>
      service.humanFeedback(scope, generation.id, {
        sourceId: 'fake-error',
        kind: 'fact_error',
        memoryId: 'never-loaded',
        reason: '无据归因'
      })
    ).toThrow('feedback_usage_mismatch')
  })
  it('quarantines the exact used revision after a trusted severe error without disabling a newer active revision', () => {
    const { store, service, memory, revise } = setup()
    const oldEpisode = service.onDraft(
      {
        screenshot: '',
        appType: 'generic',
        extractedText: '设备询价',
        learningGenerationId: 'g-old'
      },
      retrieveLearningContext(store, scope, '设备询价'),
      '旧回复',
      scope
    )
    revise()
    store.activate(scope, memory.id, 2)
    const feedback = {
      sourceId: 'old-error',
      kind: 'fact_error' as const,
      reason: 'V1方法造成无据业务事实'
    }
    service.humanFeedback(scope, oldEpisode.id, feedback)
    service.humanFeedback(scope, oldEpisode.id, feedback)
    expect(store.get(scope, memory.id)).toMatchObject({ state: 'active', activeRevision: 2 })
    expect(
      store.history(scope, memory.id).find((entry) => entry.revision === 1)?.quarantinedAt
    ).toBe(1000)
    expect(() => store.rollback(scope, memory.id, 2, 1)).toThrow('memory_revision_quarantined')
    const current = service.onDraft(
      {
        screenshot: '',
        appType: 'generic',
        extractedText: '设备询价',
        learningGenerationId: 'g-new'
      },
      retrieveLearningContext(store, scope, '设备询价'),
      '新回复',
      scope
    )
    service.humanFeedback(scope, current.id, {
      sourceId: 'new-error',
      kind: 'improper_commitment',
      reason: 'V2导致违规承诺'
    })
    expect(store.get(scope, memory.id).state).toBe('stale')
    expect(store.active(scope)).toEqual([])
    store.archive(scope, memory.id, 2, 'human')
    store.restore(scope, memory.id, 2)
    expect(store.get(scope, memory.id).state).toBe('stale')
    expect(() => store.activate(scope, memory.id, 2)).toThrow('memory_revision_quarantined')
    expect(store.jobs.list(scope)[0].triggers).toContain('severe_error')
  })
})
