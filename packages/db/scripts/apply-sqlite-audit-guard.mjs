#!/usr/bin/env node
/**
 * Applies the SQLite audit append-only guard to the local file database.
 *
 * PostgreSQL gets the guard from its migration. The local SQLite database is
 * created with `prisma db push`, which carries no triggers, so the same
 * guarantee is applied here. A PostgreSQL URL is left untouched: its
 * migration history already owns the guard.
 */
import { readFileSync } from "node:fs"
import path from "node:path"

const url = (process.env.DATABASE_URL ?? "").trim()
if (!url.startsWith("file:")) {
  console.log(
    "[sqlite] not a SQLite database - the migration history owns the audit guard"
  )
  process.exit(0)
}

const { createClient } = await import("@libsql/client")
const sql = readFileSync(
  path.join(
    import.meta.dirname,
    "..",
    "prisma",
    "sqlite",
    "audit-append-only.sql"
  ),
  "utf8"
)

const client = createClient({ url })
try {
  await client.executeMultiple(sql)
  console.log("[sqlite] applied the audit append-only guard")
} finally {
  client.close()
}
