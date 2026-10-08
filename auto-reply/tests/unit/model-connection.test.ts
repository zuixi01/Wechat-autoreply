import { afterEach, describe, expect, it, vi } from 'vitest'
import { AIClient } from '../../src/core/ai-client'

const client = (): AIClient =>
  new AIClient({
    apiKey: 'synthetic-test-key',
    model: 'test-model',
    baseURL: 'http://model.invalid/v1'
  })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('model connection checks', () => {
  it('calls the configured model and only succeeds after receiving text', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: '连接成功' } }] }))
      )
    vi.stubGlobal('fetch', fetch)
    await expect(client().testConnection()).resolves.toEqual({ success: true })
    const [url, options] = fetch.mock.calls[0]
    expect(url).toBe('http://model.invalid/v1/chat/completions')
    expect(options.headers.Authorization).toBe('Bearer synthetic-test-key')
    expect(JSON.parse(options.body)).toMatchObject({ model: 'test-model', stream: false })
    expect(
      JSON.parse(options.body).messages.every(
        (message: { content: unknown }) => typeof message.content === 'string'
      )
    ).toBe(true)
  })

  it.each([
    {},
    { choices: [] },
    { choices: [{ message: { content: '   ' } }] },
    { choices: [{ message: { content: '<think>internal only</think>' } }] }
  ])('rejects a successful HTTP response without usable text: %j', async (body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body))))
    await expect(client().testConnection()).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('未返回有效文本')
    })
  })

  it('reports authentication failures instead of calling the configuration valid', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: 'Invalid API key' }), { status: 401 })
        )
    )
    await expect(client().testConnection()).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('401')
    })
  })

  it('reports network failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch failed')))
    await expect(client().testConnection()).resolves.toEqual({
      success: false,
      error: 'fetch failed'
    })
  })

  it('aborts a stalled connection after 15 seconds', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url, options) =>
          new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError'))
            )
          })
      )
    )
    const pending = client().testConnection()
    await vi.advanceTimersByTimeAsync(15000)
    await expect(pending).resolves.toEqual({ success: false, error: 'AI API 请求超时 (15s)' })
  })
})
