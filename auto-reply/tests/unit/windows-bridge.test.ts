import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fixturePackage, helperInfo } from '../helpers/native-package'
import { desktopActivity } from '../helpers/desktop-activity'
const mocked = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocked.spawn }))
import { WindowsBridge, nativeChildEnvironment } from '../../src/core/adapters/windows-bridge'

const roots: string[] = [],
  bridges: WindowsBridge[] = []
const binding = {
  handle: '123',
  processId: 456,
  processName: 'WeChat' as const,
  processStartTicks: '638000000000000000'
}
function probeResult() {
  return {
    formatVersion: 1,
    adapterVersion: '0.2.0',
    snapshotId: '8ae5b88d-7ea8-4d3a-ad8c-26ff4d3274ba',
    binding,
    capturedAt: 1000,
    clientFileVersion: 'synthetic-1',
    windowsVersion: '10.0.0',
    nodes: [
      {
        index: 0,
        parentIndex: null,
        depth: 0,
        runtimeId: [42, 456, 123],
        controlType: 'ControlType.Window',
        className: 'synthetic',
        automationId: '',
        offscreen: false,
        enabled: true,
        patterns: []
      }
    ],
    incompleteReasons: [],
    truncated: false,
    elapsedMs: 12,
    foregroundBeforeHandle: '99',
    foregroundAfterHandle: '99',
    foregroundChangedAtEnd: false,
    backgroundReadVerified: false,
    nonInterferingSendVerified: false,
    identityVerified: false,
    conclusion: 'metadata_only_requires_platform_validation'
  }
}
function child(answer: unknown = helperInfo, close = true) {
  const process = new EventEmitter()
  const stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() })
  const stdin = Object.assign(new EventEmitter(), {
    write: vi.fn((line: string) => {
      if (answer === null) return
      const request = JSON.parse(line)
      queueMicrotask(() =>
        stdout.emit(
          'data',
          JSON.stringify({
            protocolVersion: 1,
            requestId: request.requestId,
            ok: true,
            result: answer
          }) + '\n'
        )
      )
    }),
    end: vi.fn(() => {
      if (close) queueMicrotask(() => process.emit('close', 0))
    })
  })
  return Object.assign(process, {
    stdout,
    stdin,
    stderr: { resume: vi.fn() },
    kill: vi.fn(() => {
      if (close) queueMicrotask(() => process.emit('close', 0))
    })
  })
}
async function fixture(version: '0.2.0' | '0.3.0' | '0.4.0' = '0.2.0') {
  const f = await fixturePackage(version)
  roots.push(f.root)
  const bridge = await WindowsBridge.fromPackage(f.root, f.pin)
  bridges.push(bridge)
  return { ...f, bridge }
}
beforeEach(() => mocked.spawn.mockReset())
afterEach(async () => {
  vi.useRealTimers()
  for (const bridge of bridges.splice(0)) await bridge.stop().catch(() => {})
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
describe('native process authority and lifecycle', () => {
  it('retains in-interval events even when the two endpoint windows are equal', async () => {
    const f = await fixture('0.4.0'),
      result = {
        ...probeResult(),
        formatVersion: 3,
        adapterVersion: '0.4.0',
        treeView: 'raw',
        desktopActivity: desktopActivity(),
        nodes: probeResult().nodes.map((node) => ({
          ...node,
          isControlElement: true,
          isContentElement: false
        }))
      }
    mocked.spawn.mockReturnValue(child(result))
    expect(await f.bridge.probe(binding, undefined, 'raw')).toMatchObject({
      foregroundChangedAtEnd: false,
      desktopActivity: { foregroundEvents: 2, observerStopped: true, noInterferenceVerified: false }
    })
  })
  it.each(['privacy', 'authority', 'stop', 'incomplete'])(
    'rejects invalid %s activity evidence and closes the process',
    async (kind) => {
      const f = await fixture('0.4.0'),
        result = {
          ...probeResult(),
          formatVersion: 3,
          adapterVersion: '0.4.0',
          treeView: 'raw',
          desktopActivity: desktopActivity(),
          nodes: probeResult().nodes.map((node) => ({
            ...node,
            isControlElement: true,
            isContentElement: false
          }))
        }
      if (kind === 'privacy')
        Object.assign(result.desktopActivity, { clipboardText: 'PRIVATE_CONTENT' })
      if (kind === 'authority')
        Object.assign(result.desktopActivity, { noInterferenceVerified: true })
      if (kind === 'stop') Object.assign(result.desktopActivity, { observerStopped: false })
      if (kind === 'incomplete')
        Object.assign(result.desktopActivity, {
          complete: false,
          incompleteReasons: ['hook_unavailable'],
          foregroundHookInstalled: false
        })
      const p = child(result)
      mocked.spawn.mockReturnValue(p)
      await expect(f.bridge.probe(binding, undefined, 'raw')).rejects.toThrow(
        'native_probe_evidence_invalid'
      )
      expect(p.stdin.end).toHaveBeenCalledOnce()
    }
  )
  it('rejects raw traversal on a legacy helper before starting or enumerating any process', async () => {
    const f = await fixture()
    await expect(f.bridge.probe(binding, undefined, 'raw')).rejects.toThrow(
      'native_probe_view_unsupported'
    )
    expect(mocked.spawn).not.toHaveBeenCalled()
  })
  it.each(['control', 'raw'] as const)(
    'binds %s traversal to the new manifest version and exact requested view',
    async (treeView) => {
      const f = await fixture('0.3.0'),
        result = {
          ...probeResult(),
          formatVersion: 2,
          adapterVersion: '0.3.0',
          treeView,
          nodes: probeResult().nodes.map((node) => ({
            ...node,
            isControlElement: true,
            isContentElement: false
          }))
        },
        p = child(result)
      mocked.spawn.mockReturnValue(p)
      expect(await f.bridge.probe(binding, undefined, treeView)).toEqual(result)
      expect(JSON.parse(p.stdin.write.mock.calls[0][0])).toMatchObject({
        command: 'probe',
        binding,
        treeView
      })
    }
  )
  it.each(['version', 'view', 'missing-view', 'text'])(
    'closes a new helper after mismatched %s evidence',
    async (kind) => {
      const f = await fixture('0.3.0')
      const answer = {
        ...probeResult(),
        formatVersion: 2,
        adapterVersion: '0.3.0',
        treeView: 'raw',
        nodes: probeResult().nodes.map((node) => ({
          ...node,
          isControlElement: true,
          isContentElement: false
        }))
      }
      if (kind === 'view') answer.treeView = 'control'
      if (kind === 'missing-view') delete (answer as Partial<typeof answer>).treeView
      if (kind === 'text') Object.assign(answer.nodes[0], { text: 'PRIVATE_CUSTOMER_TEXT' })
      const p = child(kind === 'version' ? probeResult() : answer)
      mocked.spawn.mockReturnValue(p)
      await expect(f.bridge.probe(binding, undefined, 'raw')).rejects.toThrow(
        'native_probe_evidence_invalid'
      )
      expect(p.stdin.end).toHaveBeenCalledOnce()
    }
  )
  it('requires info to match the pinned manifest version and declared exact read-only views', async () => {
    const f = await fixture('0.3.0'),
      p = child(helperInfo)
    mocked.spawn.mockReturnValue(p)
    await expect(f.bridge.info()).rejects.toThrow('native_adapter_version_mismatch')
    expect(p.stdin.end).toHaveBeenCalledOnce()
    const advanced = { ...helperInfo, adapterVersion: '0.3.0', probeViews: ['control', 'raw'] }
    mocked.spawn.mockReturnValue(child(advanced))
    expect(await f.bridge.info()).toEqual(advanced)
  })
  it.each(['text', 'duplicate'])(
    'rejects invalid %s window lists and closes the helper',
    async (kind) => {
      const f = await fixture(),
        answer =
          kind === 'text'
            ? { windows: [binding], identityVerified: false, text: 'unexpected chat text' }
            : { windows: [binding, binding], identityVerified: false }
      const p = child(answer)
      mocked.spawn.mockReturnValue(p)
      await expect(f.bridge.listWindows()).rejects.toThrow('native_window_evidence_invalid')
      expect(p.stdin.end).toHaveBeenCalledOnce()
    }
  )
  it.each([
    'binding',
    'binding-nonnumeric',
    'tree',
    'text',
    'capability',
    'truncated',
    'foreground',
    'runtime-id'
  ])('rejects invalid %s probe evidence and closes the process', async (kind) => {
    const f = await fixture(),
      result = probeResult()
    if (kind === 'binding') result.binding = { ...binding, processId: 789 }
    if (kind === 'binding-nonnumeric') result.binding = { ...binding, handle: 'not-a-handle' }
    if (kind === 'tree') result.nodes[0].parentIndex = 0 as never
    if (kind === 'text') Object.assign(result.nodes[0], { name: 'PRIVATE_CUSTOMER_TEXT' })
    if (kind === 'capability') result.identityVerified = true
    if (kind === 'truncated') result.truncated = true
    if (kind === 'foreground') result.foregroundAfterHandle = '88'
    if (kind === 'runtime-id') result.nodes[0].runtimeId = []
    const p = child(result)
    mocked.spawn.mockReturnValue(p)
    await expect(f.bridge.probe(binding)).rejects.toThrow('native_probe_evidence_invalid')
    expect(p.stdin.end).toHaveBeenCalledOnce()
  })
  it('keeps bounded probe evidence tied to the exact requested instance without granting capabilities', async () => {
    const f = await fixture(),
      result = probeResult()
    mocked.spawn.mockReturnValue(child(result))
    expect(await f.bridge.probe(binding)).toEqual(result)
  })
  it('starts only the pinned executable, with no arguments or shell', async () => {
    const f = await fixture(),
      p = child()
    mocked.spawn.mockReturnValue(p)
    expect(await f.bridge.info()).toEqual(helperInfo)
    expect(mocked.spawn).toHaveBeenCalledWith(
      join(f.root, 'WindowsAdapter.exe'),
      [],
      expect.objectContaining({ windowsHide: true, shell: false, cwd: f.root })
    )
    await f.bridge.stop()
    expect(p.stdin.end).toHaveBeenCalledOnce()
  })
  it('removes inherited runtime/startup hooks case-insensitively', () => {
    expect(
      nativeChildEnvironment({
        PATH: 'safe',
        dotnet_startup_hooks: 'bad',
        CORECLR_PROFILER: 'bad',
        COMPLUS_ReadyToRun: 'bad',
        COR_ENABLE_PROFILING: 'bad'
      })
    ).toEqual({ PATH: 'safe' })
  })
  it('rechecks files before a restarted process', async () => {
    const f = await fixture()
    mocked.spawn.mockImplementation(() => child())
    await f.bridge.info()
    await f.bridge.stop()
    await writeFile(join(f.root, 'WindowsAdapter.exe'), 'changed')
    await expect(f.bridge.info()).rejects.toThrow('native_package_untrusted')
    expect(mocked.spawn).toHaveBeenCalledOnce()
  })
  it('rejects unsupported versions and stops the process', async () => {
    const f = await fixture(),
      p = child({ ...helperInfo, adapterVersion: '99.0' })
    mocked.spawn.mockReturnValue(p)
    await expect(f.bridge.info()).rejects.toThrow('native_adapter_version_mismatch')
    expect(p.stdin.end).toHaveBeenCalledOnce()
  })
  it('rejects fabricated verified capability claims', async () => {
    const f = await fixture()
    mocked.spawn.mockReturnValue(child({ ...helperInfo, identityVerified: true }))
    await expect(f.bridge.info()).rejects.toThrow('native_adapter_version_mismatch')
  })
  it('pre-aborted work never starts a child', async () => {
    const f = await fixture(),
      abort = new AbortController()
    abort.abort()
    await expect(f.bridge.info(abort.signal)).rejects.toThrow('native_adapter_cancelled')
    expect(mocked.spawn).not.toHaveBeenCalled()
  })
  it('cancels in-flight work and confirms child close', async () => {
    const f = await fixture(),
      p = child(null),
      abort = new AbortController()
    mocked.spawn.mockReturnValue(p)
    const result = f.bridge.info(abort.signal)
    const checked = expect(result).rejects.toThrow('native_adapter_cancelled')
    await vi.waitFor(() => expect(p.stdin.write).toHaveBeenCalledOnce())
    abort.abort()
    await checked
    await f.bridge.stop()
    expect(p.stdin.end).toHaveBeenCalledOnce()
  })
  it('rejects malformed stdout and fails every waiting request', async () => {
    const f = await fixture(),
      p = child(null)
    mocked.spawn.mockReturnValue(p)
    const checked = expect(f.bridge.info()).rejects.toThrow('native_adapter_stopped')
    await vi.waitFor(() => expect(p.stdin.write).toHaveBeenCalledOnce())
    p.stdout.emit('data', 'not json\n')
    await checked
    await f.bridge.stop()
  })
  it('times out stalled requests and closes the helper', async () => {
    const f = await fixture(),
      p = child(null)
    mocked.spawn.mockReturnValue(p)
    const checked = expect(f.bridge.info()).rejects.toThrow('native_adapter_timeout')
    await vi.waitFor(() => expect(p.stdin.write).toHaveBeenCalledOnce())
    await checked
    await f.bridge.stop()
    expect(p.stdin.end).toHaveBeenCalledOnce()
  }, 10000)
  it('bounds pending work without spawning additional children', async () => {
    const f = await fixture(),
      p = child(null)
    mocked.spawn.mockReturnValue(p)
    const waiting = Array.from({ length: 16 }, () =>
      f.bridge.info().catch((error) => error.message)
    )
    await vi.waitFor(() => expect(p.stdin.write).toHaveBeenCalledTimes(16))
    await expect(f.bridge.info()).rejects.toThrow('native_adapter_overloaded')
    await f.bridge.stop()
    expect(await Promise.all(waiting)).toEqual(Array(16).fill('native_adapter_stopped'))
    expect(mocked.spawn).toHaveBeenCalledOnce()
  })
  it('fails and stops on a synchronous broken stdin write', async () => {
    const f = await fixture(),
      p = child(null)
    p.stdin.write.mockImplementation(() => {
      throw new Error('broken pipe')
    })
    mocked.spawn.mockReturnValue(p)
    await expect(f.bridge.info()).rejects.toThrow('native_adapter_stopped')
    await f.bridge.stop()
  })
  it('still confirms close when ending stdin throws', async () => {
    const f = await fixture(),
      p = child()
    p.stdin.end.mockImplementation(() => {
      throw new Error('broken pipe')
    })
    mocked.spawn.mockReturnValue(p)
    await f.bridge.info()
    await f.bridge.stop()
    expect(p.kill).toHaveBeenCalledOnce()
  })
  it('rejects excess stdout bytes before parsing them', async () => {
    const f = await fixture(),
      p = child(null)
    mocked.spawn.mockReturnValue(p)
    const checked = expect(f.bridge.info()).rejects.toThrow('native_adapter_stopped')
    await vi.waitFor(() => expect(p.stdin.write).toHaveBeenCalledOnce())
    p.stdout.emit('data', '中'.repeat(700000))
    await checked
    await f.bridge.stop()
  })
  it('does not restart until a previously unconfirmed child actually closes', async () => {
    const f = await fixture(),
      p = child(helperInfo, false)
    mocked.spawn.mockReturnValue(p)
    await f.bridge.info()
    await expect(f.bridge.stop()).rejects.toThrow('native_adapter_stop_unconfirmed')
    await expect(f.bridge.info()).rejects.toThrow('native_adapter_stop_unconfirmed')
    expect(mocked.spawn).toHaveBeenCalledOnce()
    expect(p.kill).toHaveBeenCalledOnce()
    p.emit('close', 0)
    mocked.spawn.mockReturnValue(child())
    await f.bridge.info()
    expect(mocked.spawn).toHaveBeenCalledTimes(2)
  })
})
