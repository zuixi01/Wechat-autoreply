import { describe, expect, it } from 'vitest'
import { ReplyTaskSchema, DraftReviewSchema } from '../../src/shared/contracts/task'
import { taskFixture } from '../fixtures/task'
import { parseGenerationResult } from '../../src/core/reply/generation-validation'
import { parsePreparedGenerationTask } from '../../src/core/reply/learning-task-binding'

const binding = {
  memoryCorpusVersion: 'methods-v1',
  memorySnapshotHash: 'a'.repeat(64),
  learningContextVersion: 'b'.repeat(64)
}
describe('learning-bound tasks and reviews', () => {
  it('accepts complete bindings and rejects partial or extra authority fields', () => {
    const { task, review } = taskFixture()
    expect(ReplyTaskSchema.parse({ ...task, ...binding })).toMatchObject(binding)
    expect(DraftReviewSchema.parse({ ...review, ...binding })).toMatchObject(binding)
    expect(() =>
      ReplyTaskSchema.parse({ ...task, memoryCorpusVersion: binding.memoryCorpusVersion })
    ).toThrow()
    expect(() =>
      DraftReviewSchema.parse({ ...review, memorySnapshotHash: binding.memorySnapshotHash })
    ).toThrow()
    expect(() => ReplyTaskSchema.parse({ ...task, ...binding, memoryManifest: [] })).toThrow()
  })
  it('allows only the host binding to be added during preparation', () => {
    const { task } = taskFixture()
    expect(parsePreparedGenerationTask({ ...task, ...binding }, task)).toMatchObject(binding)
    for (const extra of [
      { conversationId: 'other-customer' },
      { contextHash: 'c'.repeat(64) },
      { configVersion: 'other-config' },
      { expiresAt: task.expiresAt + 1 }
    ]) {
      expect(() => parsePreparedGenerationTask({ ...task, ...binding, ...extra }, task)).toThrow(
        'prepared_task_changed'
      )
    }
    expect(() => parsePreparedGenerationTask(task, task)).toThrow('prepared_task_binding_missing')
  })
  it('rejects a review whose learning snapshot differs from its task', () => {
    const { task, draft, review } = taskFixture()
    const prepared = { ...task, ...binding }
    const result = {
      task: prepared,
      draft,
      review: { ...review, ...binding },
      status: 'candidate',
      automaticAllowed: false,
      factsVerified: true,
      reasons: [],
      intents: ['faq'],
      usage: { input_tokens: 0, output_tokens: 0 }
    }
    expect(parseGenerationResult(result, prepared)).toMatchObject({
      task: binding,
      review: binding
    })
    expect(() =>
      parseGenerationResult(
        { ...result, review: { ...result.review, learningContextVersion: 'c'.repeat(64) } },
        prepared
      )
    ).toThrow('generation_review_changed')
  })
})
