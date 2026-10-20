import { isSqlite } from "./provider"

/**
 * A case-insensitive "contains" filter.
 *
 * PostgreSQL needs `mode: 'insensitive'`; SQLite has no such option (its
 * LIKE is already case-insensitive for ASCII). The cast keeps one codebase
 * compiling against either client.
 */
export function containsInsensitive(value: string) {
  return (
    isSqlite()
      ? { contains: value }
      : { contains: value, mode: "insensitive" as const }
  ) as { contains: string; mode?: "insensitive" }
}
