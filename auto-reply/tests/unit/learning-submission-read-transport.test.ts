import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { IpcMainInvokeEvent } from 'electron'
import type { DesktopAgentRuntime } from '../../src/main/services/desktop-agent-runtime'
import type { LearningSubmissionDesktopApi } from '../../src/shared/contracts/learning-submission-desktop'
import {
  LearningSubmissionReadResultSchema,
  parseLearningSubmissionReadResponse
} from '../../src/shared/contracts/learning-submission-desktop'
import { registerLearningSubmissionIpc } from '../../src/main/ipc/learning-submission-ipc'

const electron = vi.hoisted(() => ({
  handle: vi.fn(),
  invoke: vi.fn(),
  expose: vi.fn(),
  window: vi.fn(() => ({}))
}))
vi.mock('electron', () => ({
  ipcMain: { handle: electron.handle },
  ipcRenderer: { invoke: electron.invoke },
  contextBridge: { exposeInMainWorld: electron.expose },
  BrowserWindow: { fromWebContents: electron.window }
}))

const scope = { workspaceId: 'local', platform: 'generic' as const, conversationId: 'customer' }
const receipt = {
  sourceId: '11111111-1111-4111-8111-111111111111',
  kind: 'manual' as const,
  state: 'saved' as const,
  firstSubmittedAt: 100,
  evidenceAt: 100
}
const file = resolve('out/renderer/index.html')
const frame = { url: pathToFileURL(file).href }
const event = {
  senderFrame: frame,
  sender: { mainFrame: frame, isDestroyed: () => false }
} as unknown as IpcMainInvokeEvent
let api: LearningSubmissionDesktopApi

beforeAll(async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'contextIsolated')
  Object.defineProperty(process, 'contextIsolated', { configurable: true, value: true })
  try {
    await import('../../src/preload/index')
    api = electron.expose.mock.calls.find(([name]) => name === 'learningSubmissions')?.[1]
    expect(api).toBeDefined()
  } finally {
    if (descriptor) Object.defineProperty(process, 'contextIsolated', descriptor)
    else Reflect.deleteProperty(process, 'contextIsolated')
  }
})
beforeEach(() => {
  electron.handle.mockReset()
  electron.invoke.mockReset()
})
function setup(guard = vi.fn(), withGuard = true) {
  const read = vi.fn(() => [receipt])
  const runtime = { learningSubmissions: read } as unknown as DesktopAgentRuntime
  registerLearningSubmissionIpc(file, undefined, runtime, withGuard ? guard : undefined)
  const handler = electron.handle.mock.calls.find(
    ([channel]) => channel === 'learning-submission:receipts'
  )?.[1] as (event: IpcMainInvokeEvent, raw: unknown) => unknown
  // Model the serializable main/preload boundary; actual contextBridge is a desktop check.
  electron.invoke.mockImplementation(async (_channel, input) =>
    JSON.parse(JSON.stringify(handler(event, input)))
  )
  return { read, guard, handler }
}

describe('learning submission read transport', () => {
  it('validates renderer, request and authority before reading or wrapping errors', () => {
    const f = setup()
    const badFrame = { url: 'https://untrusted.example' }
    const badEvent = {
      senderFrame: badFrame,
      sender: { mainFrame: badFrame, isDestroyed: () => false }
    } as unknown as IpcMainInvokeEvent
    expect(() => f.handler(badEvent, { scope })).toThrow('untrusted_sender')
    expect(() => f.handler(event, { scope: { ...scope, workspaceId: '' } })).toThrow()
    expect(() => f.handler(event, { scope, authorityId: 'forged' })).toThrow()
    expect(f.guard).not.toHaveBeenCalled()
    expect(f.read).not.toHaveBeenCalled()
    const denied = Object.assign(new Error('permission_revoked'), { code: 'network_unavailable' })
    f.guard.mockImplementation(() => {
      throw denied
    })
    expect(() => f.handler(event, { scope })).toThrow(denied)
    expect(f.read).not.toHaveBeenCalled()
  })

  it('transports only explicit network and SQLite busy codes as plain unavailable results', async () => {
    const f = setup()
    for (const error of [
      { code: 'network_unavailable', message: 'private body / credential' },
      { code: 'ERR_SQLITE_ERROR', errcode: 5, message: 'private body / credential' },
      { code: 'ERR_SQLITE_ERROR', errcode: 6, message: 'private body / credential' }
    ]) {
      f.read.mockImplementation(() => {
        throw error
      })
      const code = error.code === 'network_unavailable' ? error.code : 'storage_busy'
      const result = await api.readSubmissions({ scope })
      expect(result).toEqual({ status: 'unavailable', code })
      expect(LearningSubmissionReadResultSchema.parse(JSON.parse(JSON.stringify(result)))).toEqual(
        result
      )
      expect(JSON.stringify(result)).not.toContain('private')
      await expect(api.submissions({ scope })).rejects.toThrow(code)
    }
    expect(f.guard).toHaveBeenCalledWith(scope)
  })

  it('does not infer transient errors from messages, authorization codes or unrelated SQLite codes', async () => {
    const f = setup()
    for (const error of [
      new Error('network_unavailable SQLITE_BUSY database is locked'),
      Object.assign(new Error('permission_revoked'), { code: 'permission_revoked' }),
      Object.assign(new Error('SQLite authorization'), { code: 'ERR_SQLITE_ERROR', errcode: 23 }),
      Object.assign(new Error('extended busy'), { code: 'ERR_SQLITE_ERROR', errcode: 261 }),
      Object.assign(new Error('wrong namespace'), { code: 'SQLITE_BUSY', errcode: 5 })
    ]) {
      f.read.mockImplementation(() => {
        throw error
      })
      expect(() => f.handler(event, { scope })).toThrow(error)
      await expect(api.readSubmissions({ scope })).rejects.toBe(error)
    }
  })

  it('keeps existing registrations without an authority guard fail closed', () => {
    const f = setup(vi.fn(), false)
    const error = Object.assign(new Error('network_unavailable'), { code: 'network_unavailable' })
    f.read.mockImplementation(() => {
      throw error
    })
    expect(() => f.handler(event, { scope })).toThrow(error)
    expect(f.guard).not.toHaveBeenCalled()
  })

  it('rejects malformed IPC payloads with a safe error and no transient code', async () => {
    for (const malformed of [
      { status: 'unavailable', code: 'storage_busy', body: 'secret' },
      { status: 'unavailable', code: 'permission_revoked' },
      { status: 'transient', code: 'network_unavailable' },
      { status: 'available', receipts: [receipt] },
      [{ ...receipt, secret: 'body' }],
      null
    ]) {
      electron.invoke.mockResolvedValue(malformed)
      await expect(api.readSubmissions({ scope })).rejects.toThrow(
        'learning_submission_response_invalid'
      )
      await expect(api.readSubmissions({ scope })).rejects.not.toHaveProperty('code')
      await expect(api.submissions({ scope })).rejects.toThrow(
        'learning_submission_response_invalid'
      )
    }
  })

  it('preserves arrays for legacy callers and wraps only validated receipts for the readonly API', async () => {
    const f = setup()
    expect(f.handler(event, { scope })).toEqual([receipt])
    expect(await api.submissions({ scope })).toEqual([receipt])
    expect(await api.readSubmissions({ scope })).toEqual({
      status: 'available',
      receipts: [receipt]
    })
    f.read.mockReturnValue([])
    expect(await api.submissions({ scope })).toEqual([])
    expect(await api.readSubmissions({ scope })).toEqual({ status: 'available', receipts: [] })
    expect(parseLearningSubmissionReadResponse([receipt])).toEqual([receipt])
    expect(() =>
      LearningSubmissionReadResultSchema.parse({ status: 'available', receipts: [], extra: true })
    ).toThrow()
  })
})
