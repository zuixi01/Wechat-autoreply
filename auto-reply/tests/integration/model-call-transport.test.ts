import { describe, expect, it, vi } from 'vitest'
import { recordedTransport } from '../../server/src/generation/model-call-transport'
import {
  ModelCallError,
  ModelCallResultSchema,
  type ModelCallResult,
  type ModelCallStart
} from '../../server/src/generation/model-call-contracts'
import { TypeSafeClient } from '../../server/src/decision/typesafe-client'
import { jevRequest, jevResponse } from '../fixtures/jev'
import { hashDraft } from '../../src/core/reply/hashes'

function journal() {
  const reports: ModelCallResult[] = []
  const starts: ModelCallStart[] = []
  const reserve = vi.fn(async (start: ModelCallStart) => {
    starts.push(start)
    return {
      finish: vi.fn(async (report: ModelCallResult) => {
        reports.push(structuredClone(report))
      })
    }
  })
  return { starts, reports, reserve }
}
function client(fetcher: typeof fetch) {
  return new TypeSafeClient({ apiKey: 'synthetic-secret', fetch: fetcher, retryDelayMs: 0 })
}

describe('per-attempt recorded provider HTTP transport', () => {
  it('records every retry, validated decisions and known usage without requests, credentials or error bodies', async () => {
    const j = journal()
    const http = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('private-secret-customer', {
          status: 503,
          headers: { 'x-typesafe-request-id': 'synthetic.failed-1' }
        })
      )
      .mockResolvedValueOnce(
        Response.json(jevResponse, {
          headers: { 'x-typesafe-request-id': 'synthetic.retry-2' }
        })
      )
    expect(await client(recordedTransport('jev', j.reserve, http)).evaluate(jevRequest)).toEqual(
      jevResponse
    )
    expect(j.starts).toHaveLength(2)
    expect(j.starts[0].requestHash).toMatch(/^[a-f0-9]{64}$/)
    expect(j.starts[0].questionHash).toMatch(/^[a-f0-9]{64}$/)
    expect(j.reports).toMatchObject([
      {
        outcome: 'error',
        failureCode: 'UNAVAILABLE',
        httpStatus: 503,
        providerRequestId: { header: 'x-typesafe-request-id', value: 'synthetic.failed-1' }
      },
      {
        outcome: 'response',
        actualModel: jevResponse.model,
        usage: { inputTokens: 180, outputTokens: 35 },
        answers: jevResponse.answers,
        providerRequestId: { header: 'x-typesafe-request-id', value: 'synthetic.retry-2' }
      }
    ])
    expect(j.reports[0].usage).toBeUndefined()
    expect(JSON.stringify({ starts: j.starts, reports: j.reports })).not.toMatch(
      /private-secret|商品坏了|synthetic-secret/
    )
  })
  it('does not dispatch without durable quota reservation and does not retry a persistence failure', async () => {
    const upstream = vi.fn<typeof fetch>()
    const reserve = vi.fn(async () => {
      throw new ModelCallError('LIMIT_REACHED')
    })
    await expect(
      client(recordedTransport('jev', reserve, upstream)).evaluate(jevRequest)
    ).rejects.toThrow('LIMIT_REACHED')
    expect(upstream).not.toHaveBeenCalled()
    expect(reserve).toHaveBeenCalledOnce()
    const failedReceipt = vi.fn(async () => {
      throw new ModelCallError('RECORD_UNAVAILABLE')
    })
    upstream.mockResolvedValue(Response.json(jevResponse))
    await expect(
      client(recordedTransport('jev', async () => ({ finish: failedReceipt }), upstream)).evaluate(
        jevRequest
      )
    ).rejects.toThrow('RECORD_UNAVAILABLE')
    expect(upstream).toHaveBeenCalledOnce()
  })
  it('preserves usage from malformed successful replies while never treating missing usage as zero', async () => {
    const j = journal()
    const bad = { ...jevResponse, answers: {}, usage: { input_tokens: 25, output_tokens: 9 } }
    await expect(
      client(
        recordedTransport(
          'jev',
          j.reserve,
          vi.fn(async () =>
            Response.json(bad, { headers: { 'x-typesafe-request-id': 'synthetic.malformed' } })
          )
        )
      ).evaluate(jevRequest)
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    expect(j.reports[0]).toMatchObject({
      failureCode: 'INVALID_RESPONSE',
      usage: { inputTokens: 25, outputTokens: 9 },
      providerRequestId: { header: 'x-typesafe-request-id', value: 'synthetic.malformed' }
    })
    expect(j.reports[0].answers).toBeUndefined()
    const text = journal()
    const fetcher = recordedTransport(
      'text',
      text.reserve,
      vi.fn(async () =>
        Response.json({
          model: 'text-model',
          choices: [
            {
              finish_reason: 'stop',
              message: { role: 'assistant', content: '{"text":"合成建议","evidenceIds":["faq"]}' }
            }
          ]
        })
      )
    )
    await fetcher('https://synthetic.invalid', { method: 'POST', body: '{"model":"text-model"}' })
    expect(text.reports[0].outcome).toBe('response')
    expect(text.reports[0].usage).toBeUndefined()
    expect(text.reports[0].textOutput).toEqual({
      draftHash: hashDraft('合成建议'),
      evidenceIds: ['faq']
    })
  })
  it('binds only the normalized text hash and ordered evidence IDs while accepting legacy receipts', async () => {
    const j = journal(),
      normalized = '合成私密回复\n第二行',
      evidenceIds = ['faq-z', 'faq-a']
    const fetcher = recordedTransport(
      'text',
      j.reserve,
      vi.fn(async () =>
        Response.json({
          model: 'text-model',
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: JSON.stringify({ text: ` \n${normalized}\t `, evidenceIds })
              }
            }
          ]
        })
      )
    )
    await fetcher('https://synthetic.invalid', { method: 'POST', body: '{"model":"text-model"}' })
    expect(j.reports[0]).toMatchObject({
      outcome: 'response',
      textOutput: {
        draftHash: hashDraft(normalized),
        evidenceIds
      }
    })
    expect(JSON.stringify(j.reports[0])).not.toContain(normalized)
    expect(JSON.stringify(j.reports[0])).not.toContain('合成私密回复')
    expect(ModelCallResultSchema.parse(j.reports[0])).toEqual(j.reports[0])
    expect(
      ModelCallResultSchema.parse({ outcome: 'response', durationMs: 1 }).textOutput
    ).toBeUndefined()
    expect(
      ModelCallResultSchema.parse({ outcome: 'response', durationMs: 1 }).providerRequestId
    ).toBeUndefined()
    for (const textOutput of [
      { draftHash: 'not-a-hash', evidenceIds },
      { draftHash: hashDraft(normalized), evidenceIds: [] },
      { draftHash: hashDraft(normalized), evidenceIds, text: normalized }
    ])
      expect(ModelCallResultSchema.safeParse({ ...j.reports[0], textOutput }).success).toBe(false)
  })
  it('does not certify text output for malformed generated content', async () => {
    for (const content of [
      'not-json',
      JSON.stringify({ text: ' \t ', evidenceIds: ['faq'] }),
      JSON.stringify({ text: '私密非法回复', evidenceIds: [] })
    ]) {
      const j = journal()
      const fetcher = recordedTransport(
        'text',
        j.reserve,
        vi.fn(async () =>
          Response.json({
            model: 'text-model',
            usage: { prompt_tokens: 10, completion_tokens: 4 },
            choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }]
          })
        )
      )
      await fetcher('https://synthetic.invalid', { method: 'POST', body: '{"model":"text-model"}' })
      expect(j.reports[0]).toMatchObject({ outcome: 'error', failureCode: 'INVALID_RESPONSE' })
      expect(j.reports[0].textOutput).toBeUndefined()
      expect(JSON.stringify(j.reports[0])).not.toContain('私密非法回复')
    }
  })
  it('returns on cancellation even when the upstream ignores it; a late response cannot overwrite the receipt', async () => {
    const j = journal(),
      controller = new AbortController()
    let finish!: (response: Response) => void
    const upstream = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve
        })
    )
    const request = recordedTransport(
      'jev',
      j.reserve,
      upstream
    )('https://synthetic.invalid', {
      method: 'POST',
      body: JSON.stringify(jevRequest),
      signal: controller.signal
    })
    await vi.waitFor(() => expect(upstream).toHaveBeenCalledOnce())
    controller.abort('model_timeout')
    await expect(request).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(j.reports).toHaveLength(1)
    expect(j.reports[0]).toMatchObject({ outcome: 'timed_out', failureCode: 'TIMEOUT' })
    expect(j.reports[0].usage).toBeUndefined()
    const before = structuredClone(j.reports[0])
    finish(
      Response.json(jevResponse, {
        headers: { 'x-typesafe-request-id': 'synthetic.too-late' }
      })
    )
    await Promise.resolve()
    expect(j.reports).toEqual([before])
    expect(j.reports[0].actualModel).toBeUndefined()
  })
  it('enforces streamed byte limits and classifies oversized responses as nonretryable', async () => {
    const j = journal(),
      cancelled = vi.fn()
    const upstream = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(2_000_001))
            },
            cancel: cancelled
          })
        )
    )
    await expect(
      client(recordedTransport('jev', j.reserve, upstream)).evaluate(jevRequest)
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE', retryable: false })
    expect(upstream).toHaveBeenCalledOnce()
    expect(cancelled).toHaveBeenCalledOnce()
    expect(j.reports[0].failureCode).toBe('INVALID_RESPONSE')
  })
  it('checks the actual text model before accepting a response, retaining observed usage on drift', async () => {
    const j = journal()
    const fetcher = recordedTransport(
      'text',
      j.reserve,
      vi.fn(async () =>
        Response.json({
          model: 'unexpected',
          usage: { prompt_tokens: 10, completion_tokens: 4 },
          choices: [
            {
              finish_reason: 'stop',
              message: { role: 'assistant', content: '{"text":"合成建议","evidenceIds":["faq"]}' }
            }
          ]
        })
      ),
      'expected'
    )
    await fetcher('https://synthetic.invalid', { method: 'POST', body: '{"model":"alias"}' })
    expect(j.reports[0]).toMatchObject({
      outcome: 'error',
      failureCode: 'MODEL_DRIFT',
      actualModel: 'unexpected',
      usage: { inputTokens: 10, outputTokens: 4 }
    })
    expect(j.reports[0].textOutput).toBeUndefined()
  })
  it('never attaches text output after cancellation even if a valid response arrives later', async () => {
    const j = journal(),
      controller = new AbortController()
    let finish!: (response: Response) => void
    const upstream = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve
        })
    )
    const request = recordedTransport(
      'text',
      j.reserve,
      upstream
    )('https://synthetic.invalid', {
      method: 'POST',
      body: '{"model":"text-model"}',
      signal: controller.signal
    })
    await vi.waitFor(() => expect(upstream).toHaveBeenCalledOnce())
    controller.abort()
    await expect(request).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(j.reports).toHaveLength(1)
    expect(j.reports[0]).toMatchObject({ outcome: 'cancelled', failureCode: 'CANCELLED' })
    expect(j.reports[0].textOutput).toBeUndefined()
    const before = structuredClone(j.reports[0])
    const late = Response.json(
      {
        model: 'text-model',
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: '{"text":"迟到私密回复","evidenceIds":["faq"]}'
            }
          }
        ]
      },
      { headers: { 'x-request-id': 'synthetic.too-late' } }
    )
    const discarded = vi.spyOn(late.body!, 'cancel')
    finish(late)
    await vi.waitFor(() => expect(discarded).toHaveBeenCalledOnce())
    expect(j.reports).toEqual([before])
    expect(JSON.stringify(j.reports)).not.toContain('迟到私密回复')
  })

  it.each(['jev', 'text'] as const)(
    'retains only the configured %s request header, without interpreting it as billing evidence',
    async (provider) => {
      const j = journal(),
        header = provider === 'jev' ? 'x-typesafe-request-id' : 'x-request-id',
        otherHeader = provider === 'jev' ? 'x-request-id' : 'x-typesafe-request-id',
        body =
          provider === 'jev'
            ? jevResponse
            : {
                id: 'body-id-must-not-be-recorded',
                model: 'text-model',
                choices: [
                  {
                    finish_reason: 'stop',
                    message: {
                      role: 'assistant',
                      content: '{"text":"合成建议","evidenceIds":["faq"]}'
                    }
                  }
                ]
              }
      const fetcher = recordedTransport(
        provider,
        j.reserve,
        vi.fn(async () =>
          Response.json(body, {
            headers: {
              [header]: 'synthetic.req_1:/-v2',
              [otherHeader]: 'wrong-provider-header',
              'set-cookie': 'private-session',
              'x-billed-cost': '0',
              Authorization: 'private-token'
            }
          })
        )
      )
      await fetcher('https://synthetic.invalid', {
        method: 'POST',
        body: JSON.stringify(provider === 'jev' ? jevRequest : { model: 'text-model' })
      })
      expect(j.reports[0]).toMatchObject({
        outcome: 'response',
        providerRequestId: { header, value: 'synthetic.req_1:/-v2' }
      })
      expect(ModelCallResultSchema.parse(j.reports[0])).toEqual(j.reports[0])
      expect(JSON.stringify(j.reports)).not.toMatch(
        /body-id-must-not-be-recorded|wrong-provider-header|private-session|private-token|billedCost|paid/
      )
    }
  )

  it.each([
    null,
    '',
    'a'.repeat(257),
    'synthetic.first, synthetic.second',
    'synthetic injected',
    '合成编号',
    'synthetic\r\nAuthorization: injected',
    'synthetic\u0000id'
  ])('omits unsafe or absent observed request IDs (%j)', async (observed) => {
    const j = journal(),
      response = Response.json(jevResponse),
      originalGet = response.headers.get.bind(response.headers)
    // Real fetch headers reject CR/LF; this also covers a nonconforming injected transport.
    vi.spyOn(response.headers, 'get').mockImplementation((name) =>
      name.toLowerCase() === 'x-typesafe-request-id' ? observed : originalGet(name)
    )
    await recordedTransport(
      'jev',
      j.reserve,
      vi.fn(async () => response)
    )('https://synthetic.invalid', { method: 'POST', body: JSON.stringify(jevRequest) })
    expect(j.reports[0].outcome).toBe('response')
    expect(j.reports[0].providerRequestId).toBeUndefined()
    expect(ModelCallResultSchema.parse(j.reports[0])).toEqual(j.reports[0])
  })

  it('keeps the observed request ID when headers arrive before a body timeout', async () => {
    const j = journal(),
      controller = new AbortController(),
      response = new Response(new ReadableStream(), {
        headers: { 'x-typesafe-request-id': 'synthetic.headers-before-timeout' }
      }),
      acquired = vi.spyOn(response.body!, 'getReader')
    const pending = recordedTransport(
      'jev',
      j.reserve,
      vi.fn(async () => response)
    )('https://synthetic.invalid', {
      method: 'POST',
      body: JSON.stringify(jevRequest),
      signal: controller.signal
    })
    await vi.waitFor(() => expect(acquired).toHaveBeenCalledOnce())
    controller.abort('model_timeout')
    await expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(j.reports).toHaveLength(1)
    expect(j.reports[0]).toMatchObject({
      outcome: 'timed_out',
      failureCode: 'TIMEOUT',
      providerRequestId: {
        header: 'x-typesafe-request-id',
        value: 'synthetic.headers-before-timeout'
      }
    })
    expect(j.reports[0].usage).toBeUndefined()
    expect(ModelCallResultSchema.parse(j.reports[0])).toEqual(j.reports[0])
  })

  it('accepts bounded opaque request IDs but rejects forged metadata and unknown fields', () => {
    const receipt = { outcome: 'response', durationMs: 1 },
      providerRequestId = { header: 'x-typesafe-request-id', value: 'a'.repeat(256) }
    expect(ModelCallResultSchema.safeParse({ ...receipt, providerRequestId }).success).toBe(true)
    for (const forged of [
      { ...providerRequestId, value: '' },
      { ...providerRequestId, value: 'a'.repeat(257) },
      { ...providerRequestId, value: 'a,b' },
      { ...providerRequestId, header: 'authorization' },
      { ...providerRequestId, paid: true },
      { ...providerRequestId, value: 'a\r\nB: c' }
    ])
      expect(
        ModelCallResultSchema.safeParse({ ...receipt, providerRequestId: forged }).success
      ).toBe(false)
    expect(
      ModelCallResultSchema.safeParse({ ...receipt, providerRequestId, billedCostMicros: 0 })
        .success
    ).toBe(false)
  })
})
