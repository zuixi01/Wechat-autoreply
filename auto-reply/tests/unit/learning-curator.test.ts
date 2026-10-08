import { afterEach, describe, expect, it } from 'vitest'
import { LearningStore } from '../../src/core/memory/learning-store'
import { LearningCurator } from '../../src/core/memory/learning-curator'
import type { MemoryProposal } from '../../src/shared/contracts/learning-memory'

const day = 86400000
const scope = { workspaceId: 'profile', platform: 'generic' as const, conversationId: 'customer' }
const stores: LearningStore[] = []
afterEach(() => stores.splice(0).forEach((store) => store.close()))
function setup() {
  let now = 1000,
    sequence = 0
  const store = new LearningStore(':memory:', () => now)
  stores.push(store)
  const curator = new LearningCurator(store)
  const add = (source: MemoryProposal['source'] = 'review') => {
    const episode = store.recordEpisode(scope, {
      sourceId: `source-${++sequence}`,
      topic: '询价',
      startedAt: now,
      messages: [],
      outcome: 'corrected'
    })
    const memory = store.propose(scope, {
      content: {
        kind: 'lesson',
        scenario: `询价-${sequence}`,
        guidance: '先确认需求',
        rationale: '',
        steps: [],
        pitfalls: [],
        verification: []
      },
      evidence: [{ episodeId: episode.id }],
      reason: '有据纠正',
      source
    })
    store.activate(scope, memory.id, 1)
    return memory
  }
  return {
    store,
    curator,
    add,
    now: () => now,
    advance: (value: number) => {
      now += value
    }
  }
}
describe('deterministic learning memory maintenance', () => {
  it('initializes the first observation even when existing methods are old', async () => {
    const { store, curator, add, now, advance } = setup()
    const memory = add()
    advance(35 * day)
    expect(await curator.run(scope, { dryRun: false, now: now() })).toMatchObject({
      status: 'initialized'
    })
    expect(store.get(scope, memory.id).state).toBe('active')
    expect(store.curation.state(scope)).toMatchObject({ observedAt: now(), lastRunAt: now() })
  })
  it('enforces seven days between runs and two hours after actual activity', async () => {
    const { store, curator, add, now, advance } = setup()
    const memory = add()
    await curator.run(scope, { dryRun: false, now: now() })
    advance(35 * day)
    store.curation.touch(scope, now())
    advance(7200000 - 1)
    expect(await curator.run(scope, { dryRun: false, now: now() })).toMatchObject({
      status: 'waiting',
      reason: 'curation_idle_required'
    })
    advance(1)
    expect(await curator.run(scope, { dryRun: false, now: now() })).toMatchObject({
      status: 'completed'
    })
    expect(store.get(scope, memory.id).state).toBe('archived')
    expect(await curator.run(scope, { dryRun: false, now: now() })).toMatchObject({
      status: 'waiting',
      reason: 'curation_interval_required'
    })
  })
  it('keeps new unused methods through the full grace period, then marks stale at day fourteen', async () => {
    const { store, curator, add, now, advance } = setup()
    const memory = add()
    await curator.run(scope, { dryRun: false, now: now() })
    advance(7 * day)
    await curator.run(scope, { dryRun: false, now: now() })
    expect(store.get(scope, memory.id).state).toBe('active')
    advance(7 * day)
    await curator.run(scope, { dryRun: false, now: now() })
    expect(store.get(scope, memory.id).state).toBe('stale')
    expect(store.get(scope, memory.id).updatedAt).toBe(1000)
    advance(16 * day)
    await curator.run(scope, { dryRun: false, now: now() })
    expect(store.get(scope, memory.id).state).toBe('archived')
    store.restore(scope, memory.id, 1)
    expect(store.get(scope, memory.id).state).toBe('active')
    expect(store.history(scope, memory.id)).toHaveLength(1)
  })
  it('protects manual, employee and pinned methods even after thirty days', async () => {
    const { store, curator, add, now, advance } = setup()
    const human = add('human'),
      manual = add('manual'),
      pinned = add()
    store.setPinned(scope, pinned.id, 1, true)
    await curator.run(scope, { dryRun: false, now: now() })
    advance(35 * day)
    const report = await curator.run(scope, { dryRun: false, now: now() })
    expect(report.items.every((item) => item.action === 'keep')).toBe(true)
    for (const memory of [human, manual, pinned])
      expect(store.get(scope, memory.id).state).toBe('active')
  })
  it('uses actual loaded feedback to keep a recently used method', async () => {
    const { store, curator, add, now, advance } = setup()
    const memory = add()
    await curator.run(scope, { dryRun: false, now: now() })
    advance(34 * day)
    const episode = store.episodes(scope)[0]
    store.feedback(scope, {
      sourceId: 'actual-use',
      episodeId: episode.id,
      kind: 'loaded',
      memoryRefs: [{ id: memory.id, revision: 1 }],
      at: now()
    })
    advance(day)
    await curator.run(scope, { dryRun: false, now: now() })
    expect(store.get(scope, memory.id).state).toBe('active')
  })
  it('dry run previews actions without changing memory, observation clocks or reports', async () => {
    const { store, curator, add, now, advance } = setup()
    const memory = add()
    await curator.run(scope, { dryRun: false, now: now() })
    advance(35 * day)
    const before = store.curation.state(scope),
      reports = store.curation.reports(scope)
    expect(await curator.run(scope, { dryRun: true, now: now() })).toMatchObject({
      status: 'completed',
      items: [{ memoryId: memory.id, action: 'archive' }]
    })
    expect(store.get(scope, memory.id).state).toBe('active')
    expect(store.curation.state(scope)).toEqual(before)
    expect(store.curation.reports(scope)).toEqual(reports)
  })
  it('off stops maintenance without deleting prior experience or initializing its clock', async () => {
    const { store, curator, add, now } = setup()
    const memory = add()
    store.settings(scope, { mode: 'off' })
    expect(await curator.run(scope, { dryRun: false, now: now() })).toMatchObject({
      status: 'waiting',
      reason: 'learning_disabled'
    })
    expect(store.curation.state(scope)?.observedAt).toBeNull()
    expect(store.get(scope, memory.id).state).toBe('active')
  })
})
