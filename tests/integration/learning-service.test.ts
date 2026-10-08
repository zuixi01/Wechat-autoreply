import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LearningStore } from '../../src/core/memory/learning-store'
import { LearningService } from '../../src/main/services/learning-service'
import type { LearningReviewer } from '../../src/core/memory/learning-reviewer'
import type { ProviderInput } from '../../src/core/session-types'
import type { ConversationBinding } from '../../src/shared/contracts/identity'

const stores: LearningStore[] = [],
  directories: string[] = []
afterEach(() => {
  stores.splice(0).forEach((store) => store.close())
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }))
})
const binding: ConversationBinding = {
  identity: {
    tenantId: 'tenant',
    accountId: 'account',
    employeeId: 'employee',
    agentId: 'agent',
    platform: 'wechat',
    loginEpoch: 0,
    clientInstanceId: 'client'
  },
  conversationId: 'a',
  bindingVersion: 1,
  identityVerified: true,
  identityEvidence: ['trusted']
}
const input: ProviderInput = {
  screenshot: '',
  appType: 'wechat',
  extractedText: '设备报价多少钱？',
  learningGenerationId: 'generation',
  binding
}
const noOp: LearningReviewer = {
  review: async () => ({
    operations: [],
    usage: { inputTokens: 100, outputTokens: 10, measurement: 'reported' }
  })
}
function setup() {
  let now = 1000
  const store = new LearningStore(':memory:', () => now)
  stores.push(store)
  const service = new LearningService(store, noOp, { workspaceId: 'profile', now: () => now })
  return {
    store,
    service,
    advance: (at: number) => {
      now = at
    }
  }
}
describe('product learning service', () => {
  it('records a draft as unknown without prematurely queuing a completed problem', () => {
    const { store, service } = setup()
    const episode = service.onDraft(input, null, '100 元')
    expect(episode.outcome).toBe('unknown')
    expect(episode.scope.conversationId).toBe('a')
    expect(store.jobs.list(episode.scope)).toHaveLength(0)
    expect(service.onDraft(input, null, '100 元').id).toBe(episode.id)
    expect(store.jobs.list(episode.scope)).toHaveLength(0)
  })
  it('a correction creates new evidence and coalesces automatic learning idempotently', () => {
    const { store, service } = setup(),
      episode = service.onDraft(input, null, '100 元')
    const result = service.correct(episode.scope, episode.id, {
      sourceId: 'edit',
      text: '请问型号和数量？',
      reason: '先确认完整需求'
    })
    expect(result).toMatchObject({
      draft: '100 元',
      correction: '请问型号和数量？',
      outcome: 'corrected'
    })
    expect(
      service.correct(episode.scope, episode.id, {
        sourceId: 'edit',
        text: '请问型号和数量？',
        reason: '先确认完整需求'
      }).id
    ).toBe(result.id)
    expect(store.jobs.list(episode.scope)[0].episodeIds).toHaveLength(1)
    expect(store.jobs.list(episode.scope)[0].triggers).toEqual(['correction'])
    expect(
      store.feedbackEvents(episode.scope).find((event) => event.kind === 'substantially_corrected')
    ).toBeDefined()
    expect(() =>
      service.correct({ ...episode.scope, conversationId: 'b' }, episode.id, {
        sourceId: 'wrong',
        text: '改写',
        reason: '原因'
      })
    ).toThrow()
  })
  it('keeps unknown identities in separate unassigned cases and never treats names as identity', () => {
    const { service, store } = setup()
    const first = service.onDraft(
      { ...input, binding: undefined, currentContact: '同名' },
      null,
      '回复'
    )
    const second = service.onDraft(
      { ...input, binding: undefined, learningGenerationId: 'other', currentContact: '同名' },
      null,
      '回复'
    )
    expect(first.scope.conversationId).not.toBe(second.scope.conversationId)
    expect(first.identityStatus).toBe('unassigned')
    expect(store.episodes(first.scope)).toHaveLength(1)
    expect(service.scopes()).toHaveLength(2)
  })
  it('off mode stops automatic and manual review while keeping the episode evidence', () => {
    const { store, service } = setup()
    const scope = service.resolveScope(input)!
    store.settings(scope, { ...store.settings(scope), mode: 'off' })
    const episode = service.onDraft(input, null, '回复')
    expect(store.jobs.list(scope)).toEqual([])
    expect(() => service.review(scope, episode.id, 'manual')).toThrow('learning_disabled')
    expect(store.episodes(scope)).toHaveLength(1)
  })
  it('resumes a durable pending review with a new service after restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'learning-service-'))
    directories.push(directory)
    const path = join(directory, 'memory.sqlite')
    let now = 1000
    const first = new LearningStore(path, () => now)
    const old = new LearningService(first, noOp, { workspaceId: 'profile', now: () => now })
    const scope = old.resolveScope(input)!
    first.settings(scope, { ...first.settings(scope), idleDelayMs: 1000 })
    const episode = old.onDraft(input, null, '回复')
    old.correct(scope, episode.id, { sourceId: 'human-edit', text: '修正回复', reason: '真实纠正' })
    first.close()
    now = 2000
    const store = new LearningStore(path, () => now)
    stores.push(store)
    const resumed = new LearningService(store, noOp, { workspaceId: 'profile', now: () => now })
    expect(await resumed.scheduler.runOnce()).toBe('completed')
    expect(store.jobs.list(scope)[0].state).toBe('completed')
    expect(store.jobs.usage(scope).reportedRequests).toBe(1)
  })
})
