import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LearningStore } from '../../src/core/memory/learning-store'
import { LearningService } from '../../src/main/services/learning-service'

const scope = { workspaceId: 'profile', platform: 'wechat' as const }
const stores: LearningStore[] = [],
  directories: string[] = []
afterEach(() => {
  stores.splice(0).forEach((store) => store.close())
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }))
})
describe('a correction and its review event persist atomically', () => {
  it.each(['feedback', 'queue'])(
    'failed %s during a whole-problem correction preserves the open problem',
    (failure) => {
      const directory = mkdtempSync(join(tmpdir(), 'learning-problem-correction-'))
      directories.push(directory)
      const path = join(directory, 'learning.sqlite'),
        store = new LearningStore(path, () => 1000)
      stores.push(store)
      const customer = { ...scope, conversationId: 'customer' }
      const service = new LearningService(
        store,
        { review: async () => ({ operations: [], usage: { inputTokens: 0, outputTokens: 0 } }) },
        { workspaceId: 'profile', now: () => 1000 }
      )
      const base = service.onDraft(
        {
          screenshot: '',
          appType: 'wechat',
          extractedText: '报价',
          learningGenerationId: 'g1',
          learningProblemId: 'p1'
        },
        null,
        '100元',
        customer
      )
      const correction = { sourceId: 'edit', text: '先核对需求', reason: '价格不能猜' }
      const fault = new DatabaseSync(path)
      fault.exec(
        failure === 'feedback'
          ? "CREATE TRIGGER fail_problem BEFORE INSERT ON learning_feedback WHEN json_extract(new.payload,'$.kind')='substantially_corrected' BEGIN SELECT RAISE(ABORT,'simulated_write_failure'); END"
          : "CREATE TRIGGER fail_problem BEFORE INSERT ON learning_jobs BEGIN SELECT RAISE(ABORT,'simulated_write_failure'); END"
      )
      try {
        expect(() => service.correct(customer, base.id, correction)).toThrow(
          'simulated_write_failure'
        )
        expect(store.episodes(customer)).toHaveLength(1)
        expect(store.jobs.list(customer)).toEqual([])
        expect(
          fault.prepare('SELECT closed_episode_id FROM learning_problems').get()?.closed_episode_id
        ).toBeNull()
        expect(
          fault
            .prepare(
              'SELECT COUNT(*) AS count FROM learning_problem_events WHERE payload IS NOT NULL'
            )
            .get()?.count
        ).toBe(2)
        fault.exec('DROP TRIGGER fail_problem')
        const changed = service.correct(customer, base.id, correction)
        expect(service.correct(customer, base.id, correction).id).toBe(changed.id)
        expect(changed.messages).toHaveLength(2)
        expect(store.jobs.list(customer)[0].episodeIds).toEqual([changed.id])
        expect(
          fault
            .prepare(
              'SELECT COUNT(*) AS count FROM learning_problem_events WHERE payload IS NOT NULL'
            )
            .get()?.count
        ).toBe(0)
      } finally {
        fault.close()
      }
    }
  )
  it.each(['feedback', 'queue'])(
    'a failed %s write leaves no partially saved correction and a retry is once',
    (failure) => {
      const directory = mkdtempSync(join(tmpdir(), 'learning-correction-'))
      directories.push(directory)
      const path = join(directory, 'learning.sqlite'),
        store = new LearningStore(path)
      stores.push(store)
      const service = new LearningService(
        store,
        { review: async () => ({ operations: [], usage: { inputTokens: 0, outputTokens: 0 } }) },
        { workspaceId: 'profile' }
      )
      const base = store.recordEpisode(scope, {
        sourceId: 'base',
        topic: '报价',
        startedAt: Date.now(),
        messages: [],
        draft: '100元',
        outcome: 'unknown'
      })
      const correction = { sourceId: 'edit', text: '先核对型号和数量', reason: '不能猜价格' }
      const fault = new DatabaseSync(path)
      fault.exec(
        failure === 'feedback'
          ? "CREATE TRIGGER fail_correction BEFORE INSERT ON learning_feedback BEGIN SELECT RAISE(ABORT,'simulated_write_failure'); END"
          : "CREATE TRIGGER fail_correction BEFORE INSERT ON learning_jobs BEGIN SELECT RAISE(ABORT,'simulated_write_failure'); END"
      )
      try {
        expect(() => service.correct(scope, base.id, correction)).toThrow('simulated_write_failure')
        expect(store.episodes(scope)).toHaveLength(1)
        expect(store.feedbackEvents(scope)).toEqual([])
        expect(store.jobs.list(scope)).toEqual([])
        fault.exec('DROP TRIGGER fail_correction')
        const corrected = service.correct(scope, base.id, correction)
        expect(service.correct(scope, base.id, correction).id).toBe(corrected.id)
        expect(store.episodes(scope)).toHaveLength(2)
        expect(store.feedbackEvents(scope)).toHaveLength(1)
        expect(store.jobs.list(scope)).toHaveLength(1)
        expect(store.jobs.list(scope)[0].episodeIds).toEqual([corrected.id])
      } finally {
        fault.close()
      }
    }
  )
})
