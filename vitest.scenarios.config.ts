import { defineConfig } from 'vitest/config'

// Capacity replays run separately so employees' PCs do not run WASM SQL suites
// alongside the 20-agent workload. This timeout bounds the harness, not an SLA.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/scenarios/**/*.test.ts'],
    restoreMocks: true,
    clearMocks: true,
    maxWorkers: 1,
    testTimeout: 60000
  }
})
