import { defineConfig, devices } from "@playwright/test"

/**
 * End-to-end suite over the real stack: Next.js desk + NestJS tRPC API on
 * local Postgres. Both servers are booted here; the database must already
 * be migrated and seeded (CI does this in job steps; locally run
 * `pnpm db:deploy && pnpm db:seed` first) and the API needs demo identities
 * (AUTH_SEED_DEMO=1) for sign-in.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://127.0.0.1:3000",
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
      // the API, which never settles on a fresh checkout).
      command: "node --import @swc-node/register/esm-register src/main.ts",
      cwd: "../api",
      url: "http://127.0.0.1:3001/",
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
      command: "pnpm --filter web dev",
      url: "http://localhost:3000/",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
})
