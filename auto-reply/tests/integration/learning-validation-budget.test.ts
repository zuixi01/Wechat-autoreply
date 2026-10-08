import { afterEach, describe, expect, it } from 'vitest'
import { LearningStore } from '../../src/core/memory/learning-store'
import { BudgetedLearningValidationTransport } from '../../src/core/memory/learning-validation-budget'
import type { LearningReviewTransport } from '../../src/core/memory/learning-reviewer'

const scope = { workspaceId: 'profile', platform: 'generic' as const, conversationId: 'customer' }
const stores: LearningStore[] = []
afterEach(() => stores.splice(0).forEach((store) => store.close()))
function setup() {
  let now = 1000
  const store = new LearningStore(':memory:', () => now)
  stores.push(store)
  store.settings(scope, {
    idleDelayMs: 1000,
    maxReviewInputTokens: 1000,
    dailyReviewTokenBudget: 10000
  })
  const episode = store.recordEpisode(scope, {
    sourceId: 'source',
    topic: '流程',
    startedAt: 1000,
    outcome: 'corrected',
    messages: []
  })
  return {
    store,
    episode,
    advance: (ms: number) => {
      now += ms
    }
  }
}
describe('calibration and review share one background lock and account budget', () => {
  it('prevents review claims while validation owns the slot and refuses validation during a review', () => {
    const { store, episode, advance } = setup()
    store.jobs.enqueue(scope, episode.id, 'correction', 'review')
    advance(1000)
    const run = store.validationBudget.begin(scope, 'validation')
    expect(store.jobs.claim('reviewer')).toBeNull()
    expect(() => store.validationBudget.begin(scope, 'other')).toThrow('learning_background_busy')
    store.validationBudget.end(run, 'completed')
    const review = store.jobs.claim('reviewer')!
    expect(() => store.validationBudget.begin(scope, 'other')).toThrow('learning_background_busy')
    store.jobs.fail(review, 'review_unavailable')
  })
  it('records model usage in the same UTC-day total and charges unknown/cancelled requests at the bound', async () => {
    const { store } = setup()
    const run = store.validationBudget.begin(scope, 'validation')
    const transport: LearningReviewTransport = {
      complete: async () => ({
        text: '{"units":[]}',
        usage: { inputTokens: 100, outputTokens: 20 }
      })
    }
    const budgeted = new BudgetedLearningValidationTransport(store, run, transport)
    await budgeted.complete(
      { system: 'system', user: 'case', maxOutputTokens: 2000 },
      new AbortController().signal
    )
    expect(store.jobs.usage(scope)).toMatchObject({
      reservedTokens: 120,
      inputTokens: 100,
      outputTokens: 20,
      reportedRequests: 1
    })
    const failing = new BudgetedLearningValidationTransport(store, run, {
      complete: async () => {
        throw new Error('review_unavailable')
      }
    })
    await expect(
      failing.complete(
        { system: 'system', user: 'case', maxOutputTokens: 2000 },
        new AbortController().signal
      )
    ).rejects.toThrow('review_unavailable')
    expect(store.jobs.usage(scope).estimatedRequests).toBe(1)
    expect(store.jobs.usage(scope).reservedTokens).toBeGreaterThan(2120)
    store.validationBudget.end(run, 'cancelled')
    expect(store.jobs.usage(scope).requests).toBe(2)
  })
  it('honours the account cap across customers before dispatching a model request', async () => {
    const { store } = setup()
    store.settings(
      { workspaceId: scope.workspaceId, platform: scope.platform },
      { dailyReviewTokenBudget: 1000 }
    )
    const run = store.validationBudget.begin(scope, 'validation')
    let called = false
    const transport = new BudgetedLearningValidationTransport(store, run, {
      complete: async () => {
        called = true
        return { text: '{}' }
      }
    })
    await expect(
      transport.complete(
        { system: 'system', user: 'case', maxOutputTokens: 2000 },
        new AbortController().signal
      )
    ).rejects.toThrow('validation_budget_exhausted')
    expect(called).toBe(false)
    expect(store.jobs.usage(scope).reservedTokens).toBe(0)
  })
  it('keeps late usage accounting after cancellation without regaining background ownership', async () => {
    const { store } = setup()
    const run = store.validationBudget.begin(scope, 'validation')
    let finish!: (value: {
      text: string
      usage: { inputTokens: number; outputTokens: number }
    }) => void
    const pending = new Promise<{
      text: string
      usage: { inputTokens: number; outputTokens: number }
    }>((resolve) => {
      finish = resolve
    })
    const transport = new BudgetedLearningValidationTransport(store, run, {
      complete: () => pending
    })
    const controller = new AbortController()
    const request = transport.complete(
      { system: 's', user: 'u', maxOutputTokens: 2000 },
      controller.signal
    )
    controller.abort('foreground_preempted')
    await expect(request).rejects.toThrow('validation_cancelled')
    store.validationBudget.end(run, 'cancelled')
    const next = store.validationBudget.begin(scope, 'new-run')
    finish({ text: '{}', usage: { inputTokens: 10, outputTokens: 5 } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(store.jobs.usage(scope)).toMatchObject({ reservedTokens: 15, reportedRequests: 1 })
    expect(() => store.validationBudget.reserve(run, 'old', 100, 100)).toThrow(
      'validation_run_expired'
    )
    store.validationBudget.end(next, 'completed')
  })
  it('forgetting a scope retains anonymous fees and rejects late ownership or replay', async () => {
    const { store } = setup()
    const run = store.validationBudget.begin(scope, 'validation')
    await new BudgetedLearningValidationTransport(store, run, {
      complete: async () => ({ text: '{}', usage: { inputTokens: 10, outputTokens: 5 } })
    }).complete({ system: 's', user: 'u', maxOutputTokens: 2000 }, new AbortController().signal)
    store.forgetScope(scope)
    expect(store.jobs.usage(scope)).toMatchObject({ reservedTokens: 15, reportedRequests: 1 })
    expect(() => store.validationBudget.reserve(run, 'late', 100, 100)).toThrow(
      'validation_run_expired'
    )
  })
})
