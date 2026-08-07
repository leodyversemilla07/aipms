import unpluginSwc from 'unplugin-swc'
import { defineConfig } from 'vitest/config'

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
    environment: 'node',
    globals: true,
    // Integration specs share one Postgres; serial files avoid cross-file
    // contention on shared state (sequential numbers, "latest policy"
    // resolution) on top of the per-feature supersede chains.
    fileParallelism: false,
    include: ['test/**/*.spec.ts', 'test/**/*.e2e-spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
    },
  },
})
