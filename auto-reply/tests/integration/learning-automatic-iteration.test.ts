import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createLearningIterationFixture,
  iterationCalibration,
  ITERATION_V1,
  ITERATION_V2
} from '../../scripts/learning-iteration-fixture'

describe('actual correction, HTTP review, isolated product calibration and next reply', () => {
  it('learns V1, revises from actual V1 use, keeps pending V2 isolated, generates with V2 and rolls back as V3', async () => {
    const root = await mkdtemp(join(tmpdir(), 'learning-actual-iteration-'))
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep + 'learning-actual-iteration-'))
      throw new Error('unexpected_fixture_root')
    const f = await createLearningIterationFixture(root)
    try {
      const first = await f.generate()
      expect(first.text).toBe('请确认型号。')
      const original = first.learning!
      f.service.correct(f.scope, original.episodeId, {
        sourceId: 'synthetic-correction-v1',
        text: ITERATION_V1,
        reason: '合成员工指出缺少数量'
      })
      f.advance()
      expect(await f.service.scheduler.runOnce()).toBe('completed')
      const memory = f.store.list(f.scope)[0]
      expect(memory).toMatchObject({ currentRevision: 1, activeRevision: null })
      f.advance()
      expect(await f.service.runAutoValidationOnce()).toBe('completed')
      expect(f.store.get(f.scope, memory.id).activeRevision).toBeNull()
      f.store.validation.importCalibration(
        f.scope,
        { cases: iterationCalibration(1), humanConfirmed: true },
        'synthetic-human-reviewer'
      )
      expect(await f.service.runAutoValidationOnce()).toBe('completed')
      expect(f.store.get(f.scope, memory.id).activeRevision).toBe(1)
      const v1 = await f.generate()
      expect(v1.text).toBe('请确认型号和数量。')
      expect(v1.learning?.memoryRefs).toEqual([{ id: memory.id, revision: 1 }])
      f.service.correct(f.scope, v1.learning!.episodeId, {
        sourceId: 'synthetic-correction-v2',
        text: ITERATION_V2,
        reason: '合成员工指出还需用途'
      })
      f.advance()
      expect(await f.service.scheduler.runOnce()).toBe('completed')
      expect(f.store.list(f.scope)).toHaveLength(1)
      expect(f.store.get(f.scope, memory.id)).toMatchObject({
        currentRevision: 2,
        activeRevision: 1
      })
      const pending = await f.generate()
      expect(pending.text).toBe('请确认型号和数量。')
      expect(pending.learning?.memoryRefs).toEqual([{ id: memory.id, revision: 1 }])
      f.store.validation.importCalibration(
        f.scope,
        { cases: iterationCalibration(2), humanConfirmed: true },
        'synthetic-human-reviewer'
      )
      f.advance()
      expect(await f.service.runAutoValidationOnce()).toBe('completed')
      expect(f.store.get(f.scope, memory.id).activeRevision).toBe(2)
      const v2 = await f.generate()
      expect(v2.text).toBe('请确认型号、数量和用途。')
      expect(v2.learning?.memoryRefs).toEqual([{ id: memory.id, revision: 2 }])
      f.store.rollback(f.scope, memory.id, 2, 1)
      const rollback = await f.generate()
      expect(rollback.text).toBe('请确认型号和数量。')
      expect(rollback.learning?.memoryRefs).toEqual([{ id: memory.id, revision: 3 }])
      const reviews = f.requests.filter((request) => request.kind === 'review')
      expect(reviews).toHaveLength(2)
      expect(JSON.parse(reviews[1].user)).toMatchObject({
        loadedMemoryRefs: [{ id: memory.id, revision: 1 }],
        loadedRevisions: [{ memoryId: memory.id, revision: 1 }]
      })
      expect(
        f.requests
          .filter((request) => request.kind === 'reply')
          .every(
            (request) =>
              !request.system.includes('human-only-rubric') &&
              !request.user.includes('human-only-rubric')
          )
      ).toBe(true)
      expect(f.store.metrics(f.scope, memory.id).adopted).toBe(0)
      expect(f.store.episode(f.scope, v2.learning!.episodeId).outcome).toBe('unknown')
    } finally {
      await f.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
