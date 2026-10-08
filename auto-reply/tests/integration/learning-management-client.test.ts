import { describe, expect, it, vi } from 'vitest'
import {
  AgentRegistration,
  type EncryptedDeviceRecord
} from '../../src/main/services/agent-registration'
import { taskFixture } from '../fixtures/task'
import { learningHash } from '../../src/core/memory/learning-scope'

const fixture = taskFixture(),
  token = 'A'.repeat(43)
const input = { sourceId: 'employee-correction-1', text: '先核对订单状态', reason: '员工明确纠正' }
const episode = {
  id: 'source-episode',
  sourceId: 'task-event:synthetic',
  identityStatus: 'verified',
  topic: '退款',
  startedAt: 9000,
  endedAt: 10000,
  createdAt: 10000,
  messages: [],
  draft: fixture.draft.text,
  correction: input.text,
  correctionReason: input.reason,
  outcome: 'corrected',
  scope: {
    workspaceId: `enterprise:${learningHash({ tenant: 'company', account: 'account-A' })}`,
    tenantId: 'company',
    accountId: 'account-A',
    platform: 'wework',
    conversationId: fixture.task.conversationId
  }
}
function setup() {
  let record: EncryptedDeviceRecord = {
    serverUrl: 'https://enterprise.example',
    scope: {
      tenant_id: 'company',
      account_id: 'account-A',
      employee_id: 'employee-A',
      agent_id: 'agent-A',
      platform: 'wework'
    },
    encryptedCredential: 'private-ciphertext'
  }
  const transport = vi.fn<typeof fetch>(async () => Response.json(episode))
  const client = new AgentRegistration(
    {
      load: () => record,
      save: (value) => {
        record = value
      }
    },
    { available: () => true, encrypt: () => '', decrypt: () => token },
    transport
  )
  return {
    client,
    transport,
    change: () => {
      record = { ...record, scope: { ...record.scope, account_id: 'other-account' } }
    }
  }
}
describe('main-process task-bound learning transport', () => {
  it('identifies an unavailable authoritative learning source as terminal rather than a network outage', async () => {
    const f = setup()
    f.transport.mockResolvedValue(
      Response.json({ error: 'learning_evidence_unavailable' }, { status: 404 })
    )
    await expect(
      f.client.recordLearningCorrection(fixture.task, fixture.draft, input)
    ).rejects.toMatchObject({ code: 'TASK_INVALIDATED' })
  })
  it('builds a correction reference from the actual task and draft and keeps credentials out of the body and response', async () => {
    const f = setup(),
      result = await f.client.recordLearningCorrection(fixture.task, fixture.draft, input)
    expect(result).toEqual(episode)
    expect(f.transport).toHaveBeenCalledOnce()
    const [url, request] = f.transport.mock.calls[0]
    expect(String(url)).toBe('https://enterprise.example/v1/learning/correction')
    expect(request?.headers).toMatchObject({ Authorization: `Bearer ${token}` })
    expect(JSON.parse(String(request?.body))).toEqual({
      ...input,
      reference: {
        taskId: fixture.task.taskId,
        contextHash: fixture.task.contextHash,
        draftHash: fixture.draft.draftHash,
        draftRevision: fixture.draft.draftRevision
      }
    })
    expect(String(request?.body)).not.toContain(token)
    expect(JSON.stringify(result)).not.toContain('private-ciphertext')
  })
  it('provides separate explicit result and feedback operations without inferring sending or adoption', async () => {
    const f = setup()
    f.transport.mockResolvedValueOnce(Response.json({ ...episode, outcome: 'handoff' }))
    expect(
      await f.client.recordLearningResult(fixture.task, fixture.draft, {
        sourceId: 'result-1',
        outcome: 'handoff',
        reason: '明确转人工'
      })
    ).toMatchObject({ outcome: 'handoff' })
    f.transport.mockResolvedValueOnce(Response.json(null))
    await expect(
      f.client.recordLearningFeedback(fixture.task, fixture.draft, {
        sourceId: 'adopt-1',
        kind: 'adopted',
        reason: '明确采纳'
      })
    ).resolves.toBeUndefined()
    expect(f.transport.mock.calls.map(([url]) => String(url).split('/').at(-1))).toEqual([
      'result',
      'feedback'
    ])
  })
  it.each([
    { ...episode, scope: { ...episode.scope, accountId: 'foreign' } },
    { ...episode, scope: { ...episode.scope, conversationId: 'foreign' } },
    { ...episode, scope: { ...episode.scope, workspaceId: 'foreign' } },
    { ...episode, correction: 'unrelated employee text' },
    { ...episode, draft: 'a different original draft' },
    { ...episode, credential: token }
  ])('refuses malformed or differently bound correction replies %#', async (response) => {
    const f = setup()
    f.transport.mockResolvedValue(Response.json(response))
    await expect(
      f.client.recordLearningCorrection(fixture.task, fixture.draft, input)
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
  it('refuses local draft forgery and extra scope assertions before dispatch', async () => {
    const f = setup()
    await expect(
      f.client.recordLearningCorrection(fixture.task, { ...fixture.draft, text: 'forged' }, input)
    ).rejects.toThrow()
    await expect(
      f.client.recordLearningCorrection(fixture.task, fixture.draft, {
        ...input,
        scope: {}
      } as typeof input)
    ).rejects.toThrow()
    expect(f.transport).not.toHaveBeenCalled()
  })
  it('rejects account changes before dispatch and while a response is arriving', async () => {
    const before = setup()
    before.change()
    await expect(
      before.client.recordLearningCorrection(fixture.task, fixture.draft, input)
    ).rejects.toMatchObject({ code: 'DEVICE_SCOPE_CHANGED' })
    expect(before.transport).not.toHaveBeenCalled()
    const during = setup()
    during.transport.mockImplementation(async () => {
      during.change()
      return Response.json(episode)
    })
    await expect(
      during.client.recordLearningCorrection(fixture.task, fixture.draft, input)
    ).rejects.toMatchObject({ code: 'DEVICE_SCOPE_CHANGED' })
    expect(during.transport).toHaveBeenCalledOnce()
  })
})
