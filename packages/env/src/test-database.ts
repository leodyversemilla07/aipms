import "./load"

/** Database-backed suites delete/tamper rows. Require explicit isolation. */
export default function requireIsolatedTestDatabase(
  environment: NodeJS.ProcessEnv = process.env
) {
  const selected = environment.AIPMS_TEST_DATABASE_URL
  const active = environment.DATABASE_URL
  if (!selected || !active || selected !== active) {
    throw new Error(
      "Database-backed tests require AIPMS_TEST_DATABASE_URL and an identical DATABASE_URL pointing to a disposable *_test database. Never run them against the development database."
    )
  }

  let database: string
  try {
    const url = new URL(active)
    if (!["postgres:", "postgresql:"].includes(url.protocol)) {
      throw new Error("not PostgreSQL")
    }
    database = decodeURIComponent(url.pathname.slice(1))
  } catch {
    throw new Error("AIPMS_TEST_DATABASE_URL must be a valid PostgreSQL URL")
  }
  if (!/^[a-zA-Z0-9_]+_test$/.test(database)) {
    throw new Error(
      "Database-backed tests require a dedicated database whose name ends in _test"
    )
  }
}
