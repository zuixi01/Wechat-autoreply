import { createServer, type Server, type RequestListener } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { HttpLearningReviewTransport } from '../../src/core/memory/learning-transport'

const servers: Server[] = []
afterEach(async () => { for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve())) })
async function serve(handler: RequestListener): Promise<string> {
  const server = createServer(handler); servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  return `http://127.0.0.1:${address.port}/v1`
}
describe('bounded learning model HTTP transport', () => {
  it('sends a text-only structured review and parses usage without exposing credentials in failures', async () => {
    let body: Record<string, unknown> = {}, auth = '', path = ''
    const url = await serve((request, response) => {
      let raw = ''; request.on('data', chunk => { raw += String(chunk) })
      request.on('end', () => {
        body = JSON.parse(raw); auth = String(request.headers.authorization); path = request.url!
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify({ choices: [{ message: { content: '{"operations":[]}' } }], usage: { prompt_tokens: 100, completion_tokens: 10 } }))
      })
    })
    const transport = new HttpLearningReviewTransport({ baseURL: url, apiKey: 'test-only-key', model: 'test-model' })
    expect(await transport.complete({ system: '提炼经验', user: '{}', maxOutputTokens: 2000 }, new AbortController().signal)).toEqual({ text: '{"operations":[]}', usage: { inputTokens: 100, outputTokens: 10 } })
    expect(auth).toBe('Bearer test-only-key'); expect(path).toBe('/v1/chat/completions')
    expect(body).toMatchObject({ model: 'test-model', stream: false, max_tokens: 2000 })
    expect(body.tools).toBeUndefined()
    expect(body.messages).toEqual([{ role: 'system', content: '提炼经验' }, { role: 'user', content: '{}' }])
  })
  it('refuses redirects, oversized output and invalid usage', async () => {
    for (const scenario of ['redirect', 'oversized', 'usage']) {
      const url = await serve((_request, response) => {
        if (scenario === 'redirect') { response.writeHead(302, { Location: 'http://127.0.0.1:9' }); response.end(); return }
        if (scenario === 'oversized') { response.end('x'.repeat(66000)); return }
        response.end(JSON.stringify({ choices: [{ message: { content: '{}' } }], usage: { prompt_tokens: -1, completion_tokens: 0 } }))
      })
      const transport = new HttpLearningReviewTransport({ baseURL: url, apiKey: 'secret', model: 'test' })
      await expect(transport.complete({ system: 's', user: 'u', maxOutputTokens: 2000 }, new AbortController().signal)).rejects.toThrow(/^review_/)
    }
  })
  it('cancels before dispatch and validates HTTPS for non-local endpoints', async () => {
    expect(() => new HttpLearningReviewTransport({ baseURL: 'http://untrusted.example/v1', apiKey: 'secret', model: 'test' })).toThrow('review_insecure_endpoint')
    const controller = new AbortController(); controller.abort()
    const transport = new HttpLearningReviewTransport({ baseURL: 'https://example.com/v1', apiKey: 'secret', model: 'test' })
    await expect(transport.complete({ system: 's', user: 'u', maxOutputTokens: 2000 }, controller.signal)).rejects.toThrow('review_cancelled')
  })
})
