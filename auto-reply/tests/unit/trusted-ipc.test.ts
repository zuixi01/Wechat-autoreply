import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const electron = vi.hoisted(() => ({
  handle: vi.fn(),
  on: vi.fn(),
  window: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: { handle: electron.handle, on: electron.on },
  BrowserWindow: { fromWebContents: electron.window }
}))
import { createLegacyIpc, rendererTrust, rendererUrlAllowed } from '../../src/main/ipc/trusted-ipc'
const file = resolve('out/renderer/index.html')
const fileUrl = pathToFileURL(file).href

function event(url = fileUrl): Parameters<ReturnType<typeof rendererTrust>>[0] {
  const frame = { url }
  return { senderFrame: frame, sender: { mainFrame: frame, isDestroyed: () => false } } as never
}

describe('main-process IPC trust', () => {
  beforeEach(() => electron.window.mockReturnValue({}))
  it('allows the exact renderer document and its panels only', () => {
    for (const url of [
      fileUrl,
      `${fileUrl}?window=settings&section=enterprise`,
      `${fileUrl}#workbench`
    ])
      expect(rendererUrlAllowed(url, file)).toBe(true)
    for (const url of [
      `${fileUrl}/else`,
      fileUrl.replace('index.html', 'overlay.html'),
      'about:blank',
      'invalid',
      'https://example.com/'
    ])
      expect(rendererUrlAllowed(url, file)).toBe(false)
  })
  it('does not treat the entire development origin as privileged', () => {
    const development = 'http://127.0.0.1:5173/'
    expect(rendererUrlAllowed(`${development}?window=memory`, file, development)).toBe(true)
    for (const url of [
      'http://127.0.0.1:5173/overlay.html',
      'http://127.0.0.1:5174/',
      'http://name:pass@127.0.0.1:5173/',
      'http://localhost:5173/'
    ])
      expect(rendererUrlAllowed(url, file, development)).toBe(false)
  })
  it('rejects subframes, detached frames, missing windows and destroyed senders', () => {
    const trust = rendererTrust(file)
    expect(() => trust(event())).not.toThrow()
    expect(() => trust({ ...event(), senderFrame: null } as never)).toThrow('untrusted_sender')
    expect(() => trust({ ...event(), senderFrame: { url: fileUrl } } as never)).toThrow(
      'untrusted_sender'
    )
    const destroyed = event()
    destroyed.sender.isDestroyed = () => true
    expect(() => trust(destroyed)).toThrow('untrusted_sender')
    electron.window.mockReturnValue(null)
    expect(() => trust(event())).toThrow('untrusted_sender')
  })
  it('guards real invoke handlers before settings, clipboard or engine side effects', () => {
    const api = createLegacyIpc(file)
    const handler = vi.fn(() => ({ success: true }))
    for (const channel of ['settings:set', 'reply:paste', 'engine:start']) {
      api.handle(channel, handler)
      const invoke = electron.handle.mock.calls.at(-1)![1]
      expect(() => invoke(event('https://example.com/'), 'private')).toThrow('untrusted_sender')
      expect(handler).not.toHaveBeenCalled()
    }
    const invoke = electron.handle.mock.calls.at(-1)![1]
    expect(invoke(event(), 'config')).toEqual({ success: true })
    expect(handler).toHaveBeenCalledOnce()
  })
  it('rejects unavailable registrations and silently drops forged event messages', () => {
    const api = createLegacyIpc(file)
    for (const channel of ['capture-screen', 'agent:register', 'test:vlm-parallel'])
      expect(() => api.handle(channel, vi.fn())).toThrow('ipc_channel_unavailable')
    const listener = vi.fn()
    api.on('mode:changed', listener)
    const deliver = electron.on.mock.calls.at(-1)![1]
    expect(() => deliver(event('about:blank'))).not.toThrow()
    expect(listener).not.toHaveBeenCalled()
    deliver(event())
    expect(listener).toHaveBeenCalledOnce()
  })
})
