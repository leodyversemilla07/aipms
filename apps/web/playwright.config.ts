import { defineConfig, devices } from "@playwright/test"
import requireIsolatedTestDatabase from "@workspace/env/test-database"

// Browser specs mutate financial records too; use the same fail-closed guard
// as API integration tests, before starting either application server.
requireIsolatedTestDatabase()

/**
 * End-to-end suite over the real stack: Next.js desk + NestJS tRPC API on
 * disposable Postgres (matching DATABASE_URL / AIPMS_TEST_DATABASE_URL,
 * database name ending in _test). Both servers are booted here; the database
 * must already be migrated and seeded (CI does this in job steps; locally run
 * `pnpm db:deploy && pnpm db:seed` with both test URLs explicitly set first) and the API needs demo identities
 * (AUTH_SEED_DEMO=1) for sign-in.
 */
export default defineConfig({
  testDir: "./e2e",
  testIgnore: "staging-workload.spec.ts",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    // Match APP_URL / Better Auth trusted origin for browser sign-in.
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "setup",
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        storageState: "e2e/.auth/maker.json",
      },
      dependencies: ["setup"],
    },
  ],
  webServer: [
    {
      // Watcher-free boot: the dev script's node --watch fights the
      // nestjs-trpc codegen watcher (every regenerated server.ts restarts
      // the API, which never settles on a fresh checkout). The client is
      // regenerated first because it is engine-specific.
      command:
        "pnpm --filter @workspace/db db:generate && node --import @swc-node/register/esm-register src/main.ts",
      cwd: "../api",
      url: "http://localhost:3001/",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        AUTH_SEED_DEMO: "1",
        PORT: "3001",
      },
    },
    {
      // Production build + start: the browser suite must exercise the real
      // document security posture, including the per-request nonce CSP from
      // proxy.ts (dev-mode CSP allows 'unsafe-eval' and would silently miss
      // production-only breakage).
      command: "pnpm --filter web build && pnpm --filter web start",
      url: "http://localhost:3000/",
      reuseExistingServer: !process.env.CI,
      timeout: 240_000,
    },
  ],
})
