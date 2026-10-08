import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const electron = vi.hoisted(() => ({ handle: vi.fn(), window: vi.fn() }))
vi.mock('electron', () => ({
  ipcMain: { handle: electron.handle },
  BrowserWindow: { fromWebContents: electron.window }
}))
import { registerLearningIpc } from '../../src/main/ipc/learning-ipc'
import { LearningStore } from '../../src/core/memory/learning-store'
import { LearningService } from '../../src/main/services/learning-service'
const file = resolve('out/renderer/index.html')
const scope = { workspaceId: 'profile', platform: 'wechat' as const }
const stores: LearningStore[] = []
afterEach(() => {
  stores.splice(0).forEach((store) => store.close())
})
function event(url = pathToFileURL(file).href) {
  const frame = { url }
  return { senderFrame: frame, sender: { mainFrame: frame, isDestroyed: () => false } }
}
function invoke(channel: string, input?: unknown, sender = event()) {
  const handler = electron.handle.mock.calls.find((call) => call[0] === `learning:${channel}`)?.[1]
  if (!handler) throw new Error('handler_missing')
  return handler(sender, input)
}
function setup() {
  const store = new LearningStore(':memory:')
  stores.push(store)
  const service = new LearningService(
    store,
    { review: async () => ({ operations: [], usage: { inputTokens: 10, outputTokens: 10 } }) },
    { workspaceId: 'profile' }
  )
  registerLearningIpc(file, undefined, service, () => scope)
  return { store, service }
}
beforeEach(() => {
  electron.handle.mockClear()
  electron.window.mockReturnValue({})
})
describe('private learning IPC', () => {
  it('opens the exact authorized evidence despite disabled inference reading and refuses foreign or forgotten sources', () => {
    const { store } = setup()
    const memory = invoke('manual', {
      scope,
      sourceId: 'source-open',
      content: { kind: 'lesson', scenario: '来源核对', guidance: '先核对订单状态' },
      reason: '员工确认的核对顺序'
    })
    const id = store.history(scope, memory.id)[0].evidence[0].episodeId
    invoke('settings', { scope, patch: { memoryEnabled: false } })
    expect(invoke('episode', { scope, episodeId: id })).toMatchObject({
      id,
      scope,
      topic: '来源核对',
      correctionReason: '员工确认的核对顺序'
    })
    expect(() =>
      invoke('episode', { scope: { ...scope, platform: 'generic' }, episodeId: id })
    ).toThrow('evidence_scope_mismatch')
    expect(() => invoke('episode', { scope, episodeId: id, credential: 'forged' })).toThrow()
    invoke('forget-scope', { scope })
    expect(() => invoke('episode', { scope, episodeId: id })).toThrow('evidence_scope_mismatch')
  })
  it('lists only the scoped host directory and rejects unavailable review selections before saving', () => {
    const { service, store } = setup()
    electron.handle.mockClear()
    let directory = [{ id: 'review', label: '专用复盘模型' }]
    registerLearningIpc(
      file,
      undefined,
      service,
      () => scope,
      undefined,
      () => directory
    )
    expect(invoke('model-directory', { scope })).toEqual(directory)
    expect(
      invoke('settings', {
        scope,
        patch: { reviewModelId: 'review', dailyReviewTokenBudget: 9000, caseRetentionDays: 7 }
      })
    ).toMatchObject({ reviewModelId: 'review', dailyReviewTokenBudget: 9000, caseRetentionDays: 7 })
    directory = []
    expect(() =>
      invoke('settings', { scope, patch: { reviewModelId: 'review', caseRetentionDays: 30 } })
    ).toThrow('review_model_unavailable')
    expect(store.settings(scope).caseRetentionDays).toBe(7)
    expect(invoke('settings', { scope, patch: { reviewModelId: '' } }).reviewModelId).toBe('')
    expect(() => invoke('model-directory', { scope: { ...scope, workspaceId: 'other' } })).toThrow(
      'learning_scope_unavailable'
    )
    expect(() => invoke('model-directory', { scope, apiKey: 'forged' })).toThrow()
    expect(() => invoke('model-directory', { scope }, event('https://example.com'))).toThrow(
      'untrusted_sender'
    )
  })
  it('rejects secret-bearing and duplicate host directories instead of exposing them to the renderer', () => {
    const { service } = setup()
    for (const directory of [
      [{ id: 'review', label: '复盘', apiKey: 'private-host-key' }],
      [
        { id: 'review', label: '复盘' },
        { id: 'review', label: '重复' }
      ]
    ]) {
      electron.handle.mockClear()
      registerLearningIpc(
        file,
        undefined,
        service,
        () => scope,
        undefined,
        () => directory
      )
      expect(() => invoke('model-directory', { scope })).toThrow()
    }
  })
  it('saves manual evidence and its candidate atomically, with stable retries', () => {
    const { store } = setup()
    const input = {
      scope,
      sourceId: 'manual-teach-1',
      content: { kind: 'skill', scenario: '退款核对', guidance: '先核对订单', steps: ['核对状态'] },
      reason: '人工教导'
    }
    const memory = invoke('manual', input)
    expect(invoke('manual', input).id).toBe(memory.id)
    expect(store.episodes(scope)).toHaveLength(1)
    expect(store.list(scope)).toHaveLength(1)
    expect(() =>
      invoke('manual', { ...input, content: { ...input.content, steps: ['先核对付款'] } })
    ).toThrow('episode_source_conflict')
    const proposal = vi.spyOn(store, 'propose').mockImplementationOnce(() => {
      throw new Error('write_failed')
    })
    expect(() =>
      invoke('manual', { ...input, sourceId: 'manual-teach-2', reason: '第二次教导' })
    ).toThrow('write_failed')
    proposal.mockRestore()
    expect(store.episodes(scope)).toHaveLength(1)
    expect(store.searchEpisodes(scope, '退款核对', 3)).toHaveLength(1)
    invoke('forget-scope', { scope })
    expect(() => invoke('manual', input)).toThrow('episode_forgotten')
  })
  it('exposes calibration, search, reports, validation and curator through scoped named operations', async () => {
    const { store } = setup()
    const memory = invoke('manual', {
      scope,
      sourceId: 'teach',
      content: { kind: 'lesson', scenario: '订单核实', guidance: '核对订单状态' },
      reason: '员工确认'
    })
    const input = {
      humanConfirmed: true,
      cases: [
        {
          caseId: 'case-1',
          conversationId: 'independent-1',
          input: '订单现在怎样？',
          expectedMethod: '核对订单状态',
          forbiddenClaims: [],
          humanLabelled: true,
          labelOrigin: 'human' as const // Simulated human declaration for engineering tests only.
        }
      ]
    }
    expect(invoke('import-calibration', { scope, input })).toMatchObject({
      cases: input.cases,
      authorId: 'local-human:profile'
    })
    expect(invoke('calibration', { scope }).cases).toHaveLength(1)
    expect(invoke('search', { scope, query: '订单', limit: 3 })).toHaveLength(1)
    expect(invoke('search', { scope, query: '订单', limit: 10 })).toHaveLength(1)
    invoke('settings', { scope, patch: { memoryEnabled: false } })
    expect(invoke('search', { scope, query: '订单' })).toHaveLength(1)
    expect(store.searchEpisodes(scope, '订单', 3)).toEqual([])
    expect(invoke('reports', { scope })).toEqual({ validation: [], curation: [] })
    expect(await invoke('validate', { scope, id: memory.id, expectedRevision: 1 })).toMatchObject({
      status: 'insufficient',
      reasons: ['validation_unconfigured']
    })
    expect(await invoke('curate', { scope, dryRun: true })).toMatchObject({ dryRun: true })
    expect(store.active(scope)).toHaveLength(0)
    for (const [channel, value] of [
      ['calibration', {}],
      ['import-calibration', { input }],
      ['search', { query: '订单' }],
      ['reports', {}],
      ['validate', { id: memory.id, expectedRevision: 1 }],
      ['curate', { dryRun: true }]
    ] as const) {
      expect(() =>
        invoke(channel, { ...value, scope: { ...scope, workspaceId: 'other' } })
      ).toThrow('learning_scope_unavailable')
      expect(() =>
        invoke(channel, { ...value, scope, credential: 'renderer-cannot-set-this' })
      ).toThrow()
    }
  })
  it('routes named management through the host resolver before touching local data', async () => {
    const { service, store } = setup()
    electron.handle.mockClear()
    const enterprise = {
      workspaceId: 'enterprise:verified',
      tenantId: 'tenant',
      accountId: 'account',
      platform: 'wework' as const
    }
    const backend = {
      snapshot: vi.fn(async () => ({ scope: enterprise })),
      reports: vi.fn(async () => ({ validation: [], curation: [] }))
    }
    const resolveBackend = vi.fn(() => backend)
    registerLearningIpc(file, undefined, service, () => scope, resolveBackend as never)
    expect(await invoke('snapshot', {})).toEqual({ scope: enterprise })
    expect(resolveBackend).toHaveBeenCalledWith(undefined)
    expect(await invoke('reports', { scope: enterprise })).toEqual({ validation: [], curation: [] })
    expect(resolveBackend).toHaveBeenLastCalledWith(enterprise)
    expect(store.episodes(scope)).toEqual([])
    expect(() => invoke('reports', { scope: enterprise }, event('https://example.com'))).toThrow(
      'untrusted_sender'
    )
    resolveBackend.mockImplementation(() => {
      throw new Error('learning_scope_unavailable')
    })
    expect(() => invoke('snapshot', {})).toThrow('learning_scope_unavailable')
    expect(backend.snapshot).toHaveBeenCalledTimes(1)
  })
  it('checks the exact application frame before reading or mutating learning data', () => {
    setup()
    expect(() => invoke('snapshot', {}, event('https://example.com/'))).toThrow('untrusted_sender')
    const sender = event()
    sender.senderFrame = { url: sender.senderFrame.url }
    expect(() => invoke('snapshot', {}, sender)).toThrow('untrusted_sender')
    expect(() => invoke('snapshot', { scope: { ...scope, workspaceId: 'other' } })).toThrow(
      'learning_scope_unavailable'
    )
    expect(() => invoke('snapshot', { scope, extra: true })).toThrow()
  })
  it('provides scoped settings, candidate provenance and human revision controls', () => {
    const { store } = setup()
    const episode = store.recordEpisode(scope, {
      sourceId: 'manual',
      topic: '报价',
      startedAt: 1000,
      messages: [],
      outcome: 'corrected',
      identityStatus: 'account'
    })
    const memory = invoke('act', {
      scope,
      action: 'propose',
      content: { kind: 'lesson', scenario: '报价', guidance: '先确认型号' },
      evidence: [{ episodeId: episode.id }],
      reason: '员工填写方法'
    })
    expect(memory.state).toBe('pending')
    expect(invoke('snapshot', { scope }).memories[0].record.id).toBe(memory.id)
    expect(invoke('detail', { scope, id: memory.id }).history[0].evidence[0].episodeId).toBe(
      episode.id
    )
    invoke('act', { scope, action: 'activate', id: memory.id, expectedRevision: 1 })
    expect(store.active(scope)).toHaveLength(1)
    expect(() =>
      invoke('act', { scope, action: 'activate', id: memory.id, expectedRevision: 999 })
    ).toThrow('memory_revision_conflict')
    expect(() =>
      invoke('act', {
        scope,
        action: 'activate',
        id: memory.id,
        expectedRevision: 1,
        automatic: true
      })
    ).toThrow()
    invoke('settings', { scope, patch: { mode: 'off', memoryEnabled: false } })
    expect(store.settings(scope)).toMatchObject({ mode: 'off', memoryEnabled: false })
  })
  it('an employee correction creates a durable automatic review without touching sending', () => {
    const { store } = setup()
    const episode = store.recordEpisode(scope, {
      sourceId: 'draft',
      topic: '报价',
      startedAt: 1000,
      draft: '100元',
      messages: [],
      outcome: 'unknown'
    })
    invoke('correct', {
      scope,
      episodeId: episode.id,
      sourceId: 'edit',
      text: '请问型号和数量？',
      reason: '先了解需求'
    })
    expect(store.jobs.list(scope)[0].triggers).toEqual(['correction'])
    expect(store.active(scope)).toEqual([])
    expect(invoke('snapshot', { scope }).usage.requests).toBe(0)
  })
  it('a customer settings patch does not freeze unrelated inherited account controls', () => {
    const { store } = setup(),
      customer = { ...scope, conversationId: 'customer-a' }
    store.settings(scope, { ...store.settings(scope), dailyReviewTokenBudget: 12000 })
    invoke('settings', { scope: customer, patch: { mode: 'auto' } })
    store.settings(scope, { ...store.settings(scope), dailyReviewTokenBudget: 25000 })
    expect(store.settings(customer)).toMatchObject({ mode: 'auto', dailyReviewTokenBudget: 25000 })
  })
  it('employee feedback cannot submit arbitrary references or claim a platform confirmation', () => {
    const { service, store } = setup()
    const episode = service.onDraft(
      {
        screenshot: '',
        appType: 'wechat',
        extractedText: '报价',
        learningGenerationId: 'generation'
      },
      null,
      '草稿',
      scope
    )
    const input = {
      scope,
      episodeId: episode.id,
      sourceId: 'employee',
      kind: 'adopted',
      reason: '确认采用'
    }
    invoke('feedback', input)
    invoke('feedback', input)
    expect(store.feedbackEvents(scope).filter((event) => event.kind === 'adopted')).toHaveLength(1)
    expect(() =>
      invoke('feedback', { ...input, memoryRefs: [{ id: 'forged', revision: 1 }] })
    ).toThrow()
    expect(() => invoke('feedback', { ...input, kind: 'delivery_confirmed' })).toThrow()
    expect(() =>
      invoke('result', {
        scope,
        episodeId: episode.id,
        sourceId: 'result',
        outcome: 'resolved',
        reason: ''
      })
    ).toThrow()
    expect(() =>
      invoke('result', {
        scope: { ...scope, workspaceId: 'other' },
        episodeId: episode.id,
        sourceId: 'result',
        outcome: 'resolved',
        reason: '核实'
      })
    ).toThrow('learning_scope_unavailable')
    invoke('result', {
      scope,
      episodeId: episode.id,
      sourceId: 'result',
      outcome: 'resolved',
      reason: '员工核实处理结果'
    })
    expect(store.jobs.list(scope)[0].triggers).toEqual(['completed'])
  })
})
