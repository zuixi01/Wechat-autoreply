import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { listenFetchLoopback } from '../fixtures/fetch-loopback'
import { createApplication } from '../../server/src/http/application'
import { AuthorityError } from '../../server/src/auth/account-authority'
import { taskFixture } from '../fixtures/task'
import { hashContext } from '../../src/core/reply/hashes'
import { ExecutionError } from '../../server/src/execution/execution-authority'
import { GenerationError } from '../../server/src/generation/publication'
import type { GenerationInput } from '../../src/shared/contracts/generation'
import { randomUUID } from 'node:crypto'

let server: Server
let base: string
const token = 'A'.repeat(43)
const scope = {
  tenant_id: 'company',
  employee_id: 'employee-A',
  account_id: 'account-A',
  agent_id: 'agent-A',
  platform: 'wework' as const
}
const authority = { register: vi.fn(), acquireLease: vi.fn(), heartbeat: vi.fn() }
const execution = { issue: vi.fn(), issueHuman: vi.fn(), settle: vi.fn() }
const generation = {
  generate: vi.fn(),
  reviewEdited: vi.fn(),
  configuration: vi.fn(),
  assessmentEvidence: vi.fn()
}
beforeEach(async () => {
  vi.resetAllMocks()
  authority.register.mockResolvedValue({ credential: token, scope })
  authority.heartbeat.mockResolvedValue(scope)
  authority.acquireLease.mockResolvedValue({ identity: taskFixture().task.identity, version: 1 })
  server = createServer(createApplication(authority, { execution, generation }))
  base = await listenFetchLoopback(server)
})
afterEach(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})
const post = (path: string, input: unknown, headers: Record<string, string> = {}) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify(input)
  })
describe('management API boundaries with mocked account authority', () => {
  it('requires authentication and a strict source reference for the read-only evidence endpoint', async () => {
    const f = taskFixture(),
      request = {
        taskId: f.task.taskId,
        contextHash: f.task.contextHash,
        knowledgeVersion: f.task.knowledgeVersion,
        draftHash: f.draft.draftHash,
        draftRevision: f.draft.draftRevision,
        offset: 0
      }
    generation.assessmentEvidence.mockResolvedValue({ totalAvailable: 0 })
    expect((await post('/v1/replies/evidence', request)).status).toBe(200)
    expect(generation.assessmentEvidence).toHaveBeenCalledWith(token, request)
    expect((await post('/v1/replies/evidence', request, { Authorization: '' })).status).toBe(401)
    for (const bad of [
      { ...request, tenantId: 'victim' },
      { ...request, evidenceId: 'secret' },
      { ...request, offset: 101 },
      { ...request, offset: -1 }
    ])
      expect((await post('/v1/replies/evidence', bad)).status).toBe(400)
    expect(generation.assessmentEvidence).toHaveBeenCalledOnce()
    expect(generation.generate).not.toHaveBeenCalled()
    expect(execution.issue).not.toHaveBeenCalled()
    expect(execution.issueHuman).not.toHaveBeenCalled()
  })
  it('keeps human confirmation on an authenticated strict endpoint and rejects forged extra approvals', async () => {
    const f = taskFixture(),
      input = {
        task: f.task,
        draft: f.draft,
        leaseVersion: 1,
        confirmation: {
          confirmationId: randomUUID(),
          taskId: f.task.taskId,
          sourceTaskId: 'source',
          taskHash: hashContext(f.task),
          draftHash: f.draft.draftHash,
          draftRevision: 1,
          employeeId: 'employee-A',
          modelResolved: 'jev-test-version',
          confirmedAt: 10000,
          expiresAt: 15000
        }
      }
    execution.issueHuman.mockResolvedValue({ purpose: 'human' })
    expect((await post('/v1/executions/issue-human', input)).status).toBe(201)
    expect(execution.issueHuman).toHaveBeenCalledWith(token, input)
    expect(execution.issue).not.toHaveBeenCalled()
    expect((await post('/v1/executions/issue-human', input, { Authorization: '' })).status).toBe(
      401
    )
    expect(
      (await post('/v1/executions/issue-human', { ...input, automaticAllowed: true })).status
    ).toBe(400)
    expect(execution.issueHuman).toHaveBeenCalledOnce()
  })
  function editedInput() {
    const context: GenerationInput['context'] = [
      { sequence: 1, sourceMessageId: 'm1', direction: 'inbound', kind: 'text', text: '合成问题' }
    ]
    return {
      generation: {
        task: {
          ...taskFixture().task,
          contextHash: hashContext(context),
          inboundRange: { from: 1, to: 1 }
        },
        context,
        inbound: ['合成问题']
      },
      edit: { text: '修改后的草稿', draftRevision: 2, evidenceIds: ['approved-source'] }
    }
  }
  it('authenticates and validates the complete edited assessment without routing it to generation or execution', async () => {
    const input = editedInput()
    generation.reviewEdited.mockResolvedValue({ automaticAllowed: false })
    expect((await post('/v1/replies/review-edited', input)).status).toBe(200)
    expect(generation.reviewEdited).toHaveBeenCalledWith(token, input, expect.any(AbortSignal))
    expect(generation.generate).not.toHaveBeenCalled()
    expect(execution.issue).not.toHaveBeenCalled()
    expect((await post('/v1/replies/review-edited', input, { Authorization: '' })).status).toBe(401)
    expect(generation.reviewEdited).toHaveBeenCalledOnce()
  })
  it('rejects stale text/context and forged execution fields before the edited provider call', async () => {
    const input = editedInput()
    for (const bad of [
      { ...input, automaticAllowed: true },
      { ...input, edit: { ...input.edit, review: { status: 'passed' } } },
      {
        ...input,
        generation: {
          ...input.generation,
          context: [{ ...input.generation.context[0], text: '替换客户消息' }]
        }
      }
    ])
      expect((await post('/v1/replies/review-edited', bad)).status).toBe(400)
    expect(generation.reviewEdited).not.toHaveBeenCalled()
  })
  it('accepts lease requests without trusting account fields from the caller', async () => {
    const input = { loginEpoch: 1, clientInstanceId: 'native-1' }
    expect((await post('/v1/leases/acquire', input)).status).toBe(200)
    expect(authority.acquireLease).toHaveBeenCalledWith(token, 1, 'native-1')
    expect(
      (await post('/v1/leases/acquire', { ...input, tenantId: 'victim', accountId: 'B' })).status
    ).toBe(400)
    expect(authority.acquireLease).toHaveBeenCalledTimes(1)
  })
  it('rejects missing authorization before creating any lease', async () => {
    expect(
      (
        await post(
          '/v1/leases/acquire',
          { loginEpoch: 1, clientInstanceId: 'native-1' },
          { Authorization: '' }
        )
      ).status
    ).toBe(401)
    expect(authority.acquireLease).not.toHaveBeenCalled()
  })
  it('rejects browser-origin requests from arbitrary sites', async () => {
    expect(
      (
        await post(
          '/v1/leases/acquire',
          { loginEpoch: 1, clientInstanceId: 'native-1' },
          { Origin: 'https://untrusted.example' }
        )
      ).status
    ).toBe(403)
    expect(authority.acquireLease).not.toHaveBeenCalled()
  })
  it('registers with a single code and rejects extra supplied identity fields', async () => {
    const input = { enrollmentCode: token, agentId: '0b6085d6-b0ae-4d5c-b2f5-beb6c5096fd2' }
    expect((await post('/v1/devices/register', input)).status).toBe(201)
    expect((await post('/v1/devices/register', { ...input, employeeId: 'other' })).status).toBe(400)
  })
  it('returns fixed errors without echoing keys, request data or upstream exceptions', async () => {
    authority.acquireLease.mockRejectedValue(
      new Error(`private customer data and credential ${token}`)
    )
    const response = await post('/v1/leases/acquire', {
      loginEpoch: 1,
      clientInstanceId: 'native-1'
    })
    expect(response.status).toBe(503)
    expect(await response.text()).toBe('{"error":"service_unavailable"}')
  })
  it('treats paused accounts as a conflict without issuing a grant', async () => {
    authority.acquireLease.mockRejectedValue(new AuthorityError('PAUSED'))
    expect(
      (await post('/v1/leases/acquire', { loginEpoch: 1, clientInstanceId: 'native-1' })).status
    ).toBe(409)
  })
  it('rate limits enrollment attempts and never stores credential-bearing request bodies', async () => {
    const input = { enrollmentCode: token, agentId: '0b6085d6-b0ae-4d5c-b2f5-beb6c5096fd2' }
    for (let i = 0; i < 10; i++)
      expect((await post('/v1/devices/register', input)).status).toBe(201)
    expect((await post('/v1/devices/register', input)).status).toBe(429)
  })
  it('accepts only a reference to a server-side review, rejecting client approval assertions', async () => {
    const f = taskFixture()
    const input = {
      taskId: f.task.taskId,
      taskHash: hashContext(f.task),
      draftHash: f.draft.draftHash,
      draftRevision: 1,
      loginEpoch: 1,
      clientInstanceId: 'process-A',
      leaseVersion: 1
    }
    execution.issue.mockResolvedValue({ permitId: 'test', newlyIssued: false })
    expect((await post('/v1/executions/issue', input)).status).toBe(201)
    expect(execution.issue).toHaveBeenCalledExactlyOnceWith(token, input)
    expect(
      (
        await post('/v1/executions/issue', {
          ...input,
          approved: true,
          review: { status: 'passed' }
        })
      ).status
    ).toBe(400)
    expect((await post('/v1/executions/approve', {})).status).toBe(404)
  })
  it('refuses to settle not_sent when dispatch started or quiescence is unknown', async () => {
    const input = {
      permitId: 'permit',
      draftHash: 'a'.repeat(64),
      status: 'not_sent',
      dispatchStarted: true,
      quiescent: false,
      verificationProofHash: 'b'.repeat(64)
    }
    expect((await post('/v1/executions/settle', input)).status).toBe(400)
    expect(execution.settle).not.toHaveBeenCalled()
    execution.settle.mockRejectedValue(new ExecutionError('PERMIT_CONFLICT'))
    const response = await post('/v1/executions/settle', {
      permitId: 'permit',
      draftHash: input.draftHash,
      status: 'unknown'
    })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'PERMIT_CONFLICT' })
  })
  it('checks conversation hashes and rejects client-supplied policy/knowledge overrides', async () => {
    const input = generationInput()
    generation.generate.mockResolvedValue({
      task: input.task,
      status: 'handoff',
      automaticAllowed: false,
      factsVerified: false,
      reasons: ['test'],
      intents: [],
      usage: { input_tokens: 0, output_tokens: 0 }
    })
    expect((await post('/v1/replies/generate', input)).status).toBe(200)
    expect(generation.generate.mock.calls[0].slice(0, 2)).toEqual([token, input])
    expect(
      (await post('/v1/replies/generate', { ...input, policy: { evaluationApproved: true } }))
        .status
    ).toBe(400)
    expect(
      (
        await post('/v1/replies/generate', {
          ...input,
          task: { ...input.task, contextHash: 'b'.repeat(64) }
        })
      ).status
    ).toBe(400)
    expect(generation.generate).toHaveBeenCalledTimes(1)
  })
  it('returns fixed overload errors and requires auth for configuration sync', async () => {
    generation.generate.mockRejectedValue(new GenerationError('GENERATION_OVERLOADED'))
    const response = await post('/v1/replies/generate', generationInput())
    expect(response.status).toBe(429)
    expect(await response.json()).toEqual({ error: 'GENERATION_OVERLOADED' })
    expect((await fetch(base + '/v1/configuration')).status).toBe(401)
    expect(generation.configuration).not.toHaveBeenCalled()
  })
  it('propagates HTTP connection cancellation into model work', async () => {
    let started!: () => void, stopped!: () => void
    const ready = new Promise<void>((resolve) => {
        started = resolve
      }),
      cancelled = new Promise<void>((resolve) => {
        stopped = resolve
      })
    generation.generate.mockImplementation(async (_token, _input, signal: AbortSignal) => {
      started()
      return new Promise((resolve) =>
        signal.addEventListener(
          'abort',
          () => {
            stopped()
            resolve(null)
          },
          { once: true }
        )
      )
    })
    const controller = new AbortController()
    const request = fetch(base + '/v1/replies/generate', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(generationInput())
    })
    const failed = expect(request).rejects.toThrow()
    await ready
    controller.abort()
    await failed
    await cancelled
    expect(generation.generate.mock.calls[0][2].aborted).toBe(true)
  })
})

function generationInput(): GenerationInput {
  const task = taskFixture().task
  const context: GenerationInput['context'] = [
    { sequence: 1, sourceMessageId: 'a', direction: 'inbound', kind: 'text', text: '一' },
    { sequence: 2, sourceMessageId: 'b', direction: 'inbound', kind: 'text', text: '二' }
  ]
  return { task: { ...task, contextHash: hashContext(context) }, context, inbound: ['一', '二'] }
}
