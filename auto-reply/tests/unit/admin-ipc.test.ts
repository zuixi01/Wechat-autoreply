import { beforeEach, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  connect: vi.fn(),
  pauseAll: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) =>
      state.handlers.set(name, handler)
  },
  BrowserWindow: { fromWebContents: () => ({}) }
}))
vi.mock('../../src/main/services/admin-connection', () => ({
  AdminConnection: class {
    connect = state.connect
    pauseAll = state.pauseAll
  }
}))
import { registerAdminIpc } from '../../src/main/ipc/admin-ipc'
const file = resolve('out/renderer/index.html')
function event(url: string) {
  const frame = { url }
  return { senderFrame: frame, sender: { mainFrame: frame, isDestroyed: () => false } }
}
beforeEach(() => {
  state.handlers.clear()
  state.connect.mockClear()
  state.pauseAll.mockClear()
  registerAdminIpc(file, resolve('.local/admin-ipc-unused'))
})
it('guards every operator IPC before using any credentials or pausing accounts', () => {
  expect(state.handlers.size).toBe(7)
  for (const handler of state.handlers.values())
    expect(() => handler(event('https://foreign.invalid'), {})).toThrow('untrusted_sender')
  expect(state.connect).not.toHaveBeenCalled()
  expect(state.pauseAll).not.toHaveBeenCalled()
  const input = { requestId: 'synthetic' }
  state.handlers.get('admin:pause-all')!(event(pathToFileURL(file).href), input)
  expect(state.pauseAll).toHaveBeenCalledWith(input)
})
