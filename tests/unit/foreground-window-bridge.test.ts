import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
const f = vi.hoisted(() => ({ spawn: vi.fn(), readFile: vi.fn() }))
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => 'fixture', once: vi.fn() }
}))
vi.mock('node:fs/promises', () => ({ readFile: f.readFile }))
vi.mock('node:child_process', () => ({ spawn: f.spawn }))
import { ForegroundWindowBridge } from '../../src/main/services/foreground-window-bridge'
type Request = { id: string; command: string }
const children: ReturnType<typeof helper>[] = []
const bridges: ForegroundWindowBridge[] = []
let respond: (request: Request) => object | undefined
function helper() {
  const child = new EventEmitter()
  const stdout = new PassThrough(),
    stderr = new PassThrough()
  const requests: Request[] = []
  const stdin = new Writable({
    write(chunk, _encoding, done) {
      const request = JSON.parse(String(chunk)) as Request
      requests.push(request)
      const value = respond(request)
      if (value) queueMicrotask(() => stdout.write(JSON.stringify(value) + '\n'))
      done()
    }
  })
  const kill = vi.fn(() => {
    queueMicrotask(() => child.emit('exit', 0))
    return true
  })
  return Object.assign(child, { stdout, stderr, stdin, requests, kill })
}
function bridge() {
  const value = new ForegroundWindowBridge()
  bridges.push(value)
  return value
}
beforeEach(() => {
  f.spawn.mockReset()
  f.readFile.mockReset()
  const binary = Buffer.from('pinned-helper-fixture')
  vi.stubGlobal('__FOREGROUND_WINDOW_SHA256__', createHash('sha256').update(binary).digest('hex'))
  f.readFile.mockResolvedValue(binary)
  respond = (request) => ({ id: request.id, ok: true, windows: [], foreground: '0' })
  f.spawn.mockImplementation(() => {
    const child = helper()
    children.push(child)
    return child
  })
})
afterEach(() => {
  for (const value of bridges.splice(0)) value.close()
  children.splice(0)
  vi.unstubAllGlobals()
})
describe('persistent pinned foreground helper', () => {
  it('passes through the native visible-surface result without changing the window binding', async () => {
    respond = (request) => ({
      id: request.id,
      ok: true,
      windows: [],
      foreground: '71',
      occluded: true,
      searchOccluded: false
    })
    expect(await bridge().inspect(new AbortController().signal)).toMatchObject({
      occluded: true,
      searchOccluded: false,
      foreground: '71'
    })
  })
  it('uses an explicit search command without weakening ordinary editor commands', async () => {
    const value = bridge(),
      signal = new AbortController().signal
    const binding = {
      id: '71',
      pid: 123,
      path: 'C:/Weixin.exe',
      startTicks: '1',
      bounds: { x: 0, y: 0, width: 800, height: 600 }
    }
    respond = (request) => ({
      id: request.id,
      ok: true,
      windows: [],
      foreground: '71',
      editorText: 'Q',
      occluded: true,
      searchOccluded: false
    })
    expect(await value.typeSearch(binding, 'Q', signal)).toBe('Q')
    expect(await value.typeText(binding, 'Q', signal)).toBe('Q')
    expect(children[0].requests.map((request) => request.command)).toEqual(['type_search', 'type'])
  })
  it('waits for a cancelled paste to restore the clipboard before rejecting, without killing or retrying it', async () => {
    const value = bridge(),
      controller = new AbortController()
    respond = () => undefined
    const binding = {
      id: '71',
      pid: 123,
      path: 'C:/Weixin.exe',
      startTicks: '1',
      bounds: { x: 0, y: 0, width: 800, height: 600 }
    }
    const work = value.typeText(binding, '你好🤣', controller.signal)
    const assertion = expect(work).rejects.toThrow('cancelled')
    await vi.waitFor(() => expect(children[0]?.requests).toHaveLength(1))
    controller.abort()
    expect(children[0].kill).not.toHaveBeenCalled()
    const request = children[0].requests[0]
    children[0].stdout.write(
      JSON.stringify({
        id: request.id,
        ok: true,
        windows: [],
        foreground: '71',
        editorText: '你好🤣'
      }) + '\n'
    )
    await assertion
    expect(children[0].kill).not.toHaveBeenCalled()
    expect(children[0].requests).toHaveLength(1)
  })
  it('serializes concurrent queries on one verified process with distinct request IDs', async () => {
    const value = bridge(),
      signal = new AbortController().signal
    await Promise.all([value.inspect(signal), value.inspect(signal), value.inspect(signal)])
    expect(f.spawn).toHaveBeenCalledTimes(1)
    expect(f.readFile).toHaveBeenCalledTimes(1)
    expect(new Set(children[0].requests.map((request) => request.id)).size).toBe(3)
    expect(children[0].kill).not.toHaveBeenCalled()
  })
  it('kills an in-flight request on cancellation and re-verifies before a new process', async () => {
    const value = bridge(),
      controller = new AbortController()
    respond = () => undefined
    const work = value.inspect(controller.signal)
    const assertion = expect(work).rejects.toThrow('cancelled')
    await vi.waitFor(() => expect(children[0]?.requests).toHaveLength(1))
    controller.abort()
    await assertion
    expect(children[0].kill).toHaveBeenCalledTimes(1)
    respond = (request) => ({ id: request.id, ok: true, windows: [], foreground: '0' })
    await value.inspect(new AbortController().signal)
    expect(f.spawn).toHaveBeenCalledTimes(2)
    expect(f.readFile).toHaveBeenCalledTimes(2)
  })
  it('does not send a queued request that was cancelled while another request was active', async () => {
    const value = bridge(),
      first = new AbortController(),
      second = new AbortController()
    respond = () => undefined
    const active = value.inspect(first.signal)
    const activeAssertion = expect(active).rejects.toThrow('cancelled')
    const queued = value.inspect(second.signal)
    const queuedAssertion = expect(queued).rejects.toThrow('cancelled')
    await vi.waitFor(() => expect(children[0]?.requests).toHaveLength(1))
    second.abort()
    first.abort()
    await Promise.all([activeAssertion, queuedAssertion])
    expect(f.spawn).toHaveBeenCalledTimes(1)
    expect(children[0].requests).toHaveLength(1)
  })
  it('rejects a mismatched response and kills the protocol session', async () => {
    const value = bridge()
    respond = () => ({
      id: '00000000-0000-4000-8000-000000000000',
      ok: true,
      windows: [],
      foreground: '0'
    })
    await expect(value.inspect(new AbortController().signal)).rejects.toThrow('window_query_failed')
    expect(children[0].kill).toHaveBeenCalledTimes(1)
  })
  it('keeps a complete native foreground refusal usable but never retries input', async () => {
    const value = bridge(),
      signal = new AbortController().signal
    respond = (request) => ({ id: request.id, ok: false, error: 'foreground_lost' })
    await expect(value.inspect(signal)).rejects.toThrow('foreground_lost')
    respond = (request) => ({ id: request.id, ok: true, windows: [], foreground: '0' })
    await value.inspect(signal)
    expect(f.spawn).toHaveBeenCalledTimes(1)
    expect(children[0].requests).toHaveLength(2)
  })
  it('refuses to launch a modified helper or issue requests after closing', async () => {
    const value = bridge(),
      signal = new AbortController().signal
    f.readFile.mockResolvedValue(Buffer.from('modified'))
    await expect(value.inspect(signal)).rejects.toThrow('desktop_input_unavailable')
    expect(f.spawn).not.toHaveBeenCalled()
    value.close()
    await expect(value.inspect(signal)).rejects.toThrow('desktop_input_unavailable')
  })
})
