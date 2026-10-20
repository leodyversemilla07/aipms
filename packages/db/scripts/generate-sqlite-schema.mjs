/**
 * Generates the SQLite development schema from the canonical PostgreSQL one.
 *
 * The models are identical - only the datasource provider differs - so the
 * local SQLite environment runs the same schema as production instead of a
 * hand-maintained copy that could drift.
 */
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

const root = path.join(import.meta.dirname, "..")
const source = path.join(root, "prisma", "schema.prisma")
const target = path.join(root, "prisma", "schema.sqlite.prisma")

const canonical = readFileSync(source, "utf8")
let sqlite = canonical.replace(
  /datasource db \{\s*provider = "postgresql"\s*\}/u,
  'datasource db {\n  provider = "sqlite"\n}'
)

if (sqlite === canonical) {
  throw new Error(
    "could not rewrite the datasource provider - the canonical schema changed shape"
  )
}

// SQLite can only auto-increment a primary key, so the audit chain's
// sequence is assigned by the writer there (the schema keeps the column
// identical otherwise).
sqlite = sqlite.replace(
  /seq {7}Int {6}@unique @default\(autoincrement\(\)\)/u,
  "seq       Int      @unique"
)

if (sqlite.includes("autoincrement()")) {
  throw new Error(
    "the canonical schema has an auto-increment column SQLite cannot express"
  )
}

writeFileSync(target, sqlite)
console.log(`[sqlite] wrote ${path.relative(root, target)}`)
