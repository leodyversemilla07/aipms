#!/usr/bin/env node
/**
 * Runs the API test suites against a local SQLite file.
 *
 * Every deployed environment runs PostgreSQL, and CI gates the suites there.
 * This script makes the same suites runnable on a workstation with no
 * database server: it creates a disposable `*_test` file, applies the
 * canonical schema, the audit append-only guard and the seed data, then runs
 * the unit and integration lanes.
 *
 * The probes that only PostgreSQL can produce - a row lock that blocks, a
 * reader that must not see an uncommitted row - are skipped there, because
 * SQLite serialises writers for the whole transaction.
 *
 * Usage:
 *   pnpm test:sqlite
 */
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const rootDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const localDirectory = join(rootDirectory, ".local")
// The name has to end in `_test`: the isolated-test guard accepts a
// disposable SQLite file the same way it accepts a disposable PostgreSQL
// database.
const databasePath = join(localDirectory, "aipms_test.db")
const databaseUrl = `file:${databasePath.replace(/\\/g, "/")}`

function log(message) {
  console.log(message)
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

async function run(command, args, { cwd, env } = {}) {
  const windowsPnpm = process.platform === "win32" && command === "pnpm"
  const executable = windowsPnpm ? (process.env.ComSpec ?? "cmd.exe") : command
  const parameters = windowsPnpm
    ? ["/d", "/s", "/c", ["pnpm", ...args].join(" ")]
    : args
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, parameters, {
      cwd,
      env,
      stdio: "inherit",
    })
    child.on("error", () =>
      reject(new Error(`Cannot launch ${command}; check installation and PATH`))
    )
    child.on("close", (code) => {
      if (code === 0) {
        resolveResult()
        return
      }
      reject(
        new Error(`${command} ${args[0] ?? ""} failed with exit code ${code}`)
      )
    })
  })
}

mkdirSync(localDirectory, { recursive: true })
if (existsSync(databasePath)) rmSync(databasePath, { force: true })

const environment = {
  ...process.env,
  DATABASE_URL: databaseUrl,
  AIPMS_TEST_DATABASE_URL: databaseUrl,
}

log(`[sqlite] test database: ${databasePath}`)

// The generated client is engine-specific, so it is rebuilt for SQLite
// before the file is created. `pnpm db:generate` restores the PostgreSQL
// client afterwards.
await run("pnpm", ["--filter", "@workspace/db", "db:generate"], {
  cwd: rootDirectory,
  env: environment,
})
await run(
  "pnpm",
  ["--filter", "@workspace/db", "exec", "prisma", "db", "push"],
  { cwd: rootDirectory, env: environment }
)
// `db push` carries no triggers, so the audit append-only guard that the
// PostgreSQL migration installs is applied here.
await run(
  "pnpm",
  [
    "--filter",
    "@workspace/db",
    "exec",
    "node",
    "scripts/apply-sqlite-audit-guard.mjs",
  ],
  { cwd: rootDirectory, env: environment }
)
await run(
  "pnpm",
  ["--filter", "@workspace/db", "exec", "prisma", "db", "seed"],
  { cwd: rootDirectory, env: environment }
)

log("")
log("Running the database-blocked unit lane.")
await run("pnpm", ["--filter", "api", "test:unit"], {
  cwd: rootDirectory,
  env: environment,
})

log("")
log("Running the integration lane.")
try {
  await run("pnpm", ["--filter", "api", "test"], {
    cwd: rootDirectory,
    env: environment,
  })
} catch (error) {
  fail(
    `${error instanceof Error ? error.message : String(error)}\nThe SQLite file is disposable: rerun \`pnpm test:sqlite\` to start from a clean database.`
  )
}

log("")
log("The API suites pass on SQLite.")
log(
  "PostgreSQL remains the deployed engine: run `pnpm db:generate` to restore the PostgreSQL client."
)
