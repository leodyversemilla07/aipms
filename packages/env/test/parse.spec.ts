import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { parseEnv } from "../src/index"

describe("parseEnv", () => {
  it("reads plain, double-quoted, and single-quoted values", () => {
    assert.deepEqual(
      parseEnv(`
        DATABASE_URL="postgresql://postgres:postgres@localhost:5432/aipms"
        PORT=3001
        SINGLE='single quoted'
      `),
      {
        DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/aipms",
        PORT: "3001",
        SINGLE: "single quoted",
      }
    )
  })

  it("ignores comments, blank lines, and inline comments", () => {
    assert.deepEqual(
      parseEnv(
        ["# a heading", "", "  # indented", "PORT=3001 # the api", "A=1"].join(
          "\n"
        )
      ),
      { PORT: "3001", A: "1" }
    )
  })

  it("keeps a # that is part of an unquoted value", () => {
    assert.deepEqual(parseEnv("PASSWORD=pa#ssword\nPORT=3001"), {
      PASSWORD: "pa#ssword",
      PORT: "3001",
    })
  })

  it("unwraps double-quoted values including escaped newlines", () => {
    assert.deepEqual(parseEnv('MULTI="line1\\nline2"'), {
      MULTI: "line1\nline2",
    })
  })

  it("supports the export prefix", () => {
    assert.deepEqual(parseEnv("export FOO=bar"), { FOO: "bar" })
  })
})
