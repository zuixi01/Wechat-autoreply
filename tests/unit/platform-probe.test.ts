import { expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  collectPlatformProbe,
  parsePlatformProbeArgs
} from '../../src/core/adapters/platform-probe'
import { helperInfo } from '../helpers/native-package'
import { desktopActivity } from '../helpers/desktop-activity'
const binding = {
  handle: '123',
  processId: 456,
  processName: 'WeChat' as const,
  processStartTicks: '638000000000000000'
}
const release = randomUUID(),
  pin = 'a'.repeat(64)
function fixture() {
  const report = {
    formatVersion: 1,
    adapterVersion: '0.2.0',
    snapshotId: randomUUID(),
    binding,
    capturedAt: 1000,
    clientFileVersion: 'synthetic-1',
    windowsVersion: 'synthetic-Windows',
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
  const driver = {
    info: vi.fn(async () => helperInfo),
    listWindows: vi.fn(async () => ({ windows: [binding], identityVerified: false as const })),
    probe: vi.fn(async () => report),
    stop: vi.fn(async () => {})
  }
  return { driver, report }
}
it('collects passive activity counts while retaining unknown platform capability and incomplete observation', async () => {
  const f = fixture()
  f.driver.info.mockResolvedValue({
    ...helperInfo,
    adapterVersion: '0.4.0',
    probeViews: ['control', 'raw'],
    desktopActivityObservation: true
  } as never)
  const report = {
    ...f.report,
    formatVersion: 3,
    adapterVersion: '0.4.0',
    treeView: 'raw',
    desktopActivity: desktopActivity(),
    nodes: f.report.nodes.map((node) => ({
      ...node,
      isControlElement: true,
      isContentElement: false
    }))
  }
  f.driver.probe.mockResolvedValue(report as never)
  const options = {
    platform: 'wechat' as const,
    nativeReleaseId: release,
    treeView: 'raw' as const
  }
  expect(await collectPlatformProbe(f.driver as never, options, pin)).toMatchObject({
    status: 'metadata_collected',
    probe: {
      foregroundChangedAtEnd: false,
      desktopActivity: { foregroundEvents: 2, noInterferenceVerified: false }
    },
    nonInterferingSendVerified: false
  })
  f.driver.probe.mockResolvedValue({
    ...report,
    truncated: true,
    incompleteReasons: ['activity_unavailable'],
    desktopActivity: {
      ...desktopActivity(),
      complete: false,
      samples: 0,
      incompleteReasons: ['snapshot_unavailable']
    }
  } as never)
  expect(await collectPlatformProbe(f.driver as never, options, pin)).toMatchObject({
    status: 'metadata_collected',
    probe: { truncated: true, desktopActivity: { complete: false } },
    nonInterferingSendVerified: false
  })
})
it('accepts only a platform, completed release identifier and optional numeric window binding', () => {
  expect(
    parsePlatformProbeArgs([
      '--platform',
      'wechat',
      '--native-release',
      release,
      '--tree-view',
      'raw'
    ])
  ).toEqual({ platform: 'wechat', nativeReleaseId: release, treeView: 'raw' })
  expect(
    parsePlatformProbeArgs(['--platform', 'wechat', '--native-release', release, '--window', '123'])
  ).toEqual({ platform: 'wechat', nativeReleaseId: release, window: '123' })
  expect(parsePlatformProbeArgs(['--help'])).toEqual({ help: true })
  expect(
    parsePlatformProbeArgs(['--platform', 'wechat', '--native-release', release, '--check-package'])
  ).toEqual({ platform: 'wechat', nativeReleaseId: release, checkPackage: true })
  for (const args of [
    [],
    ['--platform', 'wechat'],
    ['--help', '--platform', 'wechat'],
    ['--platform', 'wechat', '--platform', 'wework', '--native-release', release],
    ['--platform', 'wechat', '--native-release', release, '--window', ''],
    ['--platform', 'wechat', '--native-release', release, '--send', 'hello'],
    ['--platform', 'wechat', '--native-release', release, '--tree-view', 'all'],
    [
      '--platform',
      'wechat',
      '--native-release',
      release,
      '--tree-view',
      'raw',
      '--tree-view',
      'control'
    ],
    ['--platform', 'wechat', '--native-release', release, '--check-package', '--tree-view', 'raw']
  ])
    expect(() => parsePlatformProbeArgs(args)).toThrow()
})
it('rejects unsupported raw view before enumeration and records the reason without promoting capabilities', async () => {
  const f = fixture()
  expect(
    await collectPlatformProbe(
      f.driver as never,
      { platform: 'wechat', nativeReleaseId: release, treeView: 'raw' },
      pin
    )
  ).toMatchObject({
    status: 'probe_failed',
    requestedTreeView: 'raw',
    probe: null,
    failure: { stage: 'info', code: 'unsupported_view' },
    helperExitConfirmed: true
  })
  expect(f.driver.listWindows).not.toHaveBeenCalled()
  expect(f.driver.probe).not.toHaveBeenCalled()
})
it.each(['control', 'raw'] as const)(
  'collects exact %s metadata under the new read-only helper',
  async (treeView) => {
    const f = fixture()
    f.driver.info.mockResolvedValue({
      ...helperInfo,
      adapterVersion: '0.3.0',
      probeViews: ['control', 'raw']
    } as never)
    const advanced = {
      ...f.report,
      formatVersion: 2,
      adapterVersion: '0.3.0',
      treeView,
      nodes: f.report.nodes.map((node) => ({
        ...node,
        isControlElement: true,
        isContentElement: false
      }))
    }
    f.driver.probe.mockResolvedValue(advanced as never)
    expect(
      await collectPlatformProbe(
        f.driver as never,
        { platform: 'wechat', nativeReleaseId: release, treeView },
        pin
      )
    ).toMatchObject({
      status: 'metadata_collected',
      requestedTreeView: treeView,
      probe: advanced,
      messagesRead: 0,
      messagesSent: 0
    })
    expect(f.driver.probe).toHaveBeenCalledWith(binding, undefined, treeView)
  }
)
it('refuses a different returned view and a helper/report version mismatch', async () => {
  const f = fixture()
  f.driver.info.mockResolvedValue({
    ...helperInfo,
    adapterVersion: '0.3.0',
    probeViews: ['control', 'raw']
  } as never)
  const options = {
    platform: 'wechat' as const,
    nativeReleaseId: release,
    treeView: 'raw' as const
  }
  f.driver.probe.mockResolvedValue({
    ...f.report,
    formatVersion: 2,
    adapterVersion: '0.3.0',
    treeView: 'control',
    nodes: f.report.nodes.map((node) => ({
      ...node,
      isControlElement: true,
      isContentElement: false
    }))
  } as never)
  expect(await collectPlatformProbe(f.driver as never, options, pin)).toMatchObject({
    status: 'probe_failed',
    probe: null,
    helperExitConfirmed: true
  })
  f.driver.probe.mockResolvedValue(f.report)
  expect(
    await collectPlatformProbe(f.driver as never, { ...options, treeView: 'control' }, pin)
  ).toMatchObject({ status: 'probe_failed', probe: null })
})
it('collects metadata for the sole bound platform window and closes without any capability promotion', async () => {
  const f = fixture(),
    result = await collectPlatformProbe(
      f.driver as never,
      { platform: 'wechat', nativeReleaseId: release },
      pin
    )
  expect(result).toMatchObject({
    status: 'metadata_collected',
    selected: binding,
    probe: f.report,
    helperExitConfirmed: true,
    backgroundReadVerified: false,
    nonInterferingSendVerified: false,
    identityVerified: false,
    messagesRead: 0,
    messagesSent: 0,
    modelCalls: 0,
    failure: null
  })
  expect(f.driver.probe).toHaveBeenCalledWith(binding, undefined)
  expect(f.driver.stop).toHaveBeenCalledOnce()
})
it('never reads another platform or guesses among multiple windows', async () => {
  const f = fixture()
  expect(
    await collectPlatformProbe(
      f.driver as never,
      { platform: 'wework', nativeReleaseId: release },
      pin
    )
  ).toMatchObject({
    status: 'no_client_window',
    candidates: [],
    selected: null,
    helperExitConfirmed: true
  })
  expect(f.driver.probe).not.toHaveBeenCalled()
  const other = { ...binding, handle: '124' }
  f.driver.listWindows.mockResolvedValue({ windows: [binding, other], identityVerified: false })
  expect(
    await collectPlatformProbe(
      f.driver as never,
      { platform: 'wechat', nativeReleaseId: release },
      pin
    )
  ).toMatchObject({ status: 'window_selection_required', helperExitConfirmed: true })
  expect(f.driver.probe).not.toHaveBeenCalled()
  f.driver.probe.mockResolvedValue({ ...f.report, binding: other })
  expect(
    await collectPlatformProbe(
      f.driver as never,
      { platform: 'wechat', nativeReleaseId: release, window: '124' },
      pin
    )
  ).toMatchObject({ status: 'metadata_collected', selected: other })
})
it('does not fall back after the explicitly selected window disappears', async () => {
  const f = fixture()
  expect(
    await collectPlatformProbe(
      f.driver as never,
      { platform: 'wechat', nativeReleaseId: release, window: '999' },
      pin
    )
  ).toMatchObject({ status: 'selected_window_missing', selected: null, helperExitConfirmed: true })
  expect(f.driver.probe).not.toHaveBeenCalled()
})
it.each(['binding', 'capability', 'text', 'duplicate'])(
  'rejects invalid %s evidence and still closes the helper',
  async (kind) => {
    const f = fixture()
    if (kind === 'binding')
      f.driver.probe.mockResolvedValue({ ...f.report, binding: { ...binding, processId: 789 } })
    if (kind === 'capability')
      f.driver.probe.mockResolvedValue({ ...f.report, backgroundReadVerified: true })
    if (kind === 'text')
      f.driver.probe.mockResolvedValue({ ...f.report, text: 'must never be retained' } as never)
    if (kind === 'duplicate')
      f.driver.listWindows.mockResolvedValue({
        windows: [binding, binding],
        identityVerified: false
      })
    const result = await collectPlatformProbe(
      f.driver as never,
      { platform: 'wechat', nativeReleaseId: release },
      pin
    )
    expect(result).toMatchObject({ status: 'probe_failed', probe: null, helperExitConfirmed: true })
    expect(JSON.stringify(result)).not.toContain('must never be retained')
    expect(f.driver.stop).toHaveBeenCalledOnce()
  }
)
it('reports timed out stage and gives an unconfirmed helper close priority over collected metadata', async () => {
  const f = fixture()
  f.driver.probe.mockRejectedValue(new Error('native_adapter_timeout'))
  expect(
    await collectPlatformProbe(
      f.driver as never,
      { platform: 'wechat', nativeReleaseId: release },
      pin
    )
  ).toMatchObject({
    status: 'probe_failed',
    failure: { stage: 'probe', code: 'timed_out' },
    helperExitConfirmed: true
  })
  f.driver.probe.mockResolvedValue(f.report)
  f.driver.stop.mockRejectedValue(new Error('private detail'))
  expect(
    await collectPlatformProbe(
      f.driver as never,
      { platform: 'wechat', nativeReleaseId: release },
      pin
    )
  ).toMatchObject({
    status: 'helper_stop_unconfirmed',
    failure: { stage: 'close', code: 'stop_unconfirmed' },
    helperExitConfirmed: false,
    nonInterferingSendVerified: false
  })
})
it('cancels an uncooperative in-flight driver, stops it and rejects its late result', async () => {
  const f = fixture(),
    controller = new AbortController()
  let resolve!: (value: unknown) => void
  f.driver.probe.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done
      }) as never
  )
  const work = collectPlatformProbe(
    f.driver as never,
    { platform: 'wechat', nativeReleaseId: release },
    pin,
    controller.signal
  )
  await vi.waitFor(() => expect(f.driver.probe).toHaveBeenCalledOnce())
  controller.abort()
  expect(await work).toMatchObject({ status: 'cancelled', probe: null, helperExitConfirmed: true })
  resolve(f.report)
  await Promise.resolve()
  expect(f.driver.stop).toHaveBeenCalledOnce()
})
it('distinguishes the overall deadline from an operator cancellation', async () => {
  const f = fixture(),
    controller = new AbortController()
  f.driver.listWindows.mockImplementation(() => new Promise(() => {}) as never)
  const work = collectPlatformProbe(
    f.driver as never,
    { platform: 'wechat', nativeReleaseId: release },
    pin,
    controller.signal
  )
  await vi.waitFor(() => expect(f.driver.listWindows).toHaveBeenCalledOnce())
  controller.abort('platform_probe_deadline')
  expect(await work).toMatchObject({
    status: 'probe_failed',
    failure: { stage: 'windows', code: 'timed_out' },
    probe: null,
    helperExitConfirmed: true
  })
})
it('does not silently turn package-check mode into a client capture', async () => {
  const f = fixture()
  await expect(
    collectPlatformProbe(
      f.driver as never,
      { platform: 'wechat', nativeReleaseId: release, checkPackage: true },
      pin
    )
  ).rejects.toThrow('platform_probe_capture_not_requested')
  expect(f.driver.info).not.toHaveBeenCalled()
  expect(f.driver.listWindows).not.toHaveBeenCalled()
})
