/**
 * Which database engine this process talks to.
 *
 * The product runs on PostgreSQL. A local development environment may point
 * `DATABASE_URL` at a SQLite file instead (see `docs/local-sqlite.md`): the
 * schema and the queries are the same, only the engine differs, so the few
 * engine-specific statements branch on this.
 */
export type DatabaseProvider = "postgres" | "sqlite"

/** A `file:` URL selects the SQLite file; anything else is PostgreSQL. */
export function databaseProvider(
  url: string | undefined = process.env.DATABASE_URL
): DatabaseProvider {
  return url?.trim().startsWith("file:") ? "sqlite" : "postgres"
}

/** True when the process runs against the local SQLite file. */
export function isSqlite(
  url: string | undefined = process.env.DATABASE_URL
): boolean {
  return databaseProvider(url) === "sqlite"
}
