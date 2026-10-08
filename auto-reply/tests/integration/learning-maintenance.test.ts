import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LearningStore } from '../../src/core/memory/learning-store'
import { LearningCurator } from '../../src/core/memory/learning-curator'
import { LearningService } from '../../src/main/services/learning-service'
import { DatabaseSync } from 'node:sqlite'

const cleanup: (() => void)[] = []
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close())
)
const scope = { workspaceId: 'profile', platform: 'generic' as const, conversationId: 'customer' }
async function setup(path = ':memory:') {
  let now = 1000
  const store = new LearningStore(path, () => now)
  cleanup.push(() => store.close())
  const curator = new LearningCurator(store)
  const episode = store.recordEpisode(scope, {
    sourceId: 'source',
    topic: '询价',
    startedAt: now,
    messages: [],
    outcome: 'corrected'
  })
  const proposal = {
    content: {
      kind: 'lesson' as const,
      scenario: '询价',
      guidance: '先确认需求',
      rationale: '',
      steps: [],
      pitfalls: [],
      verification: []
    },
    evidence: [{ episodeId: episode.id }],
    reason: '纠正',
    source: 'review' as const
  }
  const memory = store.propose(scope, proposal)
  store.activate(scope, memory.id, 1)
  await curator.run(scope, { dryRun: false, now })
  now += 35 * 86400000
  return { store, curator, memory, proposal, now: () => now }
}
describe('durable maintenance boundaries', () => {
  it('service maintenance initializes once, runs when idle and yields to the foreground', async () => {
    const { store, memory, now } = await setup()
    const service = new LearningService(
      store,
      { review: async () => ({ operations: [], usage: { inputTokens: 0, outputTokens: 0 } }) },
      { workspaceId: 'profile', now }
    )
    const running = service.curate(scope, false)
    service.foregroundStarted()
    await expect(running).rejects.toThrow('curation_cancelled')
    expect(store.get(scope, memory.id).state).toBe('active')
    expect(await service.runMaintenanceOnce()).toBe('idle')
    service.foregroundEnded()
    expect(await service.runMaintenanceOnce()).toBe('idle')
  })
  it('shares the durable background lock with review and reserves no model fees for deterministic actions', async () => {
    const { store, curator, now } = await setup()
    store.jobs.enqueue(scope, store.episodes(scope)[0].id, 'correction', 'queued-review')
    // The enqueue idle window is independent from the maintenance interval.
    const claim = store.jobs.claim('other-worker')
    expect(claim).toBeNull()
    const validation = store.validationBudget.begin(scope, 'existing-validation')
    await expect(curator.run(scope, { dryRun: false, now: now() })).rejects.toThrow(
      'learning_background_busy'
    )
    store.validationBudget.end(validation, 'completed')
    expect(store.jobs.usage(scope).requests).toBe(0)
  })
  it('rolls back every mutation if writing the maintenance report fails on real disk SQLite', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'learning-curator-atomic-'))
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
    const path = join(directory, 'learning.sqlite'),
      { store, curator, memory, now } = await setup(path)
    const db = new DatabaseSync(path)
    cleanup.push(() => db.close())
    db.exec(
      "CREATE TRIGGER reject_curation_report BEFORE INSERT ON learning_curation_reports BEGIN SELECT RAISE(FAIL,'injected_report_failure'); END"
    )
    await expect(curator.run(scope, { dryRun: false, now: now() })).rejects.toThrow(
      'injected_report_failure'
    )
    expect(store.get(scope, memory.id).state).toBe('active')
    expect(store.curation.state(scope)?.lastRunAt).toBe(1000)
  })
  it('foreground cancellation invalidates the plan before any mutation', async () => {
    const { store, curator, memory, now } = await setup(),
      controller = new AbortController()
    const running = curator.run(scope, { dryRun: false, now: now() }, controller.signal)
    controller.abort('foreground_preempted')
    await expect(running).rejects.toThrow('curation_cancelled')
    expect(store.get(scope, memory.id).state).toBe('active')
  })
  it('a concurrent revision rejects the whole old plan', async () => {
    const { store, curator, memory, proposal, now } = await setup()
    const running = curator.run(scope, { dryRun: false, now: now() })
    store.revise(scope, memory.id, 1, {
      ...proposal,
      content: { ...proposal.content, guidance: '先问型号' }
    })
    await expect(running).rejects.toThrow('curation_context_changed')
    expect(store.get(scope, memory.id).state).toBe('active')
    expect(store.curation.reports(scope).filter((report) => report.status === 'completed')).toEqual(
      []
    )
  })
  it('forgetting the scope rejects late maintenance and does not recreate metadata', async () => {
    const { store, curator, now } = await setup()
    const running = curator.run(scope, { dryRun: false, now: now() })
    store.forgetScope(scope)
    await expect(running).rejects.toThrow('curation_context_changed')
    expect(store.curation.state(scope)).toBeNull()
    expect(store.curation.reports(scope)).toEqual([])
  })
  it('keeps its first observation and interval across a real SQLite restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'learning-curator-'))
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
    const path = join(directory, 'learning.sqlite'),
      original = await setup(path)
    original.store.close()
    const store = new LearningStore(path, original.now)
    cleanup.push(() => store.close())
    expect(
      await new LearningCurator(store).run(scope, { dryRun: false, now: original.now() })
    ).toMatchObject({ status: 'completed' })
    expect(store.get(scope, original.memory.id).state).toBe('archived')
    expect(
      await new LearningCurator(store).run(scope, { dryRun: false, now: original.now() })
    ).toMatchObject({ status: 'waiting', reason: 'curation_interval_required' })
  })
})
