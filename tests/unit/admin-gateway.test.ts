import { createServer } from 'node:http'
import { expect, it, vi } from 'vitest'
import { createAdminGateway } from '../../server/src/admin/gateway'

it('bounds concurrent administrator requests and releases admission after completion', async () => {
  const token = 'G'.repeat(43),
    releases: Array<() => void> = []
  const identity = vi.fn(async () => {
    await new Promise<void>((resolve) => releases.push(resolve))
    return { tenantId: 'A', actorId: 'admin' }
  })
  const admin = {
    identity,
    runtimeStatus: vi.fn(),
    requestPauseAll: vi.fn(),
    pauseAllRequest: vi.fn(),
    pauseAllAccounts: vi.fn()
  }
  const server = createServer(createAdminGateway(admin, { tenantId: 'A', token }))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test_address_missing')
  const call = () =>
    fetch(`http://127.0.0.1:${address.port}/v1/admin/operations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{"operation":"identity"}'
    })
  const requests = Array.from({ length: 8 }, call)
  try {
    await vi.waitFor(() => expect(identity).toHaveBeenCalledTimes(8))
    const busy = await call()
    expect(busy.status).toBe(429)
    expect(await busy.json()).toEqual({ code: 'busy' })
    releases.splice(0).forEach((release) => release())
    expect((await Promise.all(requests)).every((r) => r.status === 200)).toBe(true)
    const next = call()
    await vi.waitFor(() => expect(identity).toHaveBeenCalledTimes(9))
    releases.splice(0).forEach((release) => release())
    expect((await next).status).toBe(200)
  } finally {
    releases.splice(0).forEach((release) => release())
    await Promise.allSettled(requests)
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
  }
})
it('refuses malformed operator credentials at construction', () => {
  const admin = {
    identity: vi.fn(),
    runtimeStatus: vi.fn(),
    requestPauseAll: vi.fn(),
    pauseAllRequest: vi.fn(),
    pauseAllAccounts: vi.fn()
  }
  for (const token of ['', 'short', 'G'.repeat(44)])
    expect(() => createAdminGateway(admin, { tenantId: 'A', token })).toThrow()
})
