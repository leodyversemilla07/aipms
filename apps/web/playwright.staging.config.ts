import { defineConfig, devices } from "@playwright/test"

const baseURL = process.env.STAGING_WEB_URL
if (!baseURL) throw new Error("STAGING_WEB_URL is required")
const url = new URL(baseURL)
if (url.protocol !== "https:" || url.username || url.password) {
  throw new Error("STAGING_WEB_URL must be a credential-free HTTPS origin")
}

export default defineConfig({
  testDir: "./e2e",
  testMatch: "staging-workload.spec.ts",
  fullyParallel: true,
  workers: Number.parseInt(process.env.STAGING_WORKLOAD_WORKERS ?? "5", 10),
  retries: 0,
  timeout: 60_000,
  reporter: [
    ["line"],
    [
      "json",
      {
        outputFile:
          process.env.STAGING_WORKLOAD_JSON ??
          "test-results/staging-workload.json",
      },
    ],
  ],
  use: {
    baseURL: url.origin,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    ...devices["Desktop Chrome"],
  },
})
