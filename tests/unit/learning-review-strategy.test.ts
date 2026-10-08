import { describe, expect, it } from 'vitest'
import {
  learningReviewDigest,
  StructuredLearningReviewer
} from '../../src/core/memory/learning-reviewer'
import type {
  LearningReviewRequest,
  MemoryRecord
} from '../../src/shared/contracts/learning-memory'
import { LearningSettingsSchema } from '../../src/shared/contracts/learning-memory'

const scope = { workspaceId: 'profile', platform: 'wechat' as const, conversationId: 'customer' }
const content = {
  kind: 'lesson' as const,
  scenario: '报价前确认需求',
  guidance: '询问型号和数量',
  rationale: '',
  steps: [],
  pitfalls: [],
  verification: []
}
const memory = (id: string): MemoryRecord => ({
  id,
  scope,
  state: 'active',
  currentRevision: 1,
  activeRevision: 1,
  pinned: false,
  content,
  createdAt: 0,
  updatedAt: 0
})
function input(): LearningReviewRequest {
  return {
    episodes: [
      {
        id: 'episode',
        scope,
        sourceId: 'generation',
        topic: '询价',
        startedAt: 0,
        createdAt: 0,
        messages: [{ sourceId: 'customer', role: 'customer', text: '型号A十台' }],
        outcome: 'unknown',
        identityStatus: 'verified'
      }
    ],
    memories: [],
    feedback: [],
    settings: LearningSettingsSchema.parse({})
  }
}
const output = (kind = 'lesson') => ({
  operations: [
    {
      action: 'create',
      proposal: {
        content: { ...content, kind },
        evidence: [{ episodeId: 'episode' }],
        reason: '案例依据'
      }
    }
  ]
})
describe('review strategy uses actual experience', () => {
  it('prioritizes the loaded method over unrelated records before applying the input limit', () => {
    const request = input()
    request.memories = [
      ...Array.from({ length: 30 }, (_, index) => memory(`unrelated-${index}`)),
      memory('loaded')
    ]
    request.feedback = [
      {
        sourceId: 'loaded',
        episodeId: 'episode',
        kind: 'loaded',
        memoryRefs: [{ id: 'loaded', revision: 1 }],
        at: 0
      }
    ]
    const digest = JSON.parse(learningReviewDigest(request))
    expect(digest.memories[0].memoryId).toBe('loaded')
    expect(digest.episodes[0].identityStatus).toBe('verified')
    expect(digest.loadedMemoryRefs).toEqual([{ id: 'loaded', revision: 1 }])
  })
  it('does not invent a successful skill from a draft with an unknown result', async () => {
    const reviewer = new StructuredLearningReviewer({
      complete: async () => ({ text: JSON.stringify(output('skill')) })
    })
    await expect(reviewer.review(input(), new AbortController().signal)).rejects.toThrow(
      'review_outcome_unverified'
    )
    const corrected = input()
    corrected.episodes[0] = {
      ...corrected.episodes[0],
      outcome: 'corrected',
      correction: '先核对型号和数量',
      correctionReason: '员工确认方法'
    }
    await expect(reviewer.review(corrected, new AbortController().signal)).resolves.toMatchObject({
      operations: [{ action: 'create' }]
    })
  })
  it('requires revising an actually loaded method instead of creating its exact duplicate', async () => {
    const request = input()
    request.memories = [memory('loaded')]
    request.feedback = [
      {
        sourceId: 'loaded',
        episodeId: 'episode',
        kind: 'loaded',
        memoryRefs: [{ id: 'loaded', revision: 1 }],
        at: 0
      }
    ]
    const reviewer = new StructuredLearningReviewer({
      complete: async () => ({ text: JSON.stringify(output()) })
    })
    await expect(reviewer.review(request, new AbortController().signal)).rejects.toThrow(
      'review_duplicate_method'
    )
  })
  it('does not generalize a personal preference from an unverified identity', async () => {
    const request = input()
    request.episodes[0].identityStatus = 'unassigned'
    const reviewer = new StructuredLearningReviewer({
      complete: async () => ({ text: JSON.stringify(output('preference')) })
    })
    await expect(reviewer.review(request, new AbortController().signal)).rejects.toThrow(
      'review_identity_unverified'
    )
  })
})
