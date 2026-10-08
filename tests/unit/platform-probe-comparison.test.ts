import { expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  comparePlatformProbes,
  MaximumProbeComparisonGapMs,
  parseProbeComparisonArgs
} from '../../src/core/adapters/platform-probe-comparison'
import { probeComparisonPair } from '../helpers/platform-probe-comparison'

it('compares bounded aggregates without matching runtime IDs, reconstructing messages or granting capabilities', () => {
  const { control, raw } = probeComparisonPair()
  const result = comparePlatformProbes(control, raw)
  expect(result).toMatchObject({
    status: 'aggregate_comparison',
    reasons: [],
    captureGapMs: 40,
    nodeCountDelta: 2,
    control: { nodes: 2, nonControlNodes: 0, patternNodes: { text: 1, value: 1 } },
    raw: { nodes: 4, nonControlNodes: 2, offscreenNodes: 1, disabledNodes: 1 },
    snapshotsMerged: false,
    nodeIdentityMatched: false,
    identityVerified: false,
    backgroundReadVerified: false,
    nonInterferingSendVerified: false,
    noInterferenceVerified: false
  })
  const text = JSON.stringify(result)
  expect(text).not.toContain('PRIVATE_')
  for (const key of [
    'runtimeId',
    'automationId',
    'className',
    'processStartTicks',
    'foregroundBeforeHandle'
  ])
    expect(text).not.toContain(key)
})
it.each(['handle', 'processId', 'processName', 'processStartTicks'] as const)(
  'refuses changed window instance %s',
  (field) => {
    const { control, raw } = probeComparisonPair()
    const binding = {
      ...raw.probe!.binding,
      [field]:
        field === 'processId'
          ? 457
          : field === 'processName'
            ? 'Weixin'
            : field === 'handle'
              ? '124'
              : '638000000000000001'
    }
    raw.candidates = [binding as never]
    raw.selected = binding as never
    raw.probe!.binding = binding as never
    expect(comparePlatformProbes(control, raw)).toMatchObject({
      status: 'evidence_not_comparable',
      reasons: ['window_instance_mismatch'],
      nodeCountDelta: null
    })
  }
)
it.each([
  'client',
  'windows',
  'release',
  'manifest',
  'snapshot',
  'time',
  'gap',
  'platform',
  'view'
] as const)('does not silently compare a mismatched pair: %s', (change) => {
  const { control, raw } = probeComparisonPair()
  const expected = {
    client: 'client_version_mismatch',
    windows: 'windows_version_mismatch',
    release: 'native_package_mismatch',
    manifest: 'native_package_mismatch',
    snapshot: 'snapshot_reused',
    time: 'capture_time_invalid',
    gap: 'capture_gap_exceeded',
    platform: 'platform_mismatch',
    view: 'view_pair_invalid'
  }
  if (change === 'client') raw.probe!.clientFileVersion = 'synthetic-2'
  if (change === 'windows') raw.probe!.windowsVersion = 'synthetic-Windows-2'
  if (change === 'release') raw.nativeReleaseId = randomUUID()
  if (change === 'manifest') raw.manifestSha256 = 'b'.repeat(64)
  if (change === 'snapshot') raw.probe!.snapshotId = control.probe!.snapshotId
  if (change === 'time') raw.probe!.capturedAt = raw.completedAt + 1
  if (change === 'gap') {
    raw.startedAt += MaximumProbeComparisonGapMs
    raw.completedAt += MaximumProbeComparisonGapMs
    raw.probe!.capturedAt += MaximumProbeComparisonGapMs
  }
  if (change === 'platform') {
    raw.platform = 'wework'
    const binding = { ...raw.probe!.binding, processName: 'WXWork' as const }
    raw.candidates = [binding]
    raw.selected = binding
    raw.probe!.binding = binding
  }
  if (change === 'view' && raw.probe!.formatVersion !== 1) {
    raw.probe!.treeView = 'control'
    raw.requestedTreeView = 'control'
  }
  expect(comparePlatformProbes(control, raw)).toMatchObject({
    status: 'evidence_not_comparable',
    nodeCountDelta: null
  })
  expect(comparePlatformProbes(control, raw).reasons).toContain(expected[change])
})
it('retains truncated and unavailable-activity evidence without treating aggregate results as complete reading', () => {
  const { control, raw } = probeComparisonPair()
  raw.probe!.truncated = true
  raw.probe!.incompleteReasons = ['activity_unavailable']
  if (raw.probe!.formatVersion === 3)
    raw.probe!.desktopActivity = {
      ...raw.probe!.desktopActivity,
      complete: false,
      samples: 0,
      incompleteReasons: ['snapshot_unavailable']
    }
  expect(comparePlatformProbes(control, raw)).toMatchObject({
    status: 'aggregate_comparison',
    raw: {
      truncated: true,
      incompleteReasons: ['activity_unavailable'],
      desktopActivity: { complete: false }
    },
    backgroundReadVerified: false
  })
})
it('preserves no-window or failed captures as an explicit non-comparable result', () => {
  const { control, raw } = probeComparisonPair()
  raw.status = 'no_client_window'
  raw.candidates = []
  raw.selected = null
  raw.probe = null
  expect(comparePlatformProbes(control, raw)).toMatchObject({
    status: 'evidence_not_comparable',
    reasons: ['capture_unavailable'],
    raw: { nodes: 0, capturedAt: null },
    nodeCountDelta: null
  })
})
it('does not infer absence of patterns or reject negative count changes across separate snapshots', () => {
  const { control, raw } = probeComparisonPair()
  raw.probe!.nodes = raw.probe!.nodes.slice(0, 1)
  expect(comparePlatformProbes(control, raw)).toMatchObject({
    status: 'aggregate_comparison',
    nodeCountDelta: -1,
    raw: { patternNodes: { text: 0, value: 0 } },
    backgroundReadVerified: false
  })
})
it('rejects malformed source evidence, extra chat text, forged capabilities and swapped roles', () => {
  const { control, raw } = probeComparisonPair()
  for (const invalid of [
    { ...raw, chatText: 'PRIVATE_MESSAGE' },
    { ...raw, backgroundReadVerified: true },
    { ...raw, probe: { ...raw.probe, desktopActivity: { noInterferenceVerified: true } } }
  ])
    expect(() => comparePlatformProbes(control, invalid)).toThrow()
  expect(comparePlatformProbes(raw, control).reasons).toContain('view_pair_invalid')
})
it('requires only two explicit evidence UUIDs; never accepts arbitrary files, output paths or duplicate options', () => {
  const { control, raw } = probeComparisonPair()
  expect(parseProbeComparisonArgs(['--control', control.id, '--raw', raw.id])).toEqual({
    controlId: control.id,
    rawId: raw.id
  })
  expect(parseProbeComparisonArgs(['--help'])).toEqual({ help: true })
  for (const args of [
    [],
    ['--control', '../../secret', '--raw', raw.id],
    ['--control', control.id],
    ['--control', control.id, '--raw', raw.id, '--output', 'public'],
    ['--help', '--raw', raw.id],
    ['--control', control.id, '--control', control.id, '--raw', raw.id]
  ])
    expect(() => parseProbeComparisonArgs(args)).toThrow()
})

it('retains format 2 compatibility with explicitly absent activity observations', () => {
  const { control, raw } = probeComparisonPair()
  for (const evidence of [control, raw]) {
    if (evidence.probe?.formatVersion !== 3) throw new Error('fixture_version')
    const { desktopActivity: _activity, ...probe } = evidence.probe
    expect(_activity.noInterferenceVerified).toBe(false)
    evidence.probe = { ...probe, formatVersion: 2, adapterVersion: '0.3.0', incompleteReasons: [] }
  }
  expect(comparePlatformProbes(control, raw)).toMatchObject({
    status: 'aggregate_comparison',
    control: { desktopActivity: null },
    raw: { desktopActivity: null },
    noInterferenceVerified: false
  })
})

it('does not export arbitrary pattern names or accept a lookalike text pattern', () => {
  const { control, raw } = probeComparisonPair()
  raw.probe!.nodes[1].patterns = [
    'PrivatePatternIdentifier.Pattern',
    'TextPatternIdentifiers.PatternX'
  ]
  const result = comparePlatformProbes(control, raw)
  expect(result.raw.patternNodes).toMatchObject({ text: 0, value: 0 })
  expect(JSON.stringify(result)).not.toContain('PrivatePatternIdentifier.Pattern')
})

it('requires an observed client version rather than treating two missing versions as equal', () => {
  const { control, raw } = probeComparisonPair()
  for (const source of [control, raw]) {
    source.probe!.clientFileVersion = null
    source.probe!.truncated = true
    source.probe!.incompleteReasons = ['version_unavailable']
  }
  expect(comparePlatformProbes(control, raw)).toMatchObject({
    status: 'evidence_not_comparable',
    reasons: ['client_version_missing'],
    nodeCountDelta: null
  })
})
