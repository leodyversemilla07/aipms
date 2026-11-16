import unpluginSwc from 'unplugin-swc'
import { configDefaults, defineConfig } from 'vitest/config'

/**
 * The suite runs against the deployed engine (PostgreSQL). A local SQLite
 * file works too - see `pnpm test:sqlite` - and that engine is slower
 * through its driver adapter, so it gets more headroom per test.
 */
const sqlite = (process.env.DATABASE_URL ?? '').trim().startsWith('file:')

export default defineConfig({
  plugins: [
    // SWC with Nest-compatible decorator metadata (emitDecoratorMetadata).
    // Required for NestJS DI via @nestjs/testing; tsx/esbuild cannot emit it.
    unpluginSwc.vite({
      jsc: {
        target: 'es2023',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
  test: {
    globalSetup: ['test/test-db.guard.ts'],
    environment: 'node',
    globals: true,
    // Integration specs share one Postgres; serial files avoid cross-file
    // contention on shared state (sequential numbers, "latest policy"
    // resolution) on top of the per-feature supersede chains.
    fileParallelism: false,
    include: ['test/**/*.spec.ts', 'test/**/*.e2e-spec.ts'],
    // The database-blocked unit specs belong to the unit lane: they inject
    // fake clients and must never reach the real one. Running them here as
    // well would put the same specs in two lanes with different engines.
    exclude: [...configDefaults.exclude, 'test/unit/**'],
    testTimeout: sqlite ? 30_000 : 5_000,
    hookTimeout: sqlite ? 60_000 : 10_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
    },
  },
})
