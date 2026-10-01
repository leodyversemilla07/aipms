import assert from "node:assert/strict"
import { describe, it } from "node:test"
import requireIsolatedTestDatabase from "../src/test-database"

const url = "postgresql://aipms:aipms@localhost:5432/aipms_test"

describe("requireIsolatedTestDatabase", () => {
  it("accepts identical explicit PostgreSQL test URLs", () => {
    for (const active of [url, url.replace("postgresql:", "postgres:")]) {
      assert.doesNotThrow(() =>
        requireIsolatedTestDatabase({
          DATABASE_URL: active,
          AIPMS_TEST_DATABASE_URL: active,
        })
      )
    }
  })

  it("rejects missing URLs instead of falling back to development", () => {
    for (const environment of [
      {},
      { DATABASE_URL: url },
      { AIPMS_TEST_DATABASE_URL: url },
      { DATABASE_URL: "", AIPMS_TEST_DATABASE_URL: "" },
    ]) {
      assert.throws(() => requireIsolatedTestDatabase(environment), /identical/)
    }
  })

  it("rejects different database targets or credentials", () => {
    for (const selected of [
      url.replace("localhost", "other-host"),
      url.replace("aipms_test", "other_test"),
      url.replace("aipms:aipms", "aipms:other"),
    ]) {
      assert.throws(
        () =>
          requireIsolatedTestDatabase({
            DATABASE_URL: url,
            AIPMS_TEST_DATABASE_URL: selected,
          }),
        /identical/
      )
    }
  })

  it("rejects malformed and non-PostgreSQL URLs", () => {
    for (const active of ["not a URL", "https://localhost/aipms_test"]) {
      assert.throws(
        () =>
          requireIsolatedTestDatabase({
            DATABASE_URL: active,
            AIPMS_TEST_DATABASE_URL: active,
          }),
        /valid PostgreSQL URL/
      )
    }
  })

  it("rejects ordinary, suffix-lookalike, or unsafe database names", () => {
    for (const name of [
      "aipms",
      "aipms_test_prod",
      "test",
      "aipms-test",
      "aipms_test/other",
    ]) {
      const active = url.replace("aipms_test", name)
      assert.throws(
        () =>
          requireIsolatedTestDatabase({
            DATABASE_URL: active,
            AIPMS_TEST_DATABASE_URL: active,
          }),
        /name ends in _test/
      )
    }
  })
})
