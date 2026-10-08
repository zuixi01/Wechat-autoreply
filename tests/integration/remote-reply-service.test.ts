import { describe, expect, it, vi } from 'vitest'
import {
  AgentRegistration,
  type EncryptedDeviceRecord
} from '../../src/main/services/agent-registration'
import { RemoteReplyService } from '../../src/core/agent/remote-reply-service'
import { taskFixture } from '../fixtures/task'
import { hashContext, hashDraft } from '../../src/core/reply/hashes'
import type { GenerationInput, GenerationResult } from '../../src/shared/contracts/generation'
import { explainAssessment } from '../../server/src/generation/assessment-explanation'

function fixture() {
  const f = taskFixture(),
    now = Date.now()
  const context: GenerationInput['context'] = [
    { sequence: 1, sourceMessageId: 'm1', direction: 'inbound', kind: 'text', text: '第一问' },
    { sequence: 2, sourceMessageId: 'm2', direction: 'inbound', kind: 'text', text: ' 第二问 ' }
  ]
  const task = {
    ...f.task,
    contextHash: hashContext(context),
    createdAt: now - 1000,
    expiresAt: now + 50000
  }
  const scope = {
    tenant_id: 'company',
    employee_id: 'employee-A',
    account_id: 'account-A',
    agent_id: 'agent-A',
    platform: 'wework' as const
  }
  let record: EncryptedDeviceRecord = {
    serverUrl: 'https://enterprise.example',
    scope,
    encryptedCredential: 'synthetic-cipher'
  }
  const input: GenerationInput = { task, context, inbound: context.map((m) => m.text) }
  const result: GenerationResult = {
    task,
    status: 'candidate',
    draft: f.draft,
    review: {
      ...f.review,
      contextHash: task.contextHash,
      reviewedAt: now - 500,
      expiresAt: now + 10000
    },
    automaticAllowed: true,
    factsVerified: true,
    reasons: [],
    intents: ['faq'],
    usage: { input_tokens: 1, output_tokens: 1 }
  }
  const transport = vi.fn<typeof fetch>(async () => Response.json(result))
  const registration = new AgentRegistration(
    {
      load: () => record,
      save: (r) => {
        record = r
      }
    },
    { available: () => true, encrypt: () => '', decrypt: () => 'A'.repeat(43) },
    transport
  )
  const service = new RemoteReplyService(registration)
  return {
    task,
    input,
    result,
    transport,
    registration,
    service,
    record: () => record,
    setRecord: (next: EncryptedDeviceRecord) => {
      record = next
    }
  }
}
describe('main-process authenticated remote reply transport', () => {
  it('prepares the complete learning binding with the same authenticated input before generation', async () => {
    const f = fixture()
    const prepared = {
      ...f.task,
      memoryCorpusVersion: 'empty-enterprise-memory-v1',
      memorySnapshotHash: '1'.repeat(64),
      learningContextVersion: '2'.repeat(64)
    }
    f.transport.mockResolvedValueOnce(Response.json(prepared))
    expect(
      await f.service.prepare(
        f.task,
        f.input.inbound,
        () => true,
        new AbortController().signal,
        f.input.context
      )
    ).toEqual(prepared)
    const [url, options] = f.transport.mock.calls[0]
    expect(String(url)).toBe('https://enterprise.example/v1/replies/prepare')
    expect(JSON.parse(String(options?.body))).toEqual(f.input)
    expect(new Headers(options?.headers).get('authorization')).toBe('Bearer ' + 'A'.repeat(43))
    expect(f.transport).toHaveBeenCalledTimes(1)
  })
  it('rejects a preparation response that changes immutable task data or has a partial binding', async () => {
    const f = fixture()
    f.transport.mockResolvedValueOnce(
      Response.json({
        ...f.task,
        conversationId: 'other',
        memoryCorpusVersion: 'empty-enterprise-memory-v1',
        memorySnapshotHash: '1'.repeat(64),
        learningContextVersion: '2'.repeat(64)
      })
    )
    await expect(f.registration.prepareGeneration(f.input)).rejects.toThrow('INVALID_RESPONSE')
    f.transport.mockResolvedValueOnce(
      Response.json({ ...f.task, memoryCorpusVersion: 'empty-enterprise-memory-v1' })
    )
    await expect(f.registration.prepareGeneration(f.input)).rejects.toThrow()
  })
  it('reads a full bounded Chinese reference with source bindings, without calling generation or execution', async () => {
    const f = fixture(),
      draft = { ...f.result.draft!, evidenceIds: ['faq'] },
      now = Date.now()
    const request = {
      taskId: f.task.taskId,
      contextHash: f.task.contextHash,
      knowledgeVersion: f.task.knowledgeVersion,
      draftHash: draft.draftHash,
      draftRevision: draft.draftRevision,
      offset: 0
    }
    const page = {
      ...request,
      assessedAt: now,
      totalAvailable: 1,
      unavailableReferences: 0,
      evidence: [
        {
          evidenceId: 'faq',
          intent: 'faq',
          kind: 'approved_faq',
          source: '源'.repeat(2000),
          content: '据'.repeat(20000),
          validFrom: now - 1000,
          expiresAt: now + 10000
        }
      ]
    }
    expect(Buffer.byteLength(JSON.stringify(page))).toBeGreaterThan(65536)
    f.transport.mockImplementation(async (url, options) => {
      expect(new URL(String(url)).pathname).toBe('/v1/replies/evidence')
      expect(JSON.parse(options!.body as string)).toEqual(request)
      expect(options!.headers).toMatchObject({ Authorization: `Bearer ${'A'.repeat(43)}` })
      return Response.json(page)
    })
    expect(await f.registration.assessmentEvidence(f.task, draft, 0)).toEqual(page)
    expect(f.transport).toHaveBeenCalledOnce()
  })
  it('rejects uncited originals, substituted source metadata and credentials changed during a read', async () => {
    const f = fixture(),
      draft = { ...f.result.draft!, evidenceIds: ['faq'] },
      now = Date.now()
    const page = {
      taskId: f.task.taskId,
      contextHash: f.task.contextHash,
      knowledgeVersion: f.task.knowledgeVersion,
      draftHash: draft.draftHash,
      draftRevision: draft.draftRevision,
      offset: 0,
      assessedAt: now,
      totalAvailable: 1,
      unavailableReferences: 0,
      evidence: [
        {
          evidenceId: 'faq',
          intent: 'faq',
          kind: 'approved_faq',
          source: '合成源',
          content: '合成完整正文',
          validFrom: now - 1000,
          expiresAt: now + 10000
        }
      ]
    }
    for (const change of [
      { taskId: 'other' },
      { draftHash: 'f'.repeat(64) },
      { draftRevision: 99 },
      { knowledgeVersion: 'other' },
      { offset: 1 },
      { nextOffset: 1 },
      { totalAvailable: 2, nextOffset: 1 },
      { evidence: [{ ...page.evidence[0], evidenceId: 'uncited' }] }
    ]) {
      f.transport.mockResolvedValue(Response.json({ ...page, ...change }))
      await expect(f.registration.assessmentEvidence(f.task, draft, 0)).rejects.toMatchObject({
        code: 'INVALID_RESPONSE'
      })
    }
    f.transport.mockImplementation(async () => {
      f.setRecord({ ...f.record(), encryptedCredential: 'changed' })
      return Response.json(page)
    })
    await expect(f.registration.assessmentEvidence(f.task, draft, 0)).rejects.toMatchObject({
      code: 'DEVICE_SCOPE_CHANGED'
    })
  })
  it('accepts bounded Chinese explanations above 64 KiB for generate and edited review, retaining exact draft bindings', async () => {
    const f = fixture(),
      now = Date.now(),
      text = '合'.repeat(10000)
    const knowledge = Array.from({ length: 8 }, (_, index) => ({
      evidenceId: `synthetic-${index}`,
      tenantId: f.task.identity.tenantId,
      intent: 'faq' as const,
      knowledgeVersion: f.task.knowledgeVersion,
      kind: 'approved_faq' as const,
      source: '源'.repeat(2000),
      content: '据'.repeat(600),
      approvedBy: 'synthetic-reviewer',
      validFrom: now - 1000,
      expiresAt: now + 60000
    }))
    const result: GenerationResult = {
      ...f.result,
      automaticAllowed: false,
      factsVerified: false,
      reasons: ['freeform_requires_human'],
      draft: {
        ...f.result.draft!,
        text,
        draftHash: hashDraft(text),
        evidenceIds: knowledge.map((e) => e.evidenceId),
        draftRevision: 2
      },
      review: {
        ...f.result.review!,
        status: 'needs_human',
        reasons: ['freeform_requires_human'],
        draftHash: hashDraft(text),
        draftRevision: 2
      }
    }
    result.explanation = explainAssessment(result, knowledge, now)
    const body = JSON.stringify(result),
      bytes = Buffer.byteLength(body)
    expect(bytes).toBeGreaterThan(65536)
    expect(bytes).toBeLessThan(262144)
    f.transport.mockImplementation(
      async () => new Response(body, { headers: { 'content-length': String(bytes) } })
    )
    expect(await f.registration.generateCandidate(f.input)).toEqual(result)
    expect(
      await f.registration.reviewEdited({
        generation: f.input,
        edit: { text, draftRevision: 2, evidenceIds: result.draft!.evidenceIds }
      })
    ).toEqual(result)
  })
  it('still bounds streamed reply bytes without trusting content-length and cancels the oversized stream', async () => {
    const f = fixture()
    for (const read of [
      () => f.registration.generateCandidate(f.input),
      () => f.registration.assessmentEvidence(f.task, f.result.draft!, 0)
    ]) {
      const cancelled = vi.fn()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(262145))
        },
        cancel: cancelled
      })
      f.transport.mockResolvedValueOnce(
        new Response(stream, { headers: { 'content-length': '1' } })
      )
      await expect(read()).rejects.toThrow('UNAVAILABLE')
      expect(cancelled).toHaveBeenCalledOnce()
    }
  })
  function editedFixture() {
    const f = fixture()
    const request = {
      generation: f.input,
      edit: { text: f.result.draft!.text, draftRevision: 2, evidenceIds: ['faq'] }
    }
    const result = {
      ...f.result,
      automaticAllowed: false,
      draft: { ...f.result.draft!, draftRevision: 2, evidenceIds: ['faq'] },
      review: { ...f.result.review!, draftRevision: 2 }
    }
    f.transport.mockResolvedValue(Response.json(result))
    return { ...f, request, editedResult: result }
  }
  it('uses a separate authenticated endpoint for exact edited text and returns no automatic permission', async () => {
    const f = editedFixture()
    expect(await f.registration.reviewEdited(f.request)).toEqual(f.editedResult)
    const [url, options] = f.transport.mock.calls[0]
    expect(String(url)).toBe('https://enterprise.example/v1/replies/review-edited')
    expect(JSON.parse(String(options?.body))).toEqual(f.request)
    expect(options?.redirect).toBe('manual')
  })
  it('rejects edited reviews that reuse an old revision, change references, expire, or grant automatic authority', async () => {
    const f = editedFixture()
    for (const response of [
      { ...f.editedResult, automaticAllowed: true },
      { ...f.editedResult, draft: { ...f.editedResult.draft, draftRevision: 1 } },
      { ...f.editedResult, draft: { ...f.editedResult.draft, evidenceIds: ['other-source'] } },
      { ...f.editedResult, review: { ...f.editedResult.review, expiresAt: Date.now() - 1 } },
      { ...f.editedResult, factsVerified: false }
    ]) {
      f.transport.mockResolvedValueOnce(Response.json(response))
      await expect(f.registration.reviewEdited(f.request)).rejects.toThrow('INVALID_RESPONSE')
    }
  })
  it('checks edited review ownership before transmission and cancels uncooperative transport', async () => {
    const f = editedFixture()
    await expect(
      f.registration.reviewEdited({
        ...f.request,
        generation: {
          ...f.input,
          task: { ...f.task, identity: { ...f.task.identity, employeeId: 'other' } }
        }
      })
    ).rejects.toThrow('DEVICE_SCOPE_CHANGED')
    expect(f.transport).not.toHaveBeenCalled()
    const controller = new AbortController()
    f.transport.mockReturnValue(new Promise(() => {}))
    const pending = f.registration.reviewEdited(f.request, controller.signal)
    const check = expect(pending).rejects.toThrow('CANCELLED')
    controller.abort()
    await check
  })
  it('sends the exact context and returns a hash-bound candidate without revealing credentials', async () => {
    const f = fixture()
    const result = await f.service.generate(
      f.task,
      f.input.inbound,
      () => true,
      new AbortController().signal,
      f.input.context
    )
    expect(result).toEqual(f.result)
    const [url, options] = f.transport.mock.calls[0]
    expect(String(url)).toBe('https://enterprise.example/v1/replies/generate')
    expect(JSON.parse(String(options?.body))).toEqual(f.input)
    expect(JSON.stringify(result)).not.toContain('A'.repeat(43))
  })
  it('rejects changed customers, final text and review hashes returned by the service', async () => {
    const f = fixture()
    for (const result of [
      { ...f.result, task: { ...f.task, conversationId: 'other' } },
      { ...f.result, draft: { ...f.result.draft!, text: '无依据承诺' } },
      { ...f.result, review: { ...f.result.review!, draftHash: 'b'.repeat(64) } }
    ]) {
      f.transport.mockResolvedValueOnce(Response.json(result))
      await expect(
        f.service.generate(
          f.task,
          f.input.inbound,
          () => true,
          new AbortController().signal,
          f.input.context
        )
      ).rejects.toThrow('INVALID_RESPONSE')
    }
  })
  it('rejects a scope mismatch before any transmission and masks network exceptions', async () => {
    const f = fixture()
    await expect(
      f.registration.generateCandidate({
        ...f.input,
        task: { ...f.task, identity: { ...f.task.identity, accountId: 'other' } }
      })
    ).rejects.toThrow('DEVICE_SCOPE_CHANGED')
    expect(f.transport).not.toHaveBeenCalled()
    f.transport.mockRejectedValueOnce(new Error('private request and credential'))
    await expect(f.registration.generateCandidate(f.input)).rejects.toThrow(/^UNAVAILABLE$/)
  })
  it('rejects a response after device registration changes or local task supersession', async () => {
    const f = fixture()
    f.transport.mockImplementationOnce(async () => {
      f.setRecord({ ...f.record(), encryptedCredential: 'different-session' })
      return Response.json(f.result)
    })
    await expect(f.registration.generateCandidate(f.input)).rejects.toThrow('DEVICE_SCOPE_CHANGED')
    const other = fixture()
    let current = true
    other.transport.mockImplementationOnce(async () => {
      current = false
      return Response.json(other.result)
    })
    await expect(
      other.service.generate(
        other.task,
        other.input.inbound,
        () => current,
        new AbortController().signal,
        other.input.context
      )
    ).rejects.toThrow('reply_task_obsolete')
  })
  it('honors cancellation even when the underlying fetch refuses to settle', async () => {
    const f = fixture(),
      controller = new AbortController()
    f.transport.mockReturnValue(new Promise(() => {}))
    const pending = f.registration.generateCandidate(f.input, controller.signal)
    const check = expect(pending).rejects.toThrow('CANCELLED')
    controller.abort()
    await check
    expect(f.transport).toHaveBeenCalledTimes(1)
  })
})
