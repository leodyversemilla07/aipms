import "@workspace/env/load"

import path from "node:path"
import { defineConfig, env } from "prisma/config"

// The local SQLite environment runs the same models against a file. Its
// schema variant is generated from the canonical one (same models, different
// provider) and the database is created with `db push` rather than from the
// PostgreSQL migration history.
const sqlite = (process.env.DATABASE_URL ?? "").trim().startsWith("file:")

export default defineConfig({
  schema: sqlite
    ? path.join("prisma", "schema.sqlite.prisma")
    : path.join("prisma", "schema.prisma"),
  migrations: {
    path: sqlite
      ? path.join("prisma", "migrations-sqlite")
      : path.join("prisma", "migrations"),
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
})
