import { afterEach, describe, expect, it, vi } from 'vitest'
import { request, type Server } from 'node:http'
import { createSkillServer, type SkillEngineController } from '../../src/main/skill-server'

const token = 'a'.repeat(64)
const instances: Server[] = []
afterEach(async () => {
  await Promise.all(
    instances.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
          server.closeAllConnections()
        })
    )
  )
})

async function fixture() {
  const controller: SkillEngineController = {
    start: vi.fn(async () => ({ ok: true })),
    pause: vi.fn(async () => ({ ok: true })),
    isRunning: vi.fn(() => false)
  }
  const server = createSkillServer(controller, token)
  instances.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test_listen_failed')
  const call = (path: string, headers: Record<string, string> = {}, body = '', method = 'POST') =>
    new Promise<{ status: number; body: Record<string, unknown>; cors: string | undefined }>(
      (resolve, reject) => {
        const req = request(
          {
            hostname: '127.0.0.1',
            port: address.port,
            path,
            method,
            headers: { Authorization: `Bearer ${token}`, ...headers }
          },
          (res) => {
            let data = ''
            res.on('data', (chunk) => {
              data += chunk.toString()
            })
            res.on('end', () =>
              resolve({
                status: res.statusCode!,
                body: JSON.parse(data),
                cors: res.headers['access-control-allow-origin'] as string | undefined
              })
            )
          }
        )
        req.on('error', reject)
        req.end(body)
      }
    )
  return { controller, call }
}

describe('optional legacy loopback controls', () => {
  it('refuses an absent or malformed control token at creation', () => {
    for (const candidate of ['', 'password', 'g'.repeat(64), 'a'.repeat(63)])
      expect(() => createSkillServer({} as never, candidate)).toThrow('skill_token_unavailable')
  })
  it('authenticates every route before controller access', async () => {
    const f = await fixture()
    for (const path of ['/skill/start', '/skill/pause', '/skill/status']) {
      expect(
        await f.call(path, { Authorization: '' }, '', path.endsWith('status') ? 'GET' : 'POST')
      ).toMatchObject({ status: 403, cors: undefined })
      expect(await f.call(path, { Authorization: `Bearer ${'b'.repeat(64)}` })).toMatchObject({
        status: 403
      })
    }
    expect(f.controller.start).not.toHaveBeenCalled()
    expect(f.controller.pause).not.toHaveBeenCalled()
    expect(f.controller.isRunning).not.toHaveBeenCalled()
  })
  it('blocks browser origins, fetch metadata and DNS rebinding even with a correct token', async () => {
    const f = await fixture()
    const forbiddenHeaders: Record<string, string>[] = [
      { Origin: 'https://example.com' },
      { Origin: 'null' },
      { Referer: 'https://example.com' },
      { 'Sec-Fetch-Site': 'none' },
      { Host: 'example.com' }
    ]
    for (const headers of forbiddenHeaders)
      expect(await f.call('/skill/start', headers)).toMatchObject({ status: 403, cors: undefined })
    expect(await f.call('/skill/start', {}, '', 'OPTIONS')).toMatchObject({
      status: 404,
      cors: undefined
    })
    expect(f.controller.start).not.toHaveBeenCalled()
  })
  it('rejects ignored payloads and oversized bodies without operating either runtime', async () => {
    const f = await fixture()
    expect(await f.call('/skill/start', {}, '{"account":"other"}')).toMatchObject({
      status: 400,
      body: { error: 'invalid_body' }
    })
    expect(await f.call('/skill/start', {}, 'x'.repeat(1025))).toMatchObject({ status: 413 })
    expect(f.controller.start).not.toHaveBeenCalled()
  })
  it('serializes control operations and still pauses when status reports stopped', async () => {
    const f = await fixture()
    let finish!: (result: { ok: boolean }) => void
    vi.mocked(f.controller.start).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const pending = f.call('/skill/start')
    await vi.waitFor(() => expect(f.controller.start).toHaveBeenCalledOnce())
    expect(await f.call('/skill/pause')).toMatchObject({
      status: 409,
      body: { error: 'operation_in_progress' }
    })
    finish({ ok: true })
    expect(await pending).toMatchObject({ status: 200 })
    expect(await f.call('/skill/pause', {}, '{}')).toMatchObject({ status: 200 })
    expect(f.controller.pause).toHaveBeenCalledOnce()
    expect(await f.call('/skill/status', {}, '', 'GET')).toMatchObject({
      status: 200,
      body: { status: 'stopped' }
    })
  })
  it('does not leak callback exceptions to HTTP clients or logs', async () => {
    const f = await fixture()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(f.controller.start).mockRejectedValue(new Error('model-key-customer-text'))
    expect(await f.call('/skill/start')).toMatchObject({
      status: 500,
      body: { error: 'engine_failed' }
    })
    expect(logged).not.toHaveBeenCalled()
    expect(await f.call('/skill/pause')).toMatchObject({ status: 200 })
  })
})
