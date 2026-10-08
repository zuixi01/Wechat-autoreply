import { expect, it } from 'vitest'
import { DesktopActivitySchema } from '../../src/shared/contracts/desktop-activity'
import { desktopActivity } from '../helpers/desktop-activity'
it('accepts observed events without granting no-interference or send authority', () => {
  expect(DesktopActivitySchema.parse(desktopActivity())).toMatchObject({
    foregroundEvents: 2,
    focusEvents: 1,
    noInterferenceVerified: false
  })
})
it.each([
  { noInterferenceVerified: true },
  { observerStopped: false },
  { scope: 'fixture-process' },
  { clipboardText: 'PRIVATE_CONTENT' },
  { typedKeys: 'PRIVATE_CONTENT' },
  { foregroundHookInstalled: false },
  { complete: false },
  { samples: 0 },
  { cursorChangeSamples: 2 },
  { maximumSampleGapMs: 11 },
  { foregroundEvents: 16385 }
])('rejects unsupported authority, private content or inconsistent sampling %j', (change) => {
  expect(DesktopActivitySchema.safeParse({ ...desktopActivity(), ...change }).success).toBe(false)
})
it('accepts explicitly unavailable sampling and saturated diagnostics as incomplete', () => {
  expect(
    DesktopActivitySchema.parse({
      ...desktopActivity(),
      complete: false,
      samples: 0,
      incompleteReasons: ['snapshot_unavailable']
    })
  ).toMatchObject({ complete: false })
  expect(
    DesktopActivitySchema.parse({
      ...desktopActivity(),
      complete: false,
      foregroundHookInstalled: false,
      incompleteReasons: ['hook_unavailable']
    })
  ).toMatchObject({ complete: false })
  expect(
    DesktopActivitySchema.parse({
      ...desktopActivity(),
      complete: false,
      samples: 16384,
      cursorChangeSamples: 16384,
      incompleteReasons: ['event_limit']
    })
  ).toMatchObject({ complete: false })
})
