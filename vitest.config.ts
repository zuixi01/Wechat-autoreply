import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'tests/unit/**/*.test.ts',
      'tests/integration/**/*.test.ts',
      'tests/regression/**/*.test.ts'
    ],
    restoreMocks: true,
    clearMocks: true,
    // A single PGlite WASM worker avoids memory contention on daily-use PCs.
    // This does not alter runtime reply concurrency or test timeouts.
    maxWorkers: 1,
    testTimeout: 5000
  }
})
