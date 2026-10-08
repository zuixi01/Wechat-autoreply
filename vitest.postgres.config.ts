import { defineConfig } from 'vitest/config'

/** Only the isolated Docker runner supplies the fresh database and test logins. */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/concurrency/**/*.test.ts'],
    maxWorkers: 1,
    testTimeout: 10000,
    hookTimeout: 30000,
    restoreMocks: true,
    clearMocks: true
  }
})
