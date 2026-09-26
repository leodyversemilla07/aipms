import '@workspace/env/load'

/** Vitest runs integration specs that delete and tamper rows. Fail closed. */
export default function requireIsolatedTestDatabase() {
  const selected = process.env.AIPMS_TEST_DATABASE_URL
  const active = process.env.DATABASE_URL
  if (!selected || !active || selected !== active) {
    throw new Error(
      'API tests require AIPMS_TEST_DATABASE_URL and an identical DATABASE_URL pointing to a disposable *_test database. Never run them against the development database.',
    )
  }

  let database: string
  try {
    const url = new URL(active)
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
      throw new Error('not PostgreSQL')
    }
    database = decodeURIComponent(url.pathname.slice(1))
  } catch {
    throw new Error('AIPMS_TEST_DATABASE_URL must be a valid PostgreSQL URL')
  }
  if (!/^[a-zA-Z0-9_]+_test$/.test(database)) {
    throw new Error(
      'API tests require a dedicated database whose name ends in _test',
    )
  }
}
