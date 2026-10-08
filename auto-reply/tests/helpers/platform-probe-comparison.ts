import { randomUUID } from 'node:crypto'
import { PlatformProbeEvidenceSchema } from '../../src/shared/contracts/platform-probe'
import { desktopActivity } from './desktop-activity'

export function probeComparisonPair() {
  const release = randomUUID()
  const binding = {
    handle: '123',
    processId: 456,
    processName: 'WeChat',
    processStartTicks: '638000000000000000'
  }
  const evidence = (view: 'control' | 'raw', count: number, time: number) =>
    PlatformProbeEvidenceSchema.parse({
      formatVersion: 1,
      kind: 'native-platform-metadata',
      id: randomUUID(),
      platform: 'wechat',
      requestedTreeView: view,
      nativeReleaseId: release,
      manifestSha256: 'a'.repeat(64),
      startedAt: time,
      completedAt: time + 20,
      status: 'metadata_collected',
      candidates: [binding],
      selected: binding,
      helperExitConfirmed: true,
      failure: null,
      backgroundReadVerified: false,
      nonInterferingSendVerified: false,
      identityVerified: false,
      messagesRead: 0,
      messagesSent: 0,
      modelCalls: 0,
      probe: {
        formatVersion: 3,
        adapterVersion: '0.4.0',
        snapshotId: randomUUID(),
        binding,
        capturedAt: time,
        clientFileVersion: 'synthetic-1',
        windowsVersion: 'synthetic-Windows',
        nodes: Array.from({ length: count }, (_, index) => ({
          index,
          parentIndex: index === 0 ? null : 0,
          depth: index === 0 ? 0 : 1,
          runtimeId: [42, index],
          controlType: index === 0 ? 'ControlType.Window' : 'ControlType.Edit',
          className: 'PRIVATE_CLASS',
          automationId: 'PRIVATE_CUSTOMER_IDENTIFIER',
          offscreen: index === 1,
          enabled: index !== 1,
          patterns:
            index === 1
              ? ['TextPatternIdentifiers.Pattern', 'ValuePatternIdentifiers.Pattern']
              : [],
          isControlElement: view === 'control' || index < 2,
          isContentElement: index === 1
        })),
        incompleteReasons: [],
        truncated: false,
        elapsedMs: 10,
        foregroundBeforeHandle: '123',
        foregroundAfterHandle: '123',
        foregroundChangedAtEnd: false,
        backgroundReadVerified: false,
        nonInterferingSendVerified: false,
        identityVerified: false,
        conclusion: 'metadata_only_requires_platform_validation',
        treeView: view,
        desktopActivity: desktopActivity()
      }
    })
  return { control: evidence('control', 2, 10000), raw: evidence('raw', 4, 10040) }
}
