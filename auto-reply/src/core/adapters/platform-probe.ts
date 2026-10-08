import { randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { NativeAdapterInfoSchema } from '../../shared/contracts/native-package'
import {
  NativeWindowBindingSchema,
  NativeProbeSchema,
  NativeTreeViewSchema
} from '../../shared/contracts/native-probe'
import {
  PlatformProbeEvidenceSchema,
  type PlatformProbeEvidence
} from '../../shared/contracts/platform-probe'
import { WindowListSchema, type WindowsBridge } from './windows-bridge'
export interface PlatformProbeOptions {
  platform: 'wechat' | 'wework'
  nativeReleaseId: string
  window?: string
  checkPackage?: true
  treeView?: 'control' | 'raw'
}
const OptionsSchema = z.strictObject({
  platform: z.enum(['wechat', 'wework']),
  nativeReleaseId: z.uuid(),
  window: NativeWindowBindingSchema.shape.handle.optional(),
  checkPackage: z.literal(true).optional(),
  treeView: NativeTreeViewSchema.optional()
})
export function parsePlatformProbeArgs(args: string[]): PlatformProbeOptions | { help: true } {
  const { values, positionals, tokens } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    tokens: true,
    options: {
      platform: { type: 'string' },
      'native-release': { type: 'string' },
      window: { type: 'string' },
      'check-package': { type: 'boolean' },
      'tree-view': { type: 'string' },
      help: { type: 'boolean' }
    }
  })
  const seen = new Set<string>()
  for (const token of tokens)
    if (token.kind === 'option') {
      if (seen.has(token.name)) throw new Error('platform_probe_arguments_invalid')
      seen.add(token.name)
    }
  if (values.help) {
    if (tokens.length !== 1 || positionals.length)
      throw new Error('platform_probe_arguments_invalid')
    return { help: true }
  }
  if (values['check-package'] && (values.window !== undefined || values['tree-view'] !== undefined))
    throw new Error('platform_probe_arguments_invalid')
  return OptionsSchema.parse({
    platform: values.platform,
    nativeReleaseId: values['native-release'],
    ...(values.window !== undefined ? { window: values.window } : {}),
    ...(values['check-package'] ? { checkPackage: true } : {}),
    ...(values['tree-view'] !== undefined ? { treeView: values['tree-view'] } : {})
  })
}
type PassiveDriver = Pick<WindowsBridge, 'info' | 'listWindows' | 'probe' | 'stop'>
/** Metadata only. Selection is never inferred from window title, active window,
 * PID alone or a different platform. This collector contains no send action. */
export async function collectPlatformProbe(
  driver: PassiveDriver,
  options: PlatformProbeOptions,
  manifestSha256: string,
  signal?: AbortSignal
): Promise<PlatformProbeEvidence> {
  options = OptionsSchema.parse(options)
  if (options.checkPackage) throw new Error('platform_probe_capture_not_requested')
  manifestSha256 = z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(manifestSha256)
  const result: PlatformProbeEvidence = {
    formatVersion: 1,
    kind: 'native-platform-metadata',
    id: randomUUID(),
    platform: options.platform,
    requestedTreeView: options.treeView ?? 'control',
    nativeReleaseId: options.nativeReleaseId,
    manifestSha256,
    startedAt: Date.now(),
    completedAt: Date.now(),
    status: 'probe_failed',
    candidates: [],
    selected: null,
    probe: null,
    helperExitConfirmed: false,
    failure: null,
    backgroundReadVerified: false,
    nonInterferingSendVerified: false,
    identityVerified: false,
    messagesRead: 0,
    messagesSent: 0,
    modelCalls: 0
  }
  let rejectAbort: (() => void) | undefined
  const abort = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(new Error('platform_probe_cancelled'))
  })
  const cancelled = (): void => {
    rejectAbort?.()
  }
  signal?.addEventListener('abort', cancelled, { once: true })
  const step = async <T>(work: () => Promise<T>): Promise<T> => {
    if (signal?.aborted) throw new Error('platform_probe_cancelled')
    return Promise.race([work(), abort])
  }
  let stage: NonNullable<PlatformProbeEvidence['failure']>['stage'] = 'info'
  const deadline = (): boolean =>
    signal?.aborted === true && signal.reason === 'platform_probe_deadline'
  try {
    const info = NativeAdapterInfoSchema.parse(await step(() => driver.info(signal)))
    const treeView = options.treeView ?? 'control'
    if (treeView === 'raw' && info.adapterVersion === '0.2.0')
      throw new Error('native_probe_view_unsupported')
    stage = 'windows'
    const all = WindowListSchema.parse(await step(() => driver.listWindows(signal)))
    result.candidates = all.windows.filter((window) =>
      options.platform === 'wework'
        ? window.processName === 'WXWork'
        : window.processName === 'WeChat' || window.processName === 'Weixin'
    )
    if (options.window) {
      result.selected = result.candidates.find((window) => window.handle === options.window) ?? null
      if (!result.selected) result.status = 'selected_window_missing'
    } else if (result.candidates.length === 0) result.status = 'no_client_window'
    else if (result.candidates.length !== 1) result.status = 'window_selection_required'
    else result.selected = result.candidates[0]
    if (result.selected) {
      stage = 'probe'
      const selected = result.selected
      const probe = NativeProbeSchema.parse(
        await step(() =>
          options.treeView
            ? driver.probe(selected, signal, treeView)
            : driver.probe(selected, signal)
        )
      )
      if (
        JSON.stringify(probe.binding) !== JSON.stringify(selected) ||
        probe.adapterVersion !== info.adapterVersion ||
        (probe.formatVersion !== 1 ? probe.treeView !== treeView : treeView !== 'control')
      )
        throw new Error('platform_probe_evidence_invalid')
      result.probe = probe
      result.status = 'metadata_collected'
    }
  } catch (error) {
    result.status = signal?.aborted && !deadline() ? 'cancelled' : 'probe_failed'
    result.failure = {
      stage,
      code: deadline()
        ? 'timed_out'
        : signal?.aborted
          ? 'cancelled'
          : error instanceof z.ZodError ||
              (error instanceof Error &&
                [
                  'platform_probe_evidence_invalid',
                  'native_probe_evidence_invalid',
                  'native_adapter_version_mismatch'
                ].includes(error.message))
            ? 'invalid_evidence'
            : error instanceof Error && error.message === 'native_probe_view_unsupported'
              ? 'unsupported_view'
              : error instanceof Error && error.message === 'native_adapter_timeout'
                ? 'timed_out'
                : 'helper_error'
    }
  } finally {
    signal?.removeEventListener('abort', cancelled)
    try {
      await driver.stop()
      result.helperExitConfirmed = true
    } catch {
      result.status = 'helper_stop_unconfirmed'
      result.failure = { stage: 'close', code: 'stop_unconfirmed' }
    }
    if (signal?.aborted && result.helperExitConfirmed) {
      result.status = deadline() ? 'probe_failed' : 'cancelled'
      result.failure = { stage, code: deadline() ? 'timed_out' : 'cancelled' }
    }
    result.completedAt = Date.now()
  }
  return PlatformProbeEvidenceSchema.parse(result)
}
