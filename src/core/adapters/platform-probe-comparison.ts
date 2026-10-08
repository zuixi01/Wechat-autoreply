import { parseArgs } from 'node:util'
import { z } from 'zod'
import type { DesktopActivity } from '../../shared/contracts/desktop-activity'
import {
  PlatformProbeEvidenceSchema,
  type PlatformProbeEvidence
} from '../../shared/contracts/platform-probe'

export const MaximumProbeComparisonGapMs = 300000
const Patterns = {
  text: 'TextPatternIdentifiers.Pattern',
  value: 'ValuePatternIdentifiers.Pattern',
  invoke: 'InvokePatternIdentifiers.Pattern',
  selection: 'SelectionPatternIdentifiers.Pattern',
  scroll: 'ScrollPatternIdentifiers.Pattern',
  virtualizedItem: 'VirtualizedItemPatternIdentifiers.Pattern',
  itemContainer: 'ItemContainerPatternIdentifiers.Pattern'
} as const

interface ProbeSummary {
  evidenceId: string
  platform: PlatformProbeEvidence['platform']
  status: PlatformProbeEvidence['status']
  treeView: 'control' | 'raw' | null
  capturedAt: number | null
  adapterVersion: string | null
  nodes: number
  offscreenNodes: number
  disabledNodes: number
  nonControlNodes: number | null
  patternNodes: Record<keyof typeof Patterns, number>
  truncated: boolean | null
  incompleteReasons: NonNullable<PlatformProbeEvidence['probe']>['incompleteReasons']
  foregroundChangedAtEnd: boolean | null
  desktopActivity: DesktopActivity | null
}
function summarize(evidence: PlatformProbeEvidence): ProbeSummary {
  const probe = evidence.probe
  const nodes = probe?.nodes ?? []
  return {
    evidenceId: evidence.id,
    platform: evidence.platform,
    status: evidence.status,
    treeView: probe ? (probe.formatVersion === 1 ? 'control' : probe.treeView) : null,
    capturedAt: probe?.capturedAt ?? null,
    adapterVersion: probe?.adapterVersion ?? null,
    nodes: nodes.length,
    offscreenNodes: nodes.filter((node) => node.offscreen).length,
    disabledNodes: nodes.filter((node) => !node.enabled).length,
    nonControlNodes:
      probe && probe.formatVersion !== 1
        ? probe.nodes.filter((node) => !node.isControlElement).length
        : null,
    patternNodes: Object.fromEntries(
      Object.entries(Patterns).map(([name, pattern]) => [
        name,
        nodes.filter((node) => node.patterns.includes(pattern)).length
      ])
    ) as ProbeSummary['patternNodes'],
    truncated: probe?.truncated ?? null,
    incompleteReasons: probe?.incompleteReasons ?? [],
    foregroundChangedAtEnd: probe?.foregroundChangedAtEnd ?? null,
    desktopActivity: probe?.formatVersion === 3 ? probe.desktopActivity : null
  }
}

type ComparisonReason =
  | 'capture_unavailable'
  | 'view_pair_invalid'
  | 'platform_mismatch'
  | 'window_instance_mismatch'
  | 'client_version_missing'
  | 'client_version_mismatch'
  | 'windows_version_mismatch'
  | 'native_package_mismatch'
  | 'snapshot_reused'
  | 'capture_time_invalid'
  | 'capture_gap_exceeded'

/** Compare aggregate observations, never match customers or nodes across snapshots.
 * A comparable pair is still two separate captures, not a reconstructed message tree. */
export interface PlatformProbeComparison {
  status: 'evidence_not_comparable' | 'aggregate_comparison'
  reasons: ComparisonReason[]
  maximumCaptureGapMs: number
  captureGapMs: number | null
  control: ProbeSummary
  raw: ProbeSummary
  nodeCountDelta: number | null
  snapshotsMerged: false
  nodeIdentityMatched: false
  backgroundReadVerified: false
  nonInterferingSendVerified: false
  identityVerified: false
  noInterferenceVerified: false
  messagesRead: 0
  messagesSent: 0
  modelCalls: 0
}
export function comparePlatformProbes(
  controlRaw: unknown,
  rawRaw: unknown
): PlatformProbeComparison {
  const control = PlatformProbeEvidenceSchema.parse(controlRaw)
  const raw = PlatformProbeEvidenceSchema.parse(rawRaw)
  const reasons: ComparisonReason[] = []
  const a = control.probe,
    b = raw.probe
  if (
    control.status !== 'metadata_collected' ||
    raw.status !== 'metadata_collected' ||
    !control.helperExitConfirmed ||
    !raw.helperExitConfirmed ||
    !a ||
    !b
  )
    reasons.push('capture_unavailable')
  if (control.platform !== raw.platform) reasons.push('platform_mismatch')
  if (a && b) {
    if (
      (a.formatVersion === 1 ? 'control' : a.treeView) !== 'control' ||
      b.formatVersion === 1 ||
      b.treeView !== 'raw'
    )
      reasons.push('view_pair_invalid')
    if (
      a.binding.handle !== b.binding.handle ||
      a.binding.processId !== b.binding.processId ||
      a.binding.processName !== b.binding.processName ||
      a.binding.processStartTicks !== b.binding.processStartTicks
    )
      reasons.push('window_instance_mismatch')
    if (!a.clientFileVersion || !b.clientFileVersion) reasons.push('client_version_missing')
    else if (a.clientFileVersion !== b.clientFileVersion) reasons.push('client_version_mismatch')
    if (a.windowsVersion !== b.windowsVersion) reasons.push('windows_version_mismatch')
    if (
      a.adapterVersion !== b.adapterVersion ||
      control.nativeReleaseId !== raw.nativeReleaseId ||
      control.manifestSha256 !== raw.manifestSha256
    )
      reasons.push('native_package_mismatch')
    if (control.id === raw.id || a.snapshotId === b.snapshotId) reasons.push('snapshot_reused')
    if (
      [control, raw].some(
        (entry) =>
          entry.probe &&
          (entry.probe.capturedAt < entry.startedAt || entry.probe.capturedAt > entry.completedAt)
      )
    )
      reasons.push('capture_time_invalid')
    if (Math.abs(a.capturedAt - b.capturedAt) > MaximumProbeComparisonGapMs)
      reasons.push('capture_gap_exceeded')
  }
  return {
    status: reasons.length
      ? ('evidence_not_comparable' as const)
      : ('aggregate_comparison' as const),
    reasons,
    maximumCaptureGapMs: MaximumProbeComparisonGapMs,
    captureGapMs: a && b ? Math.abs(a.capturedAt - b.capturedAt) : null,
    control: summarize(control),
    raw: summarize(raw),
    nodeCountDelta: !reasons.length && a && b ? b.nodes.length - a.nodes.length : null,
    snapshotsMerged: false as const,
    nodeIdentityMatched: false as const,
    backgroundReadVerified: false as const,
    nonInterferingSendVerified: false as const,
    identityVerified: false as const,
    noInterferenceVerified: false as const,
    messagesRead: 0 as const,
    messagesSent: 0 as const,
    modelCalls: 0 as const
  }
}

export function parseProbeComparisonArgs(
  args: string[]
): { help: true } | { controlId: string; rawId: string } {
  const { values, tokens } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    tokens: true,
    options: { control: { type: 'string' }, raw: { type: 'string' }, help: { type: 'boolean' } }
  })
  const seen = new Set<string>()
  for (const token of tokens)
    if (token.kind === 'option') {
      if (seen.has(token.name)) throw new Error('probe_comparison_arguments_invalid')
      seen.add(token.name)
    }
  if (values.help) {
    if (tokens.length !== 1) throw new Error('probe_comparison_arguments_invalid')
    return { help: true }
  }
  return { controlId: z.uuid().parse(values.control), rawId: z.uuid().parse(values.raw) }
}
