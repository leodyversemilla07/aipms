import assert from "node:assert/strict"
import { after, describe, it } from "node:test"

import { loadRootEnv, parseEnv } from "../src/index"

describe("loadRootEnv", () => {
  after(() => {
    delete process.env.TEST_WORKSPACE_VAR
  })

  it("loads env from the pnpm workspace root without throwing", () => {
    assert.doesNotThrow(() => loadRootEnv())
  })

  it("does not override an existing value in the process environment", () => {
    process.env.TEST_WORKSPACE_VAR = "keep"
    loadRootEnv()
    assert.equal(process.env.TEST_WORKSPACE_VAR, "keep")
  })
})

describe("parseEnv contract", () => {
  it("parses a DATABASE_URL line into a value", () => {
    const parsed = parseEnv('DATABASE_URL="postgresql://x:y@localhost:5432/z"')
    assert.equal(parsed.DATABASE_URL, "postgresql://x:y@localhost:5432/z")
  })
})
