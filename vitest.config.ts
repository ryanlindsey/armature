import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // See tests/setup.ts: fails any test that lets a mutation log line reach the real stderr.
    setupFiles: ['tests/setup.ts'],
  },
})
