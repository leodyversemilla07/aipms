import requireIsolatedTestDatabase from '@workspace/env/test-database'

/** Vitest passes a project context, not an environment, to globalSetup. */
export default function guardApiTestDatabase() {
  requireIsolatedTestDatabase()
}
