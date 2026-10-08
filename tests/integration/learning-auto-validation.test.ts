import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LearningStore } from '../../src/core/memory/learning-store'
import { LearningService } from '../../src/main/services/learning-service'
import { memorySemanticUnits } from '../../src/core/memory/learning-risk'
import type {
  LearningValidationCase,
  MemoryRevision
} from '../../src/shared/contracts/learning-memory'

const scope = { workspaceId: 'profile', platform: 'generic' as const }
const stores: LearningStore[] = [],
  directories: string[] = []
afterEach(() => {
  stores.splice(0).forEach((store) => store.close())
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }))
})
const cases: LearningValidationCase[] = Array.from({ length: 5 }, (_, i) => ({
  caseId: `synthetic-${i}`,
  conversationId: `cal-${i}`,
  input: '设备询价',
  expectedMethod: '型号数量',
  requiredTerms: ['型号', '数量'],
  forbiddenClaims: [],
  humanLabelled: true,
  labelOrigin: 'human' as const // Simulated human declaration for engineering tests only.
}))
const semantic = (revision: MemoryRevision) => ({
  contentHash: revision.contentHash,
  units: memorySemanticUnits(revision.content).map((unit) => ({
    path: unit.path,
    category: 'method' as const,
    reason: '仅核对需求'
  }))
})
function setup(path = ':memory:') {
  let now = 1000,
    knowledge = 'k1',
    data = cases,
    calls = 0
  const store = new LearningStore(path, () => now)
  stores.push(store)
  store.settings(scope, { mode: 'auto', idleDelayMs: 1000 })
  const evidence = store.recordEpisode(scope, {
    sourceId: 'employee',
    topic: '设备询价',
    startedAt: 1000,
    messages: [],
    correction: '一次问全型号数量',
    outcome: 'corrected'
  })
  const memory = store.propose(scope, {
    source: 'review',
    reason: '员工纠正',
    evidence: [{ episodeId: evidence.id }],
    content: {
      kind: 'lesson',
      scenario: '设备询价',
      guidance: '核对型号和数量',
      rationale: '',
      steps: [],
      pitfalls: [],
      verification: []
    }
  })
  const options = {
    workspaceId: 'profile',
    now: () => now,
    validation: {
      dataset: async () => ({
        cases: data,
        knowledgeVersion: knowledge,
        policyVersion: 'p1',
        validatorVersion: 'v1'
      }),
      assessRisk: async (revision: MemoryRevision) => semantic(revision),
      replay: async () => {
        calls++
        return { text: '请告知型号和数量', covered: true, severeErrors: [] }
      }
    }
  }
  const service = new LearningService(
    store,
    { review: async () => ({ operations: [], usage: { inputTokens: 0, outputTokens: 0 } }) },
    options
  )
  return {
    store,
    memory,
    service,
    options,
    advance: (ms: number) => {
      now += ms
    },
    setData: (value: LearningValidationCase[]) => {
      data = value
    },
    setKnowledge: (value: string) => {
      knowledge = value
    },
    calls: () => calls
  }
}
describe('automatic validation of durable candidates', () => {
  it('keeps declared synthetic, model and old unspecified labels pending until explicit human labels replace them', async () => {
    const { store, memory, service, advance, setData, calls } = setup()
    advance(1000)
    for (const labelOrigin of ['synthetic', 'model', undefined] as const) {
      setData(cases.map((entry) => ({ ...entry, humanLabelled: true, labelOrigin })))
      expect(await service.runAutoValidationOnce()).toBe('completed')
      expect(store.get(scope, memory.id).activeRevision).toBeNull()
      expect(store.validation.reports(scope, memory.id)[0].result.status).toBe('insufficient')
      expect(calls()).toBe(0)
    }
    setData(cases)
    expect(await service.runAutoValidationOnce()).toBe('completed')
    expect(store.get(scope, memory.id).activeRevision).toBe(1)
    expect(calls()).toBe(10)
  })
  it('automatically publishes a passing candidate exactly once after the configured idle delay', async () => {
    const { store, memory, service, advance, calls } = setup()
    expect(await service.runAutoValidationOnce()).toBe('idle')
    advance(1000)
    expect(await service.runAutoValidationOnce()).toBe('completed')
    expect(store.get(scope, memory.id).activeRevision).toBe(1)
    expect(calls()).toBe(10)
    expect(await service.runAutoValidationOnce()).toBe('idle')
    expect(calls()).toBe(10)
    expect(store.validation.reports(scope, memory.id)[0].result).toMatchObject({
      status: 'passed',
      activated: true
    })
  })
  it('leaves insufficient cases pending without repeatedly invoking models, and resumes when a human dataset changes', async () => {
    const { store, memory, service, advance, setData, calls } = setup()
    setData([])
    advance(1000)
    expect(await service.runAutoValidationOnce()).toBe('completed')
    expect(await service.runAutoValidationOnce()).toBe('idle')
    expect(calls()).toBe(0)
    expect(store.get(scope, memory.id).state).toBe('pending')
    setData(cases)
    expect(await service.runAutoValidationOnce()).toBe('completed')
    expect(store.get(scope, memory.id).state).toBe('active')
  })
  it('reconstructs pending validation from candidate state after disk restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'learning-auto-'))
    directories.push(directory)
    const path = join(directory, 'memory.sqlite'),
      original = setup(path)
    original.advance(1000)
    original.store.close()
    const store = new LearningStore(path, () => 2000)
    stores.push(store)
    const service = new LearningService(
      store,
      { review: async () => ({ operations: [], usage: { inputTokens: 0, outputTokens: 0 } }) },
      { ...original.options, now: () => 2000 }
    )
    expect(await service.runAutoValidationOnce()).toBe('completed')
    expect(store.get(scope, original.memory.id).activeRevision).toBe(1)
  })
  it('refreshes actual knowledge/policy source before commit instead of trusting an earlier environment row', async () => {
    const { store, memory, options, setKnowledge } = setup()
    const service = new LearningService(
      store,
      { review: async () => ({ operations: [], usage: { inputTokens: 0, outputTokens: 0 } }) },
      {
        ...options,
        validation: {
          ...options.validation,
          replay: async () => {
            setKnowledge('k2')
            return { text: '型号数量', covered: true, severeErrors: [] }
          }
        }
      }
    )
    expect(await service.validateCandidate(scope, memory.id, 1)).toMatchObject({
      status: 'failed',
      reasons: ['validation_environment_changed']
    })
    expect(store.get(scope, memory.id).state).toBe('pending')
  })
  it('foreground preemption stops even a non-cooperative replay and never grants a late success', async () => {
    const { store, memory, options } = setup()
    let finish!: (value: { text: string; covered: boolean; severeErrors: string[] }) => void
    const replay = new Promise<{ text: string; covered: boolean; severeErrors: string[] }>(
      (resolve) => {
        finish = resolve
      }
    )
    const service = new LearningService(
      store,
      { review: async () => ({ operations: [], usage: { inputTokens: 0, outputTokens: 0 } }) },
      { ...options, validation: { ...options.validation, replay: () => replay } }
    )
    const validating = service.validateCandidate(scope, memory.id, 1)
    await new Promise((resolve) => setTimeout(resolve, 0))
    service.foregroundStarted()
    expect(await validating).toMatchObject({ status: 'failed', reasons: ['validation_cancelled'] })
    finish({ text: '型号数量', covered: true, severeErrors: [] })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(store.get(scope, memory.id).state).toBe('pending')
    service.foregroundEnded()
  })
  it('does not reuse a grant when foreground starts while the host dataset is being refreshed', async () => {
    const { store, memory, service, options, advance } = setup()
    store.settings(scope, { mode: 'suggest' })
    expect(await service.validateCandidate(scope, memory.id, 1)).toMatchObject({ status: 'passed' })
    store.settings(scope, { mode: 'auto' })
    advance(1000)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const worker = new LearningService(
      store,
      { review: async () => ({ operations: [], usage: { inputTokens: 0, outputTokens: 0 } }) },
      {
        ...options,
        validation: {
          ...options.validation,
          dataset: async () => {
            await gate
            return options.validation.dataset()
          }
        }
      }
    )
    const running = worker.runAutoValidationOnce()
    worker.foregroundStarted()
    release()
    expect(await running).toBe('idle')
    expect(store.get(scope, memory.id).state).toBe('pending')
    worker.foregroundEnded()
  })
  it('switching a calibrated suggestion to auto uses its still-current grant without billing a second replay', async () => {
    const { store, memory, service, advance, calls } = setup()
    store.settings(scope, { mode: 'suggest' })
    expect(await service.validateCandidate(scope, memory.id, 1)).toMatchObject({
      status: 'passed',
      activated: false
    })
    expect(calls()).toBe(10)
    store.settings(scope, { mode: 'auto' })
    advance(1000)
    expect(await service.runAutoValidationOnce()).toBe('completed')
    expect(store.get(scope, memory.id).state).toBe('active')
    expect(calls()).toBe(10)
  })
})
