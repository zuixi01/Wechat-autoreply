import { afterEach, describe, expect, it, vi } from 'vitest'
import { LearningStore } from '../../src/core/memory/learning-store'
import { LearningCurator } from '../../src/core/memory/learning-curator'
import type { LearningReviewTransport } from '../../src/core/memory/learning-reviewer'

const scope = { workspaceId: 'profile', platform: 'generic' as const, conversationId: 'customer' }
const stores: LearningStore[] = []
afterEach(() => stores.splice(0).forEach((store) => store.close()))
async function setup() {
  let now = 1000
  const store = new LearningStore(':memory:', () => now)
  stores.push(store)
  const originals = ['先问型号', '先问数量'].map((guidance, i) => {
    const episode = store.recordEpisode(scope, {
      sourceId: `source-${i}`,
      topic: '设备询价',
      startedAt: now,
      messages: [],
      outcome: 'corrected'
    })
    const memory = store.propose(scope, {
      content: {
        kind: 'lesson',
        scenario: '设备询价',
        guidance,
        rationale: '',
        steps: [],
        pitfalls: [],
        verification: []
      },
      evidence: [{ episodeId: episode.id }],
      reason: '员工纠正',
      source: 'review'
    })
    store.activate(scope, memory.id, 1)
    return memory
  })
  const complete = vi.fn<LearningReviewTransport['complete']>().mockResolvedValue({
    text: JSON.stringify({
      content: {
        kind: 'lesson',
        scenario: '设备询价',
        guidance: '核对型号和数量，再查有效资料',
        rationale: '合并处理方法',
        steps: [],
        pitfalls: [],
        verification: []
      },
      reason: '合并同场景的方法'
    }),
    usage: { inputTokens: 20, outputTokens: 10 }
  })
  const curator = new LearningCurator(store, { transport: { complete } })
  await curator.run(scope, { dryRun: false, now })
  now += 14 * 86400000
  return {
    store,
    curator,
    originals,
    complete,
    now: () => now,
    advance: (value: number) => {
      now += value
    }
  }
}
describe('opt-in method merge proposals', () => {
  it('keeps model merging off by default without requests or costs', async () => {
    const { store, curator, complete, now } = await setup()
    await curator.run(scope, { dryRun: false, now: now() })
    expect(complete).not.toHaveBeenCalled()
    expect(store.list(scope)).toHaveLength(2)
    expect(store.jobs.usage(scope).reservedTokens).toBe(0)
  })
  it('proposes one pending method with the full evidence union and replacement links while preserving both active originals', async () => {
    const { store, curator, originals, complete, now } = await setup()
    store.settings(scope, { curatorMergeEnabled: true })
    const report = await curator.run(scope, { dryRun: false, now: now() })
    expect(report.items.map((item) => item.action)).toEqual(['propose_merge', 'propose_merge'])
    expect(complete).toHaveBeenCalledTimes(1)
    const candidate = store
      .list(scope)
      .find((memory) => !originals.some((old) => old.id === memory.id))!
    expect(candidate.state).toBe('pending')
    expect(candidate.activeRevision).toBeNull()
    expect(store.history(scope, candidate.id)[0].evidence).toHaveLength(2)
    expect(store.curation.replacements(scope, candidate.id)).toEqual(
      expect.arrayContaining(originals.map((memory) => ({ memoryId: memory.id, revision: 1 })))
    )
    for (const memory of originals)
      expect(store.get(scope, memory.id)).toMatchObject({
        state: 'active',
        currentRevision: 1,
        activeRevision: 1
      })
    expect(store.jobs.usage(scope).reservedTokens).toBe(30)
    store.activate(scope, candidate.id, 1)
    for (const memory of originals) expect(store.get(scope, memory.id).state).toBe('archived')
    const revision = store.history(scope, candidate.id)[0]
    store.revise(scope, candidate.id, 1, {
      content: { ...revision.content, guidance: '核对型号数量并说明资料出处' },
      evidence: revision.evidence,
      reason: '再次教导',
      source: 'review'
    })
    expect(store.activate(scope, candidate.id, 2)).toMatchObject({ activeRevision: 2 })
  })
  it('dry run identifies merge proposals without model calls or persistence', async () => {
    const { store, curator, complete, now } = await setup()
    store.settings(scope, { curatorMergeEnabled: true })
    expect(
      (await curator.run(scope, { dryRun: true, now: now() })).items.map((item) => item.action)
    ).toEqual(['propose_merge', 'propose_merge'])
    expect(complete).not.toHaveBeenCalled()
    expect(store.list(scope)).toHaveLength(2)
  })
  it('rejects stale model merge after a pin and retains its actual cost without creating candidates', async () => {
    const { store, curator, originals, complete, now } = await setup()
    store.settings(scope, { curatorMergeEnabled: true })
    let finish!: (value: Awaited<ReturnType<LearningReviewTransport['complete']>>) => void
    complete.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const running = curator.run(scope, { dryRun: false, now: now() })
    await new Promise((resolve) => setTimeout(resolve, 0))
    store.setPinned(scope, originals[0].id, 1, true)
    finish({
      text: JSON.stringify({
        content: {
          kind: 'lesson',
          scenario: '设备询价',
          guidance: '核对型号和数量',
          rationale: '',
          steps: [],
          pitfalls: [],
          verification: []
        },
        reason: '合并'
      }),
      usage: { inputTokens: 20, outputTokens: 10 }
    })
    await expect(running).rejects.toThrow('curation_context_changed')
    expect(store.list(scope)).toHaveLength(2)
    expect(store.jobs.usage(scope).reservedTokens).toBe(30)
  })
  it('never changes authority from extra model fields and limits repeated failed calls', async () => {
    const { store, curator, complete, now, advance } = await setup()
    store.settings(scope, { curatorMergeEnabled: true })
    complete.mockResolvedValue({
      text: '{"activate":true,"archiveIds":[]}',
      usage: { inputTokens: 20, outputTokens: 10 }
    })
    for (let i = 0; i < 3; i++) {
      expect(await curator.run(scope, { dryRun: false, now: now() })).toMatchObject({
        status: 'failed',
        reason: 'curation_merge_response_invalid'
      })
      advance(15000)
    }
    expect(await curator.run(scope, { dryRun: false, now: now() })).toMatchObject({
      status: 'waiting',
      reason: 'curation_attempts_exhausted'
    })
    expect(complete).toHaveBeenCalledTimes(3)
    expect(store.list(scope)).toHaveLength(2)
  })
})
