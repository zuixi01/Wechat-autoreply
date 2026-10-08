import { describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ windows: [] as unknown[] }))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  const { pathToFileURL } = await import('node:url')
  class Window extends EventEmitter {
    destroyed = false
    webContents = {
      mainFrame: { url: '' },
      isDestroyed: () => this.destroyed,
      send: vi.fn(),
      once: vi.fn()
    }
    constructor() {
      super()
      state.windows.push(this)
    }
    setVisibleOnAllWorkspaces() {
      return undefined
    }
    getContentBounds() {
      return { x: 0, y: 0 }
    }
    loadFile(path: string) {
      this.webContents.mainFrame.url = pathToFileURL(path).href
    }
    isDestroyed() {
      return this.destroyed
    }
    destroy() {
      this.destroyed = true
      this.emit('closed')
    }
    static fromWebContents(contents: unknown) {
      return state.windows.find((win) => (win as Window).webContents === contents)
    }
  }
  return {
    BrowserWindow: Window,
    ipcMain: new EventEmitter(),
    screen: {
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      getDisplayNearestPoint: () => ({
        id: 1,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        scaleFactor: 1
      })
    }
  }
})
import { ipcMain } from 'electron'
import { isWizardOpen, runBoxSelectWizard } from '../../src/main/overlay-window'
import { WizardCompletionSchema } from '../../src/main/ipc/wizard-payload'

const regions = {
  contactList: { x: -100, y: 0, width: 100, height: 500 },
  chatMain: { x: 0, y: 0, width: 500, height: 500 },
  inputBox: { x: 0, y: 500, width: 500, height: 100 },
  unreadIndicator: null,
  capturedAt: Date.now()
}

describe('wizard ownership boundary (synthetic windows only)', () => {
  it('rejects non-finite and malformed geometry while accepting negative monitor origins', () => {
    const payload = { id: 'wizard-1790960000000-1', regions }
    expect(WizardCompletionSchema.safeParse(payload).success).toBe(true)
    for (const patch of [
      { width: 0 },
      { x: Infinity },
      { width: NaN },
      { height: 70000 },
      { secret: 'extra' }
    ])
      expect(
        WizardCompletionSchema.safeParse({
          ...payload,
          regions: { ...regions, inputBox: { ...regions.inputBox, ...patch } }
        }).success
      ).toBe(false)
    expect(WizardCompletionSchema.safeParse({ ...payload, accountId: 'forged' }).success).toBe(
      false
    )
  })
  it('ignores other windows and subframes, keeps ready delivery intact and cleans its dynamic listener', async () => {
    const pending = runBoxSelectWizard({ appType: 'wechat' })
    const win = state.windows.at(-1) as {
      webContents: { mainFrame: { url: string }; send: ReturnType<typeof vi.fn> }
    }
    const channel = ipcMain
      .eventNames()
      .find((name) => String(name).startsWith('overlay-wizard:request-init:'))!
    const id = String(channel).slice('overlay-wizard:request-init:'.length)
    const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame }
    const foreign = { sender: {}, senderFrame: win.webContents.mainFrame }
    ipcMain.emit(channel, foreign)
    expect(win.webContents.send).not.toHaveBeenCalled()
    expect(ipcMain.listenerCount(channel)).toBe(1)
    ipcMain.emit(channel, event)
    expect(win.webContents.send).toHaveBeenCalledOnce()
    ipcMain.emit('overlay-wizard:complete', foreign, { id, regions })
    ipcMain.emit(
      'overlay-wizard:cancel',
      { ...event, senderFrame: { ...event.senderFrame } },
      { id }
    )
    ipcMain.emit('overlay-wizard:complete', event, {
      id,
      regions: { ...regions, inputBox: { ...regions.inputBox, width: -1 } }
    })
    expect(isWizardOpen()).toBe(true)
    ipcMain.emit('overlay-wizard:complete', event, { id, regions })
    expect(await pending).toEqual({ ok: true, regions })
    expect(ipcMain.listenerCount(channel)).toBe(0)
    expect(isWizardOpen()).toBe(false)
  })
  it('cleans the ready listener when the employee closes a wizard without completing', async () => {
    const pending = runBoxSelectWizard({ appType: 'wework' })
    const channel = ipcMain
      .eventNames()
      .find((name) => String(name).startsWith('overlay-wizard:request-init:'))!
    ;(state.windows.at(-1) as { destroy(): void }).destroy()
    expect(await pending).toEqual({ ok: false, reason: 'closed' })
    expect(ipcMain.listenerCount(channel)).toBe(0)
  })
})
