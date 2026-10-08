import { describe, expect, it, vi } from 'vitest'
import {
  AgentRegistration,
  type EncryptedDeviceRecord
} from '../../src/main/services/agent-registration'
import {
  LearningSettingsSchema,
  MemoryContentSchema,
  LearningEpisodeSchema
} from '../../src/shared/contracts/learning-memory'
import { learningHash } from '../../src/core/memory/learning-scope'

const scope = {
  workspaceId: `enterprise:${learningHash({ tenant: 'company', account: 'account-A' })}`,
  tenantId: 'company',
  accountId: 'account-A',
  platform: 'wework' as const
}
const customer = { ...scope, conversationId: 'customer-A' }
const settings = LearningSettingsSchema.parse({})
const snapshot = {
  scope: customer,
  scopes: [scope, customer],
  settings,
  memories: [],
  episodes: [],
  jobs: [],
  usage: {
    reservedTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    requests: 0,
    estimatedRequests: 0,
    reportedRequests: 0,
    day: '2026-10-05'
  },
  unassigned: []
}
const content = MemoryContentSchema.parse({
  kind: 'lesson',
  scenario: '退款核对',
  guidance: '先核对订单状态，再查询当前政策。',
  rationale: '避免遗漏状态核对'
})
const memory = {
  id: 'memory-1',
  scope: customer,
  state: 'pending',
  currentRevision: 1,
  activeRevision: null,
  pinned: false,
  content,
  createdAt: 1,
  updatedAt: 1
}
const revision = {
  memoryId: memory.id,
  revision: 1,
  contentHash: 'a'.repeat(64),
  content,
  evidence: [{ episodeId: 'episode-1' }],
  source: 'manual',
  reason: '员工教导',
  createdAt: 1,
  activatedAt: null
}
const episode = LearningEpisodeSchema.parse({
  id: '11111111-1111-4111-8111-111111111111',
  scope: customer,
  sourceId: 'original',
  topic: '退款核对',
  startedAt: 1,
  createdAt: 1,
  messages: [{ sourceId: 'message-1', role: 'customer', text: '怎么退款？' }],
  outcome: 'unknown'
})
const managementCases = [
  {
    name: 'episode',
    call: (client: AgentRegistration) => client.learningEpisode(customer, episode.id),
    body: { conversationId: 'customer-A', episodeId: episode.id },
    response: episode
  },
  {
    name: 'model-directory',
    call: (client: AgentRegistration) => client.learningModelDirectory(customer),
    body: { conversationId: 'customer-A' },
    response: [{ id: 'review', label: '专用复盘模型' }]
  },
  {
    name: 'detail',
    call: (client: AgentRegistration) => client.learningDetail(customer, memory.id),
    body: { conversationId: 'customer-A', id: memory.id },
    response: { memory, history: [revision] }
  },
  {
    name: 'action',
    call: (client: AgentRegistration) =>
      client.learningAct({
        scope: customer,
        action: 'pin',
        id: memory.id,
        expectedRevision: 1,
        pinned: true
      }),
    body: {
      conversationId: 'customer-A',
      command: { action: 'pin', id: memory.id, expectedRevision: 1, pinned: true }
    },
    response: { ...memory, pinned: true }
  },
  {
    name: 'manual',
    call: (client: AgentRegistration) =>
      client.learningManual(customer, { sourceId: 'manual-1', content, reason: '员工教导' }),
    body: { conversationId: 'customer-A', sourceId: 'manual-1', content, reason: '员工教导' },
    response: memory
  },
  {
    name: 'review',
    call: (client: AgentRegistration) =>
      client.learningReview(customer, {
        episodeId: '22222222-2222-4222-8222-222222222222',
        sourceId: 'review-1'
      }),
    body: {
      conversationId: 'customer-A',
      episodeId: '22222222-2222-4222-8222-222222222222',
      sourceId: 'review-1'
    },
    response: { jobId: '33333333-3333-4333-8333-333333333333' }
  },
  {
    name: 'cancel',
    call: (client: AgentRegistration) =>
      client.learningCancel(customer, '33333333-3333-4333-8333-333333333333'),
    body: { conversationId: 'customer-A', jobId: '33333333-3333-4333-8333-333333333333' },
    response: { cancelled: true }
  },
  {
    name: 'calibration',
    call: (client: AgentRegistration) =>
      client.learningCalibration(customer, { cases: [], humanConfirmed: true }),
    body: { conversationId: 'customer-A', input: { cases: [], humanConfirmed: true } },
    response: { cases: [], authorId: 'employee-A', importedAt: 1 }
  },
  {
    name: 'reports',
    call: (client: AgentRegistration) => client.learningReports(customer),
    body: { conversationId: 'customer-A' },
    response: {
      validation: [
        {
          id: 'report-1',
          memoryId: memory.id,
          revision: 1,
          createdAt: 1,
          result: { status: 'insufficient', reasons: ['人工标注不足'], caseCount: 0 }
        }
      ],
      curation: [{ runId: 'curation-1', dryRun: true, status: 'waiting', createdAt: 1, items: [] }]
    }
  },
  {
    name: 'search',
    call: (client: AgentRegistration) => client.learningSearch(customer, '退款'),
    body: { conversationId: 'customer-A', query: '退款', limit: 10 },
    response: [episode]
  },
  {
    name: 'validate',
    call: (client: AgentRegistration) => client.learningValidate(customer, memory.id, 1),
    body: { conversationId: 'customer-A', id: memory.id, expectedRevision: 1 },
    response: { status: 'insufficient', reasons: ['人工标注不足'], caseCount: 0 }
  },
  {
    name: 'curate',
    call: (client: AgentRegistration) => client.learningCurate(customer, true),
    body: { conversationId: 'customer-A', dryRun: true },
    response: { runId: 'curation-1', dryRun: true, status: 'waiting', createdAt: 1, items: [] }
  }
]
function fixture() {
  let record: EncryptedDeviceRecord = {
    serverUrl: 'https://enterprise.example',
    encryptedCredential: 'private-ciphertext',
    scope: {
      tenant_id: 'company',
      account_id: 'account-A',
      employee_id: 'employee-A',
      agent_id: 'agent-A',
      platform: 'wework'
    }
  }
  const transport = vi.fn<typeof fetch>(async () => Response.json(snapshot))
  const client = new AgentRegistration(
    {
      load: () => record,
      save: (value) => {
        record = value
      }
    },
    { available: () => true, encrypt: () => '', decrypt: () => 'A'.repeat(43) },
    transport
  )
  return {
    client,
    transport,
    change: () => {
      record = { ...record, scope: { ...record.scope, account_id: 'account-B' } }
    }
  }
}
describe('enterprise desktop memory management transport', () => {
  it('accepts scoped publication metadata and rejects another account publication status', async () => {
    const f = fixture()
    const publication = {
      tenantId: scope.tenantId,
      accountId: scope.accountId,
      state: 'unpublished',
      currentMemoryCorpusVersion: 'empty-enterprise-memory-v1',
      currentMethodCount: 0,
      serverPaused: true,
      published: null
    }
    f.transport.mockResolvedValueOnce(Response.json({ ...snapshot, publication }))
    expect((await f.client.learningSnapshot(customer)).publication).toEqual(publication)
    for (const patch of [
      { accountId: 'foreign' },
      { tenantId: 'foreign' },
      { state: 'current' },
      { privateEvidence: 'secret' }
    ]) {
      f.transport.mockResolvedValueOnce(
        Response.json({ ...snapshot, publication: { ...publication, ...patch } })
      )
      await expect(f.client.learningSnapshot(customer)).rejects.toMatchObject({
        code: 'INVALID_RESPONSE'
      })
    }
  })
  it('accepts a valid large manual method while keeping credential response limits bounded', async () => {
    const f = fixture(),
      large = MemoryContentSchema.parse({
        ...content,
        steps: Array.from({ length: 30 }, () => '核'.repeat(1000))
      })
    f.transport.mockImplementation(async () => Response.json({ ...memory, content: large }))
    expect(
      await f.client.learningManual(customer, {
        sourceId: 'large-manual',
        content: large,
        reason: '实际方法'
      })
    ).toMatchObject({ content: large })
  })
  it.each(managementCases)(
    'dispatches and parses the named $name management operation',
    async (value) => {
      const f = fixture()
      f.transport.mockImplementation(async () => Response.json(value.response))
      const result = await value.call(f.client)
      expect(result).toEqual(value.name === 'cancel' ? undefined : value.response)
      expect(String(f.transport.mock.calls[0][0])).toBe(
        `https://enterprise.example/v1/learning/${value.name}`
      )
      expect(JSON.parse(String(f.transport.mock.calls[0][1]?.body))).toEqual(value.body)
    }
  )
  it.each(managementCases)(
    'rejects malformed or credential-bearing $name responses',
    async (value) => {
      const f = fixture()
      f.transport.mockImplementation(async () => Response.json({ credential: 'not-for-renderer' }))
      await expect(value.call(f.client)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    }
  )
  it.each(managementCases)(
    'rejects a $name result when the registered account changes in flight',
    async (value) => {
      const f = fixture()
      f.transport.mockImplementation(async () => {
        f.change()
        return Response.json(value.response)
      })
      await expect(value.call(f.client)).rejects.toMatchObject({ code: 'DEVICE_SCOPE_CHANGED' })
    }
  )
  it('rejects structurally valid foreign records, history and search results', async () => {
    const f = fixture()
    for (const response of [
      { memory: { ...memory, scope: { ...customer, accountId: 'foreign' } }, history: [revision] },
      { memory, history: [{ ...revision, memoryId: 'foreign' }] }
    ]) {
      f.transport.mockImplementation(async () => Response.json(response))
      await expect(f.client.learningDetail(customer, memory.id)).rejects.toMatchObject({
        code: 'INVALID_RESPONSE'
      })
    }
    f.transport.mockImplementation(async () =>
      Response.json([{ ...episode, scope: { ...customer, conversationId: 'foreign' } }])
    )
    await expect(f.client.learningSearch(customer, '退款')).rejects.toMatchObject({
      code: 'INVALID_RESPONSE'
    })
    for (const response of [
      { ...episode, id: 'foreign' },
      { ...episode, scope: { ...customer, conversationId: 'foreign' } }
    ]) {
      f.transport.mockResolvedValueOnce(Response.json(response))
      await expect(f.client.learningEpisode(customer, episode.id)).rejects.toMatchObject({
        code: 'INVALID_RESPONSE'
      })
    }
  })
  it('rejects secret fields and duplicate IDs in the authoritative model directory', async () => {
    const f = fixture()
    for (const response of [
      [{ id: 'review', label: '复盘', apiKey: 'must-not-leak' }],
      [{ id: 'review', label: '复盘', baseURL: 'https://arbitrary.example' }],
      [
        { id: 'review', label: '复盘' },
        { id: 'review', label: '重复' }
      ],
      [{ id: '', label: '无标识' }]
    ]) {
      f.transport.mockResolvedValueOnce(Response.json(response))
      await expect(f.client.learningModelDirectory(customer)).rejects.toMatchObject({
        code: 'INVALID_RESPONSE'
      })
    }
  })
  it('rejects invalid management inputs before sending and does not allow an ordinary action to return null', async () => {
    const f = fixture()
    await expect(f.client.learningSearch(customer, '')).rejects.toBeDefined()
    await expect(f.client.learningValidate(customer, memory.id, 0)).rejects.toBeDefined()
    await expect(
      f.client.learningManual(customer, {
        sourceId: 'manual-1',
        content,
        reason: '员工教导',
        scope
      } as never)
    ).rejects.toBeDefined()
    expect(f.transport).not.toHaveBeenCalled()
    f.transport.mockImplementation(async () => Response.json(null))
    await expect(
      f.client.learningAct({
        scope: customer,
        action: 'pin',
        id: memory.id,
        expectedRevision: 1,
        pinned: true
      })
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    expect(
      await f.client.learningAct({
        scope: customer,
        action: 'forget',
        id: memory.id,
        expectedRevision: 1
      })
    ).toBeNull()
  })
  it('reads an authoritative customer snapshot with only a conversation selector and host-held authentication', async () => {
    const f = fixture()
    expect(await f.client.learningSnapshot(customer)).toEqual(snapshot)
    expect(String(f.transport.mock.calls[0][0])).toBe(
      'https://enterprise.example/v1/learning/snapshot'
    )
    expect(JSON.parse(String(f.transport.mock.calls[0][1]?.body))).toEqual({
      conversationId: 'customer-A'
    })
    expect(String(f.transport.mock.calls[0][1]?.body)).not.toContain('private-ciphertext')
  })
  it.each([
    { ...customer, workspaceId: 'local-profile' },
    { ...customer, accountId: 'account-B' },
    { ...customer, tenantId: 'other' },
    { ...customer, platform: 'wechat' as const },
    { ...customer, apiKey: 'forged' }
  ])('rejects a forged management scope before dispatch: %j', async (candidate) => {
    const f = fixture()
    await expect(f.client.learningSnapshot(candidate)).rejects.toBeDefined()
    expect(f.transport).not.toHaveBeenCalled()
  })
  it.each([
    { ...snapshot, scope: { ...customer, accountId: 'foreign' } },
    { ...snapshot, scopes: [{ ...scope, accountId: 'foreign' }] },
    {
      ...snapshot,
      episodes: [{ id: 'forged', scope: { ...customer, conversationId: 'foreign' } }]
    },
    { ...snapshot, settings: {} },
    { ...snapshot, usage: { ...snapshot.usage, inputTokens: -1 } },
    { ...snapshot, credential: 'not-for-renderer' }
  ])(
    'rejects foreign nested data and incomplete or unexpected management response: %j',
    async (response) => {
      const f = fixture()
      f.transport.mockResolvedValue(Response.json(response))
      await expect(f.client.learningSnapshot(customer)).rejects.toMatchObject({
        code: 'INVALID_RESPONSE'
      })
    }
  )
  it('does not release a valid old snapshot after registration changes during the request', async () => {
    const f = fixture()
    f.transport.mockImplementation(async () => {
      f.change()
      return Response.json(snapshot)
    })
    await expect(f.client.learningSnapshot(customer)).rejects.toMatchObject({
      code: 'DEVICE_SCOPE_CHANGED'
    })
  })
  it('strictly validates settings reads and patches without accepting a renderer model endpoint', async () => {
    const f = fixture()
    f.transport.mockImplementation(async () => Response.json(settings))
    expect(await f.client.learningSettings(customer)).toEqual(settings)
    expect(JSON.parse(String(f.transport.mock.calls[0][1]?.body))).toEqual({
      conversationId: 'customer-A'
    })
    expect(await f.client.learningSettings(scope, { caseRetentionDays: 7 })).toEqual(settings)
    expect(JSON.parse(String(f.transport.mock.calls[1][1]?.body))).toEqual({
      conversationId: null,
      patch: { caseRetentionDays: 7 }
    })
    await expect(
      f.client.learningSettings(scope, { apiKey: 'forged' } as never)
    ).rejects.toBeDefined()
    expect(f.transport).toHaveBeenCalledTimes(2)
    f.transport.mockResolvedValue(Response.json({}))
    await expect(f.client.learningSettings(scope)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE'
    })
  })
  it('forgets only the selected authoritative scope and requires the server acknowledgment', async () => {
    const f = fixture()
    f.transport.mockResolvedValue(Response.json({ forgotten: true }))
    await f.client.learningForgetScope(customer)
    expect(JSON.parse(String(f.transport.mock.calls[0][1]?.body))).toEqual({
      conversationId: 'customer-A'
    })
    f.transport.mockResolvedValue(Response.json({ success: true, grant: 'forged' }))
    await expect(f.client.learningForgetScope(customer)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE'
    })
    f.transport.mockResolvedValue(Response.json(null))
    await expect(f.client.learningForgetScope(customer)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE'
    })
  })
})
