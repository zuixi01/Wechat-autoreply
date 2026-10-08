export const desktopActivity = () => ({
  scope: 'session' as const,
  pollIntervalMs: 10 as const,
  foregroundEvents: 2,
  focusEvents: 1,
  cursorChangeSamples: 0,
  clipboardChangeSamples: 0,
  inputChangeSamples: 0,
  samples: 2,
  observedForMs: 10,
  maximumSampleGapMs: 10,
  foregroundHookInstalled: true,
  focusHookInstalled: true,
  timerInstalled: true,
  observerStopped: true as const,
  complete: true,
  incompleteReasons: [] as string[],
  noInterferenceVerified: false as const
})
