import { beforeEach, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const electron = vi.hoisted(() => ({ handle: vi.fn(), window: vi.fn() }))
vi.mock('electron', () => ({
  ipcMain: { handle: electron.handle },
  BrowserWindow: { fromWebContents: electron.window }
}))
import { registerRestorationIpc } from '../../src/main/ipc/restoration-ipc'
import { assertLegacyChannel } from '../../src/preload/legacy-channels'

const file = resolve('out/renderer/index.html')
function event(url = pathToFileURL(file).href) {
  const frame = { url }
  return { senderFrame: frame, sender: { mainFrame: frame, isDestroyed: () => false } }
}
function setup() {
  const runtime = {
    applyRestoreDecision: vi.fn(async () => ({
      success: false as const,
      code: 'unavailable' as const
    })),
    restorationStatus: vi.fn(() => ({ state: 'review_required' as const })),
    submitRestorePause: vi.fn(async () => ({
      success: false as const,
      code: 'unavailable' as const
    })),
    submitRestoreInventory: vi.fn(async () => ({
      success: false as const,
      code: 'unavailable' as const
    }))
  }
  registerRestorationIpc(file, undefined, runtime)
  const invoke = (channel: string, input: unknown = {}, sender = event()) => {
    const handler = electron.handle.mock.calls.find((call) => call[0] === channel)?.[1]
    if (!handler) throw new Error('handler_missing')
    return handler(sender, input)
  }
  return { runtime, invoke }
}
beforeEach(() => {
  electron.handle.mockClear()
  electron.window.mockReturnValue({})
})

it('rejects foreign frames and renderer authority before any restoration access', () => {
  const { runtime, invoke } = setup()
  for (const channel of [
    'agent-restoration:status',
    'agent-restoration:submit-pause',
    'agent-restoration:submit-inventory',
    'agent-restoration:apply-decision'
  ]) {
    expect(() => invoke(channel, {}, event('https://example.com/'))).toThrow('untrusted_sender')
    const child = event()
    child.senderFrame = { url: child.senderFrame.url }
    expect(() => invoke(channel, {}, child)).toThrow('untrusted_sender')
    for (const input of [undefined, { caseId: 'forged' }, { stopped: true }, { path: 'ledger' }]) {
      const handler = electron.handle.mock.calls.find((call) => call[0] === channel)![1]
      expect(() => handler(event(), input)).toThrow()
    }
    expect(() => assertLegacyChannel('invoke', channel)).toThrow()
  }
  expect(runtime.restorationStatus).not.toHaveBeenCalled()
  expect(runtime.submitRestorePause).not.toHaveBeenCalled()
  expect(runtime.submitRestoreInventory).not.toHaveBeenCalled()
  expect(runtime.applyRestoreDecision).not.toHaveBeenCalled()
})

it('exposes only validated metadata and a host-owned pause submission', async () => {
  const { runtime, invoke } = setup()
  expect(invoke('agent-restoration:status')).toEqual({ state: 'review_required' })
  expect(await invoke('agent-restoration:submit-pause')).toEqual({
    success: false,
    code: 'unavailable'
  })
  expect(runtime.submitRestorePause).toHaveBeenCalledWith({})
  expect(await invoke('agent-restoration:submit-inventory')).toEqual({
    success: false,
    code: 'unavailable'
  })
  expect(runtime.submitRestoreInventory).toHaveBeenCalledWith({})
  expect(await invoke('agent-restoration:apply-decision')).toEqual({
    success: false,
    code: 'unavailable'
  })
  expect(runtime.applyRestoreDecision).toHaveBeenCalledWith({})
  runtime.restorationStatus.mockReturnValue({ state: 'forged' as 'review_required' })
  expect(() => invoke('agent-restoration:status')).toThrow()
})
