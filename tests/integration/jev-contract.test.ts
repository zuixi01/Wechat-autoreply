import { describe, expect, it, vi } from 'vitest'
import { TypeSafeClient } from '../../server/src/decision/typesafe-client'
import { jevRequest, jevResponse } from '../fixtures/jev'
import { parseJevResponse } from '../../src/shared/contracts/decision'

const response = (value: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(value), { status, headers })
const transport = (
  fn: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>
): typeof fetch => fn as typeof fetch

describe('TypeSafe official request/response contract', () => {
  it('sends one batch to the official endpoint and preserves Noul and fractional Score semantics', async () => {
    const mock = vi.fn(async () => response(jevResponse))
    const client = new TypeSafeClient({ apiKey: 'test-secret', fetch: transport(mock) })
    expect(await client.evaluate(jevRequest)).toEqual(jevResponse)
    const [url, init] = mock.mock.calls[0] as unknown as Parameters<typeof fetch>
    expect(url).toBe('https://api.typesafe.ai/v1/systemone')
    expect(init?.redirect).toBe('manual')
    expect(init?.headers).toEqual({
      Authorization: 'Bearer test-secret',
      'Content-Type': 'application/json'
    })
    expect(JSON.parse(init?.body as string)).toEqual(jevRequest)
    expect(mock).toHaveBeenCalledTimes(1)
  })
  it('uses the authenticated official model-list contract', async () => {
    const mock = vi.fn(async () =>
      response({ models: [{ name: 'jev-x', description: 'decision', release_date: '2026-09-15' }] })
    )
    const client = new TypeSafeClient({ apiKey: 'test', fetch: transport(mock) })
    expect((await client.listModels()).models[0].name).toBe('jev-x')
    expect((mock.mock.calls[0] as unknown as Parameters<typeof fetch>)[0]).toBe(
      'https://api.typesafe.ai/v1/models'
    )
  })
  it.each([401, 403, 422, 302])(
    'does not retry HTTP %s or echo a hostile upstream secret',
    async (status) => {
      const mock = vi.fn(async () =>
        response({ detail: 'test-secret exposed in upstream body' }, status)
      )
      const client = new TypeSafeClient({ apiKey: 'test-secret', fetch: transport(mock) })
      try {
        await client.evaluate(jevRequest)
        expect.fail('should reject')
      } catch (error) {
        expect(String(error)).not.toContain('test-secret')
      }
      expect(mock).toHaveBeenCalledTimes(1)
    }
  )
  it('retries a transient error once without ever retrying a send action', async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(response({}, 503))
      .mockResolvedValueOnce(response(jevResponse))
    const client = new TypeSafeClient({ apiKey: 'test', fetch: transport(mock), retryDelayMs: 0 })
    await expect(client.evaluate(jevRequest)).resolves.toEqual(jevResponse)
    expect(mock).toHaveBeenCalledTimes(2)
  })
  it('respects retry-after and the total deadline', async () => {
    const mock = vi.fn(async () => response({}, 429, { 'retry-after': '60' }))
    const client = new TypeSafeClient({ apiKey: 'test', fetch: transport(mock), retryDelayMs: 0 })
    await expect(
      client.evaluate(jevRequest, { deadlineMs: Date.now() + 1000 })
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' })
    expect(mock).toHaveBeenCalledTimes(1)
  })
  it('cancels an in-flight request and does not retry', async () => {
    const controller = new AbortController()
    const mock = vi.fn(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('transport aborted')), {
            once: true
          })
        })
    )
    const client = new TypeSafeClient({ apiKey: 'test', fetch: transport(mock) })
    const pending = client.evaluate(jevRequest, { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(mock).toHaveBeenCalledTimes(1)
  })
  it('times out a stuck transport with an abort signal', async () => {
    const mock = vi.fn(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('timeout')), {
            once: true
          })
        })
    )
    const client = new TypeSafeClient({
      apiKey: 'test',
      fetch: transport(mock),
      timeoutMs: 15,
      maxAttempts: 1
    })
    await expect(client.evaluate(jevRequest)).rejects.toMatchObject({ code: 'TIMEOUT' })
  })
  it('rejects partial answers, changed choice options, invalid probabilities and a mismatched rubric', () => {
    const missing = structuredClone(jevResponse)
    delete missing.answers.human
    expect(() => parseJevResponse(jevRequest, missing)).toThrow()
    const unknown = structuredClone(jevResponse)
    if (unknown.answers.intent.type === 'choice') unknown.answers.intent.choice = 'not-supplied'
    expect(() => parseJevResponse(jevRequest, unknown)).toThrow()
    const probabilities = structuredClone(jevResponse)
    if (probabilities.answers.intent.type === 'choice')
      probabilities.answers.intent.probabilities.support = 2
    expect(() => parseJevResponse(jevRequest, probabilities)).toThrow()
    const rubric = structuredClone(jevResponse)
    if (rubric.answers.urgency.type === 'score')
      rubric.answers.urgency.legend['2'] = 'changed meaning'
    expect(() => parseJevResponse(jevRequest, rubric)).toThrow()
  })
  it('does not retry malformed model output', async () => {
    const mock = vi.fn(async () => response({ model: 'jev', answers: {}, usage: {} }))
    const client = new TypeSafeClient({ apiKey: 'test', fetch: transport(mock) })
    await expect(client.evaluate(jevRequest)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    expect(mock).toHaveBeenCalledTimes(1)
  })
  it.each(['constructor', 'toString', 'hasOwnProperty'])(
    'rejects undeclared prototype-named choice %s through the production client',
    async (choice) => {
      const output = structuredClone(jevResponse)
      if (output.answers.intent.type !== 'choice') throw new Error('invalid_fixture')
      output.answers.intent.choice = choice
      const mock = vi.fn(async () => response(output))
      const client = new TypeSafeClient({ apiKey: 'synthetic', fetch: transport(mock) })
      await expect(client.evaluate(jevRequest)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
      expect(mock).toHaveBeenCalledTimes(1)
    }
  )
  it('accepts reordered object fields in the original structured score rubric', async () => {
    const input = structuredClone(jevRequest)
    const output = structuredClone(jevResponse)
    input.questions.urgency = {
      type: 'score',
      criteria: [
        { action: 'wait', evidence: { status: 'open', channels: ['wechat', 'wework'] } },
        { action: 'review', evidence: { status: 'urgent', channels: ['wechat', 'wework'] } }
      ]
    }
    output.answers.urgency = {
      type: 'score',
      score: 0.8,
      confidence: 0.9,
      legend: {
        '0': { evidence: { channels: ['wechat', 'wework'], status: 'open' }, action: 'wait' },
        '1': { evidence: { channels: ['wechat', 'wework'], status: 'urgent' }, action: 'review' }
      },
      probabilities: { '0': 0.2, '1': 0.8 }
    }
    const mock = vi.fn(async () => response(output))
    const client = new TypeSafeClient({ apiKey: 'synthetic', fetch: transport(mock) })
    await expect(client.evaluate(input)).resolves.toEqual(output)
    expect(mock).toHaveBeenCalledTimes(1)
  })
  it.each(['field value', 'array order'])(
    'rejects a changed structured score rubric %s',
    async (change) => {
      const input = structuredClone(jevRequest)
      const criterion = { status: 'open', channels: ['wechat', 'wework'] }
      input.questions.urgency = { type: 'score', criteria: [criterion] }
      const output = structuredClone(jevResponse)
      output.answers.urgency = {
        type: 'score',
        score: 0,
        confidence: 1,
        legend: {
          '0':
            change === 'field value'
              ? { ...criterion, status: 'closed' }
              : { ...criterion, channels: ['wework', 'wechat'] }
        },
        probabilities: { '0': 1 }
      }
      const mock = vi.fn(async () => response(output))
      const client = new TypeSafeClient({ apiKey: 'synthetic', fetch: transport(mock) })
      await expect(client.evaluate(input)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
      expect(mock).toHaveBeenCalledTimes(1)
    }
  )
  it('accepts a prototype-named option only when explicitly declared', async () => {
    const input = structuredClone(jevRequest)
    input.questions.intent = {
      type: 'choice',
      criteria: Object.fromEntries([['constructor', '已声明的选项']])
    }
    const output = structuredClone(jevResponse)
    output.answers.intent = {
      type: 'choice',
      choice: 'constructor',
      confidence: 1,
      probabilities: Object.fromEntries([['constructor', 1]])
    }
    const mock = vi.fn(async () => response(output))
    const client = new TypeSafeClient({ apiKey: 'synthetic', fetch: transport(mock) })
    await expect(client.evaluate(input)).resolves.toEqual(output)
    expect(mock).toHaveBeenCalledTimes(1)
  })
  it.each([null, false, 42])('rejects invalid scalar rubric %s before dispatch', async (level) => {
    const input = {
      ...structuredClone(jevRequest),
      questions: { urgency: { type: 'score', criteria: [level] } }
    } as unknown as typeof jevRequest
    const mock = vi.fn(async () => response(jevResponse))
    const client = new TypeSafeClient({ apiKey: 'synthetic', fetch: transport(mock) })
    await expect(client.evaluate(input)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(mock).not.toHaveBeenCalled()
  })
  it('takes an immutable input snapshot before invoking transport', async () => {
    let resolve!: (value: Response) => void
    const mock = vi.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done
        })
    )
    const client = new TypeSafeClient({ apiKey: 'test', fetch: transport(mock) })
    const mutable = structuredClone(jevRequest)
    const pending = client.evaluate(mutable)
    delete mutable.questions.human
    resolve(response(jevResponse))
    await expect(pending).resolves.toEqual(jevResponse)
  })
})
