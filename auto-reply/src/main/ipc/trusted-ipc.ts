import { BrowserWindow, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { pathToFileURL } from 'node:url'
import { assertLegacyChannel } from '../../preload/legacy-channels'

type RendererEvent = IpcMainEvent | IpcMainInvokeEvent

/** Query parameters select application panels; they never authorize another document. */
export function rendererUrlAllowed(
  sourceUrl: string,
  rendererFile: string,
  developerUrl?: string
): boolean {
  try {
    const source = new URL(sourceUrl)
    const expected = new URL(pathToFileURL(rendererFile).href)
    source.search = expected.search = ''
    source.hash = expected.hash = ''
    if (source.href === expected.href) return true
    if (!developerUrl) return false
    const development = new URL(developerUrl)
    development.search = development.hash = ''
    return (
      ['http:', 'https:'].includes(development.protocol) &&
      !source.username &&
      !source.password &&
      source.href === development.href
    )
  } catch {
    return false
  }
}

export function rendererTrust(
  rendererFile: string,
  developerUrl?: string
): (event: RendererEvent) => void {
  return (event) => {
    const frame = event.senderFrame
    if (
      !frame ||
      event.sender.isDestroyed() ||
      frame !== event.sender.mainFrame ||
      !BrowserWindow.fromWebContents(event.sender) ||
      !rendererUrlAllowed(frame.url, rendererFile, developerUrl)
    )
      throw new Error('untrusted_sender')
  }
}

/** Registration checks the same allowlist as preload; execution checks the actual sender. */
export function createLegacyIpc(
  rendererFile: string,
  developerUrl?: string
): {
  handle: typeof ipcMain.handle
  on: typeof ipcMain.on
} {
  const trusted = rendererTrust(rendererFile, developerUrl)
  return {
    handle(channel, listener) {
      assertLegacyChannel('invoke', channel)
      ipcMain.handle(channel, (event, ...args) => {
        trusted(event)
        return listener(event, ...args)
      })
    },
    on(channel, listener) {
      assertLegacyChannel('send', channel)
      ipcMain.on(channel, (event, ...args) => {
        // A forged fire-and-forget event must not throw through Electron's event loop.
        try {
          trusted(event)
        } catch {
          return
        }
        listener(event, ...args)
      })
      return ipcMain
    }
  }
}
