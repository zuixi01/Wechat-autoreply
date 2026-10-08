import { defineConfig } from 'vitest/config'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

export default defineConfig({
  // The standalone server also installs pg. Use one module identity in this test
  // process so transaction mocks cover server imports as well as desktop tools.
  resolve: { alias: [{ find: /^pg$/, replacement: require.resolve('pg') }] },
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
