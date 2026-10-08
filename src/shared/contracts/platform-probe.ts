import { z } from 'zod'
import { NativeWindowBindingSchema, NativeProbeSchema, NativeTreeViewSchema } from './native-probe'
const Milliseconds = z.number().int().nonnegative().safe()
export const PlatformProbeEvidenceSchema = z
  .strictObject({
    formatVersion: z.literal(1),
    kind: z.literal('native-platform-metadata'),
    id: z.uuid(),
    platform: z.enum(['wechat', 'wework']),
    requestedTreeView: NativeTreeViewSchema.optional(),
    nativeReleaseId: z.uuid(),
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    startedAt: Milliseconds,
    completedAt: Milliseconds,
    status: z.enum([
      'metadata_collected',
      'no_client_window',
      'window_selection_required',
      'selected_window_missing',
      'probe_failed',
      'helper_stop_unconfirmed',
      'cancelled'
    ]),
    candidates: z.array(NativeWindowBindingSchema).max(1024),
    selected: NativeWindowBindingSchema.nullable(),
    probe: NativeProbeSchema.nullable(),
    helperExitConfirmed: z.boolean(),
    failure: z
      .strictObject({
        stage: z.enum(['info', 'windows', 'probe', 'close']),
        code: z.enum([
          'timed_out',
          'invalid_evidence',
          'helper_error',
          'cancelled',
          'stop_unconfirmed',
          'unsupported_view'
        ])
      })
      .nullable(),
    backgroundReadVerified: z.literal(false),
    nonInterferingSendVerified: z.literal(false),
    identityVerified: z.literal(false),
    messagesRead: z.literal(0),
    messagesSent: z.literal(0),
    modelCalls: z.literal(0)
  })
  .superRefine((value, context) => {
    const invalid = (): void =>
      context.addIssue({ code: 'custom', message: 'inconsistent_platform_probe' })
    const allowed = value.platform === 'wechat' ? ['WeChat', 'Weixin'] : ['WXWork']
    if (
      value.completedAt < value.startedAt ||
      value.candidates.some((c) => !allowed.includes(c.processName)) ||
      new Set(value.candidates.map((c) => c.handle)).size !== value.candidates.length
    )
      invalid()
    if (
      value.selected &&
      !value.candidates.some((c) => JSON.stringify(c) === JSON.stringify(value.selected))
    )
      invalid()
    if (
      value.probe &&
      (!value.selected || JSON.stringify(value.probe.binding) !== JSON.stringify(value.selected))
    )
      invalid()
    if (
      value.probe &&
      (value.probe.formatVersion !== 1
        ? value.probe.treeView !== (value.requestedTreeView ?? 'control')
        : value.requestedTreeView === 'raw')
    )
      invalid()
    if ((value.status === 'helper_stop_unconfirmed') === value.helperExitConfirmed) invalid()
    if (value.status === 'metadata_collected' && !value.probe) invalid()
    if (
      [
        'metadata_collected',
        'no_client_window',
        'window_selection_required',
        'selected_window_missing'
      ].includes(value.status) &&
      value.failure
    )
      invalid()
    if (
      ['probe_failed', 'helper_stop_unconfirmed', 'cancelled'].includes(value.status) &&
      !value.failure
    )
      invalid()
    if (value.status === 'no_client_window' && value.candidates.length) invalid()
    if (
      value.status === 'window_selection_required' &&
      (value.candidates.length < 2 || value.selected || value.probe)
    )
      invalid()
  })
export type PlatformProbeEvidence = z.infer<typeof PlatformProbeEvidenceSchema>
