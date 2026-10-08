import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { TypeSafeClient } from '../../server/src/decision/typesafe-client'
import { recordedTransport } from '../../server/src/generation/model-call-transport'
import type { ModelCallResult } from '../../server/src/generation/model-call-contracts'
import { jevRequest, jevResponse } from '../fixtures/jev'

const maximum = 2_000_000
const client = (fetcher: typeof fetch, timeoutMs = 20): TypeSafeClient =>
  new TypeSafeClient({ apiKey: 'synthetic-only', fetch: fetcher, timeoutMs, maxAttempts: 1 })

function malformedResponseBytes(): Uint8Array<ArrayBuffer> {
  const valid = new TextEncoder().encode(JSON.stringify(jevResponse))
  const prefix = new TextEncoder().encode('{"ignored":"')
  const bytes = new Uint8Array(prefix.byteLength + 3 + valid.byteLength - 1)
  bytes.set(prefix)
  bytes.set([0xff, 0x22, 0x2c], prefix.byteLength)
  bytes.set(valid.subarray(1), prefix.byteLength + 3)
  return bytes
}

afterEach(() => vi.useRealTimers())

describe('bounded Jev transport and response lifetime', () => {
  it('finishes on timeout even when transport ignores its abort signal', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn<typeof fetch>(() => new Promise(() => {}))
    const pending = client(fetcher).evaluate(jevRequest)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' })
    await vi.advanceTimersByTimeAsync(20)
    await rejected
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels an uncooperative transport and discards its late successful response', async () => {
    let resolve!: (value: Response) => void
    const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>((done) => (resolve = done)))
    const controller = new AbortController()
    const pending = client(fetcher, 1000).evaluate(jevRequest, { signal: controller.signal })
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
    controller.abort()
    await rejected
    const cancelled = vi.fn()
    resolve(new Response(new ReadableStream({ cancel: cancelled })))
    await new Promise<void>((done) => queueMicrotask(done))
    await new Promise<void>((done) => queueMicrotask(done))
    expect(cancelled).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('ends a stalled response body at the attempt deadline and cancels the reader', async () => {
    vi.useFakeTimers()
    const cancelled = vi.fn()
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(new ReadableStream({ cancel: cancelled }))
    )
    const pending = client(fetcher).evaluate(jevRequest)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' })
    await vi.advanceTimersByTimeAsync(20)
    await rejected
    expect(cancelled).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([undefined, '12'])(
    'rejects excess streamed UTF-8 bytes with Content-Length %s without reading the tail or retrying',
    async (declared) => {
      const bytes = new TextEncoder().encode(
        JSON.stringify({ ...jevResponse, ignored: '汉'.repeat(700_000) })
      )
      expect(bytes.byteLength).toBeGreaterThan(maximum)
      const cancelled = vi.fn()
      let pulls = 0
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls++
            if (pulls === 1) controller.enqueue(bytes)
            else controller.close()
          },
          cancel: cancelled
        },
        { highWaterMark: 0 }
      )
      const fetcher = vi.fn<typeof fetch>(
        async () => new Response(body, { headers: declared ? { 'content-length': declared } : {} })
      )
      await expect(client(fetcher, 1000).evaluate(jevRequest)).rejects.toMatchObject({
        code: 'INVALID_RESPONSE',
        retryable: false
      })
      expect(pulls).toBe(1)
      expect(cancelled).toHaveBeenCalledTimes(1)
      expect(fetcher).toHaveBeenCalledTimes(1)
    }
  )

  it('accepts a valid response exactly at the byte limit with split Unicode sequences', async () => {
    const prefix = new TextEncoder().encode(JSON.stringify({ ...jevResponse, ignored: '中文😀' }))
    const bytes = new Uint8Array(maximum)
    bytes.set(prefix)
    bytes.fill(32, prefix.byteLength)
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (let offset = 0; offset < prefix.byteLength; offset += 7)
                controller.enqueue(bytes.subarray(offset, Math.min(offset + 7, prefix.byteLength)))
              controller.enqueue(bytes.subarray(prefix.byteLength))
              controller.close()
            }
          })
        )
    )
    await expect(client(fetcher, 1000).evaluate(jevRequest)).resolves.toEqual(jevResponse)
  })

  it('rejects malformed UTF-8 instead of substituting characters into validated answers', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(malformedResponseBytes()))
    await expect(client(fetcher, 1000).evaluate(jevRequest)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      retryable: false
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('records invalid UTF-8 as a rejected response without verified answers or fabricated usage', async () => {
    const reports: ModelCallResult[] = []
    const fetcher = recordedTransport(
      'jev',
      async () => ({ finish: async (report) => void reports.push(structuredClone(report)) }),
      async () => new Response(malformedResponseBytes())
    )
    await expect(client(fetcher, 1000).evaluate(jevRequest)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE'
    })
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ outcome: 'error', failureCode: 'INVALID_RESPONSE' })
    expect(reports[0].answers).toBeUndefined()
    expect(reports[0].usage).toBeUndefined()
  })

  it('retries only once after a stalled attempt and discards the first attempt arriving after success', async () => {
    vi.useFakeTimers()
    let finish!: (response: Response) => void
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (finish = resolve)))
      .mockResolvedValueOnce(Response.json(jevResponse))
    const pending = new TypeSafeClient({
      apiKey: 'synthetic-only',
      fetch: fetcher,
      timeoutMs: 20,
      retryDelayMs: 0,
      maxAttempts: 2
    }).evaluate(jevRequest)
    await vi.advanceTimersByTimeAsync(21)
    await expect(pending).resolves.toEqual(jevResponse)
    const cancelled = vi.fn()
    finish(new Response(new ReadableStream({ cancel: cancelled })))
    await new Promise<void>((done) => queueMicrotask(done))
    await new Promise<void>((done) => queueMicrotask(done))
    expect(cancelled).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('uses the task deadline to stop a hanging call without starting another attempt', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn<typeof fetch>(() => new Promise(() => {}))
    const pending = new TypeSafeClient({
      apiKey: 'synthetic-only',
      fetch: fetcher,
      timeoutMs: 1000,
      retryDelayMs: 0,
      maxAttempts: 2
    }).evaluate(jevRequest, { deadlineMs: Date.now() + 10 })
    const rejected = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' })
    await vi.advanceTimersByTimeAsync(10)
    await rejected
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds model-list requests through the same response lifetime', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn<typeof fetch>(() => new Promise(() => {}))
    const pending = client(fetcher).listModels()
    const rejected = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' })
    await vi.advanceTimersByTimeAsync(20)
    await rejected
    expect(fetcher.mock.calls[0][0]).toBe('https://api.typesafe.ai/v1/models')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('enforces the byte limit over actual loopback chunked HTTP with a synthetic Unicode response', async () => {
    const bytes = Buffer.from(JSON.stringify({ ...jevResponse, ignored: '汉'.repeat(700_000) }))
    const server = createServer((request, response) => {
      request.resume()
      response.writeHead(200, { 'content-type': 'application/json' })
      response.write(bytes.subarray(0, 1000))
      response.end(bytes.subarray(1000))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address() as AddressInfo
      const fetcher = vi.fn<typeof fetch>((url, init) => {
        expect(url).toBe('https://api.typesafe.ai/v1/systemone')
        return fetch(`http://127.0.0.1:${address.port}`, init)
      })
      await expect(client(fetcher, 3000).evaluate(jevRequest)).rejects.toMatchObject({
        code: 'INVALID_RESPONSE',
        retryable: false
      })
      expect(fetcher).toHaveBeenCalledTimes(1)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  })

  it('cancels a declared oversized response without consuming its body', async () => {
    const cancelled = vi.fn()
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(new ReadableStream({ cancel: cancelled }), {
          headers: { 'content-length': String(maximum + 1) }
        })
    )
    await expect(client(fetcher, 1000).evaluate(jevRequest)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE'
    })
    expect(cancelled).toHaveBeenCalledTimes(1)
  })

  it.each([302, 401, 503])(
    'discards HTTP %s bodies without inspecting private error text',
    async (status) => {
      const cancelled = vi.fn()
      const fetcher = vi.fn<typeof fetch>(
        async () => new Response(new ReadableStream({ cancel: cancelled }), { status })
      )
      await expect(client(fetcher, 1000).evaluate(jevRequest)).rejects.toBeInstanceOf(Error)
      expect(cancelled).toHaveBeenCalledTimes(1)
      expect(fetcher).toHaveBeenCalledTimes(1)
    }
  )

  it('does not dispatch an already-cancelled request', async () => {
    const fetcher = vi.fn<typeof fetch>()
    const controller = new AbortController()
    controller.abort()
    await expect(
      client(fetcher).evaluate(jevRequest, { signal: controller.signal })
    ).rejects.toMatchObject({
      code: 'CANCELLED'
    })
    expect(fetcher).not.toHaveBeenCalled()
  })
})
