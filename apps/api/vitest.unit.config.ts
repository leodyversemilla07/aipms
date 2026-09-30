import { defineConfig } from 'vitest/config'
import integrationConfig from './vitest.config.ts'

/** Only explicitly selected, database-blocked unit tests run in this lane. */
export default defineConfig({
  ...integrationConfig,
  test: {
    ...integrationConfig.test,
    globalSetup: [],
    setupFiles: ['test/unit/no-database.ts'],
    include: ['test/unit/**/*.spec.ts', 'test/intake-agent-projection.spec.ts'],
  },
})
