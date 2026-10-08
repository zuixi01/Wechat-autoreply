import { z } from 'zod'
const Count = z.number().int().min(0).max(16384)
/** Read-only session diagnostics. No event attribution and no send authority. */
export const DesktopActivitySchema = z
  .strictObject({
    scope: z.literal('session'),
    pollIntervalMs: z.literal(10),
    foregroundEvents: Count,
    focusEvents: Count,
    cursorChangeSamples: Count,
    clipboardChangeSamples: Count,
    inputChangeSamples: Count,
    samples: Count,
    observedForMs: z.number().int().min(0).max(10000),
    maximumSampleGapMs: z.number().int().min(0).max(10000),
    foregroundHookInstalled: z.boolean(),
    focusHookInstalled: z.boolean(),
    timerInstalled: z.boolean(),
    observerStopped: z.literal(true),
    complete: z.boolean(),
    incompleteReasons: z
      .array(
        z.enum([
          'startup_unconfirmed',
          'hook_unavailable',
          'timer_unavailable',
          'snapshot_unavailable',
          'message_loop_failed',
          'event_limit'
        ])
      )
      .max(6),
    noInterferenceVerified: z.literal(false)
  })
  .superRefine((value, context) => {
    const invalid = (): void => {
      context.addIssue({ code: 'custom', message: 'inconsistent_desktop_activity' })
    }
    if (
      value.complete !== (value.incompleteReasons.length === 0) ||
      new Set(value.incompleteReasons).size !== value.incompleteReasons.length ||
      value.maximumSampleGapMs > value.observedForMs
    )
      invalid()
    if (
      (!value.foregroundHookInstalled || !value.focusHookInstalled) &&
      !value.incompleteReasons.includes('hook_unavailable')
    )
      invalid()
    if (!value.timerInstalled && !value.incompleteReasons.includes('timer_unavailable')) invalid()
    if (value.samples === 0 && !value.incompleteReasons.includes('snapshot_unavailable')) invalid()
    const maximumChanges = value.incompleteReasons.includes('event_limit')
      ? 16384
      : Math.max(0, value.samples - 1)
    if (
      [value.cursorChangeSamples, value.clipboardChangeSamples, value.inputChangeSamples].some(
        (count) => count > maximumChanges
      )
    )
      invalid()
  })
export type DesktopActivity = z.infer<typeof DesktopActivitySchema>
