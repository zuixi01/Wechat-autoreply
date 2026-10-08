import { randomUUID } from 'node:crypto'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectPlatformProbe, parsePlatformProbeArgs } from '../src/core/adapters/platform-probe'
import {
  createPlatformProbeDirectory,
  readNativeProbeRelease,
  writePlatformProbeEvidence
} from '../src/core/adapters/platform-probe-files'
import { WindowsBridge } from '../src/core/adapters/windows-bridge'

async function main(): Promise<void> {
  const options = parsePlatformProbeArgs(process.argv.slice(2))
  if ('help' in options) {
    process.stdout.write(
      'Read-only platform metadata probe\n--platform wechat|wework --native-release PUBLISH_UUID [--window HWND] [--tree-view control|raw]\nHelper 0.4.0 also records bounded, read-only desktop activity counts during the probe; these cannot prove no interference. Raw view requires helper 0.3.0 or 0.4.0; default control view also accepts legacy 0.2.0. Optional --check-package validates the pinned package without starting a helper or enumerating windows; it cannot be combined with window or tree-view.\nUses the pinned publisher record and a fresh protected .local report. Multiple matching windows require explicit selection. Never reads chat text, changes focus, sends messages or enables capabilities.\n'
    )
    return
  }
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw new Error('platform_probe_windows_required')
  const workspace = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const release = await readNativeProbeRelease(workspace, options.nativeReleaseId)
  const bridge = await WindowsBridge.fromPackage(release.packageRoot, release.manifestSha256)
  if (options.checkPackage) {
    await bridge.stop()
    process.stdout.write(
      JSON.stringify({
        status: 'package_verified_only',
        platform: options.platform,
        nativeReleaseId: options.nativeReleaseId,
        helperStarted: false,
        windowEnumeration: false,
        chatWindowsRead: false,
        backgroundReadVerified: false,
        nonInterferingSendVerified: false,
        identityVerified: false,
        messagesSent: 0,
        modelCalls: 0
      }) + '\n'
    )
    return
  }
  const directory = await createPlatformProbeDirectory(workspace, randomUUID())
  const controller = new AbortController()
  const stop = (): void => controller.abort()
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  const timer = setTimeout(() => controller.abort('platform_probe_deadline'), 20000)
  try {
    const evidence = await collectPlatformProbe(
      bridge,
      options,
      release.manifestSha256,
      controller.signal
    )
    clearTimeout(timer)
    evidence.id = basename(directory)
    await writePlatformProbeEvidence(directory, evidence)
    process.stdout.write(
      JSON.stringify({
        status: evidence.status,
        platform: evidence.platform,
        directory,
        nodes: evidence.probe?.nodes.length ?? 0,
        requestedTreeView: evidence.requestedTreeView ?? 'control',
        treeView: evidence.probe
          ? evidence.probe.formatVersion !== 1
            ? evidence.probe.treeView
            : 'control'
          : null,
        truncated: evidence.probe?.truncated ?? null,
        helperExitConfirmed: evidence.helperExitConfirmed,
        backgroundReadVerified: false,
        nonInterferingSendVerified: false,
        identityVerified: false,
        messagesSent: 0,
        modelCalls: 0
      }) + '\n'
    )
    if (evidence.status !== 'metadata_collected') process.exitCode = 2
  } finally {
    clearTimeout(timer)
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    await bridge.stop()
  }
}
void main().catch(() => {
  process.stderr.write(
    'Read-only probe unavailable. Check arguments, completed native release and private output permissions.\n'
  )
  process.exitCode = 1
})
