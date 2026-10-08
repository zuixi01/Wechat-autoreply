import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AgentRegistration,
  type EncryptedDeviceRecord
} from '../../src/main/services/agent-registration'
import { DesktopAgentRuntime } from '../../src/main/services/desktop-agent-runtime'
import { Ledger } from '../../src/core/persistence/ledger'
import { LearningSettingsSchema } from '../../src/shared/contracts/learning-memory'
import { learningHash } from '../../src/core/memory/learning-scope'

const scope = {
  workspaceId: `enterprise:${learningHash({ tenant: 'company', account: 'account-A' })}`,
  tenantId: 'company',
  accountId: 'account-A',
  platform: 'wework' as const
}
const snapshot = {
  scope,
  scopes: [scope],
  settings: LearningSettingsSchema.parse({}),
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
const runtimes: DesktopAgentRuntime[] = []
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()))
})
function setup() {
  let record: EncryptedDeviceRecord = {
    serverUrl: 'https://enterprise.example',
    encryptedCredential: 'cipher',
    scope: {
      tenant_id: 'company',
      employee_id: 'employee-A',
      account_id: 'account-A',
      agent_id: 'agent-A',
      platform: 'wework'
    }
  }
  const transport = vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify(snapshot), { status: 200 })
  )
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
  const runtime = new DesktopAgentRuntime(new Ledger(':memory:'), client)
  runtimes.push(runtime)
  return {
    runtime,
    transport,
    change: () => {
      record = { ...record, scope: { ...record.scope, agent_id: 'agent-new' } }
    }
  }
}
describe('enterprise learning desktop backend', () => {
  it('forget cancels pending private reads and prevents new management requests until confirmation', async () => {
    const { runtime, transport } = setup()
    let confirm!: (value: Response) => void
    transport.mockImplementation(async (url) => {
      if (String(url).endsWith('/forget-scope'))
        return new Promise((resolve) => {
          confirm = resolve
        })
      return new Promise(() => {})
    })
    const backend = runtime.learningBackend()!
    const read = backend.snapshot()
    const rejected = expect(read).rejects.toThrow()
    const forgotten = backend.forgetScope({ scope })
    await vi.waitFor(() => expect(confirm).toBeTypeOf('function'))
    try {
      expect(() => backend.reports({ scope })).toThrow('learning_forget_in_progress')
      expect(transport).toHaveBeenCalledTimes(2)
    } finally {
      confirm(new Response(JSON.stringify({ forgotten: true }), { status: 200 }))
      await forgotten
      await rejected
    }
  })
  it('defaults to current authenticated enterprise state and keeps explicit local scope separate', async () => {
    const { runtime, transport } = setup()
    const backend = runtime.learningBackend()!
    expect(await backend.snapshot()).toEqual(snapshot)
    expect(JSON.parse(transport.mock.calls[0][1]!.body as string)).toEqual({ conversationId: null })
    expect(runtime.learningBackend({ workspaceId: 'local-profile', platform: 'wechat' })).toBeNull()
    expect(() => runtime.learningBackend({ ...scope, accountId: 'account-B' })).toThrow(
      'learning_scope_unavailable'
    )
    expect(() => runtime.learningBackend({ ...scope, workspaceId: 'enterprise:forged' })).toThrow(
      'learning_scope_unavailable'
    )
    expect(transport).toHaveBeenCalledTimes(1)
    await expect(
      backend.assignLegacy({ scope, legacyId: 'old', sourceId: 'intent' })
    ).rejects.toThrow('enterprise_legacy_assignment_unavailable')
    expect(transport).toHaveBeenCalledTimes(1)
  })
  it('rejects late replies when the current device changes', async () => {
    const { runtime, transport, change } = setup()
    let finish!: (value: Response) => void
    transport.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const read = runtime.learningBackend()!.snapshot()
    const checked = expect(read).rejects.toThrow('DEVICE_SCOPE_CHANGED')
    change()
    finish(new Response(JSON.stringify(snapshot), { status: 200 }))
    await checked
  })
  it('cancels a noncooperative management read before closing or changing devices', async () => {
    for (const action of ['close', 'deviceChanged'] as const) {
      const { runtime, transport } = setup()
      let signal!: AbortSignal
      transport.mockImplementation((_url, init) => {
        signal = init!.signal as AbortSignal
        return new Promise(() => {})
      })
      const read = runtime.learningBackend()!.snapshot()
      const checked = expect(read).rejects.toThrow()
      await runtime[action]()
      expect(signal.aborted).toBe(true)
      await checked
      if (action === 'close')
        expect(() => runtime.learningBackend()).toThrow('learning_scope_unavailable')
    }
  })
})
