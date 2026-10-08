import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const electron = vi.hoisted(() => ({ handle: vi.fn(), window: vi.fn(() => ({})) }))
vi.mock('electron', () => ({
  ipcMain: { handle: electron.handle },
  BrowserWindow: { fromWebContents: electron.window }
}))
import { Ledger } from '../../src/core/persistence/ledger'
import { LearningStore } from '../../src/core/memory/learning-store'
import { LearningService } from '../../src/main/services/learning-service'
import { DesktopAgentRuntime } from '../../src/main/services/desktop-agent-runtime'
import { AgentRegistration } from '../../src/main/services/agent-registration'
import { registerLearningSubmissionIpc } from '../../src/main/ipc/learning-submission-ipc'
import { registerLearningIpc } from '../../src/main/ipc/learning-ipc'

const scope = { workspaceId: 'local', platform: 'generic' as const, conversationId: 'customer' }
const request = {
  kind: 'manual' as const,
  input: {
    scope,
    sourceId: '11111111-1111-4111-8111-111111111111',
    content: {
      kind: 'lesson' as const,
      scenario: '订单',
      guidance: '先核对订单',
      rationale: '',
      steps: [],
      pitfalls: [],
      verification: []
    },
    reason: '人工教导'
  }
}
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const run of cleanups.splice(0).reverse()) await run()
  electron.handle.mockClear()
})
function setup() {
  const ledger = new Ledger(':memory:'),
    store = new LearningStore(':memory:')
  const client = new AgentRegistration(
    { load: () => undefined, save: () => {} },
    { available: () => true, encrypt: () => '', decrypt: () => '' },
    fetch
  )
  const runtime = new DesktopAgentRuntime(ledger, client)
  const service = new LearningService(
    store,
    { review: async () => ({ operations: [], usage: { inputTokens: 0, outputTokens: 0 } }) },
    { workspaceId: 'local' }
  )
  cleanups.push(async () => {
    await runtime.close()
    service.stop()
    store.close()
  })
  runtime.configureLearningSubmissions(service)
  return { ledger, store, runtime, service }
}
describe('durable learning desktop path', () => {
  it('routes a host-authorized manual intent through the same local learning store', async () => {
    const f = setup()
    expect(await f.runtime.submitLearning(request)).toMatchObject({
      state: 'saved',
      sourceId: request.input.sourceId
    })
    expect(f.store.list(scope)).toHaveLength(1)
    expect(f.runtime.learningSubmissions(scope)).toMatchObject([{ state: 'saved' }])
    await f.runtime.submitLearning(request)
    expect(f.store.episodes(scope)).toHaveLength(1)
    await expect(
      f.runtime.submitLearning({
        ...request,
        input: { ...request.input, scope: { ...scope, workspaceId: 'foreign' } }
      })
    ).rejects.toThrow('learning_scope_unavailable')
  })
  it('exposes only trusted named submit and scoped receipts and rejects host-owned fields', async () => {
    const f = setup(),
      file = resolve('out/renderer/index.html')
    registerLearningSubmissionIpc(file, undefined, f.runtime)
    const frame = { url: pathToFileURL(file).href },
      event = { senderFrame: frame, sender: { mainFrame: frame, isDestroyed: () => false } }
    const invoke = (channel: string, input: unknown, sender = event) => {
      const handler = electron.handle.mock.calls.find(
        (call) => call[0] === `learning-submission:${channel}`
      )?.[1]
      if (!handler) throw new Error('handler_missing')
      return handler(sender, input)
    }
    expect(await invoke('submit', request)).toMatchObject({ state: 'saved' })
    expect(invoke('receipts', { scope })).toHaveLength(1)
    expect(() => invoke('submit', { ...request, authorityId: 'a'.repeat(64) })).toThrow()
    const badFrame = { url: 'https://untrusted.example' }
    expect(() =>
      invoke(
        'receipts',
        { scope },
        { senderFrame: badFrame, sender: { mainFrame: badFrame, isDestroyed: () => false } }
      )
    ).toThrow()
  })
  it('blocks replay behind restoration review and joins journal shutdown', async () => {
    const f = setup()
    const episode = f.store.recordEpisode(scope, {
      sourceId: 'restored-source',
      topic: '只读',
      startedAt: Date.now(),
      messages: [],
      outcome: 'unknown'
    })
    vi.spyOn(f.ledger, 'requiresRestoreReview').mockReturnValue(true)
    expect(() => f.runtime.observeLearningEpisode(episode)).not.toThrow()
    expect(f.ledger.learningSubmissions.episodeTime(scope, episode.id)).toBeUndefined()
    await expect(f.runtime.submitLearning(request)).rejects.toThrow('learning_scope_unavailable')
    expect(f.store.list(scope)).toEqual([])
    await f.runtime.close()
    await expect(f.runtime.submitLearning(request)).rejects.toThrow('learning_scope_unavailable')
  })
  it('observes only authorized case reads and clears durable receipts and cached sources on local scope forget', async () => {
    const f = setup(),
      file = resolve('out/renderer/index.html')
    registerLearningIpc(file, undefined, f.service, () => scope, undefined, undefined, {
      observed: (episode) => f.runtime.observeLearningEpisode(episode),
      forgetLocal: (selected, run) => f.runtime.forgetLocalLearning(selected, run)
    })
    await f.runtime.submitLearning(request)
    const episode = f.store.episodes(scope)[0]
    const frame = { url: pathToFileURL(file).href },
      event = { senderFrame: frame, sender: { mainFrame: frame, isDestroyed: () => false } }
    const invoke = (channel: string, input: unknown) =>
      electron.handle.mock.calls.find((call) => call[0] === `learning:${channel}`)![1](event, input)
    expect(invoke('episode', { scope, episodeId: episode.id })).toMatchObject({ id: episode.id })
    expect(f.ledger.learningSubmissions.episodeTime(scope, episode.id)).toBe(episode.startedAt)
    await invoke('forget-scope', { scope })
    expect(f.store.list(scope)).toEqual([])
    expect(f.runtime.learningSubmissions(scope)).toMatchObject([{ state: 'forgotten' }])
    expect(f.ledger.learningSubmissions.episodeTime(scope, episode.id)).toBeUndefined()
    await expect(f.runtime.submitLearning(request)).rejects.toThrow('learning_submission_forgotten')
  })
})
