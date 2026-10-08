import { createServer, type Server } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { listenFetchLoopback } from '../fixtures/fetch-loopback'

function allocatedPorts(ports: number[]) {
  const server = createServer()
  const listen = vi.spyOn(server, 'listen').mockImplementation(((...args: unknown[]) => {
    queueMicrotask(() => (args.at(-1) as () => void)())
    return server
  }) as Server['listen'])
  const close = vi.spyOn(server, 'close').mockImplementation((callback) => {
    callback?.()
    return server
  })
  const address = vi.spyOn(server, 'address')
  for (const port of ports)
    address.mockReturnValueOnce({ port, address: '127.0.0.1', family: 'IPv4' })
  return { server, listen, close }
}

describe('fetch-compatible synthetic loopback server', () => {
  it('releases allocated reserved ports before exposing the HTTP fixture', async () => {
    const f = allocatedPorts([6000, 6667, 49152])
    expect(await listenFetchLoopback(f.server)).toBe('http://127.0.0.1:49152')
    expect(f.listen).toHaveBeenCalledTimes(3)
    expect(f.close).toHaveBeenCalledTimes(2)
    for (const call of f.listen.mock.calls)
      expect(call).toEqual([0, '127.0.0.1', expect.any(Function)])
  })

  it('retains a bound and cleans every rejected allocation without falling back to a public listener', async () => {
    const f = allocatedPorts(Array<number>(16).fill(6667))
    await expect(listenFetchLoopback(f.server)).rejects.toThrow('fetch_loopback_port_unavailable')
    expect(f.listen).toHaveBeenCalledTimes(16)
    expect(f.close).toHaveBeenCalledTimes(16)
  })

  it('serves an actual Node fetch on the OS-assigned private listener', async () => {
    const server = createServer((_request, response) => response.end('synthetic-http'))
    try {
      const base = await listenFetchLoopback(server),
        url = new URL(base)
      expect(url.hostname).toBe('127.0.0.1')
      expect(Number(url.port)).toBeGreaterThan(0)
      expect(await (await fetch(base)).text()).toBe('synthetic-http')
    } finally {
      server.closeAllConnections()
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
