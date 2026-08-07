import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { parseEnv } from "@workspace/env"

const LOCAL_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "0.0.0.0",
])

const command = process.argv[2] ?? "this command"
const resolved = resolveDatabaseUrl()

if (!resolved) {
  console.error(
    `\n  ${command} needs DATABASE_URL, and nothing set it.` +
      "\n  Copy .env.example to .env at the repo root.\n"
  )
  process.exit(1)
}

const host = hostOf(resolved.url)

if (LOCAL_HOSTS.has(host)) process.exit(0)

if (process.env.ALLOW_REMOTE_DB === "1") {
  console.warn(`\n  ⚠ ${command} is running against ${host} — not local.\n`)
  process.exit(0)
}

console.error(
  [
    "",
    `  Refusing to run ${command} against ${host}.`,
    "",
    `  That is not a local database, and ${command} can rewrite or drop`,
    `  schemas. The value came from ${resolved.from}.`,
    "",
    "  To do this deliberately anyway:",
    "",
    `    ALLOW_REMOTE_DB=1 pnpm run ${command}`,
    "",
  ].join("\n")
)

process.exit(1)

function resolveDatabaseUrl(): { url: string; from: string } | null {
  const root = workspaceRoot()

  if (root) {
    for (const file of [".env.local", ".env"]) {
      const path = join(root, file)
      try {
        const url = parseEnv(readFileSync(path, "utf8")).DATABASE_URL
        if (url) return { url, from: file }
      } catch {}
    }
  }

  const fromEnvironment = process.env.DATABASE_URL
  return fromEnvironment
    ? { url: fromEnvironment, from: "the environment" }
    : null
}

function workspaceRoot(): string | null {
  let directory = process.cwd()

  while (true) {
    try {
      // pnpm declares workspaces via pnpm-workspace.yaml; npm/yarn/bun via
      // the package.json "workspaces" field. Recognize both.
      const hasPnpmWorkspace = existsSync(
        join(directory, "pnpm-workspace.yaml")
      )
      const manifest = JSON.parse(
        readFileSync(join(directory, "package.json"), "utf8")
      ) as { workspaces?: boolean }
      if (hasPnpmWorkspace || manifest.workspaces) return directory
    } catch {}

    const parent = dirname(directory)
    if (parent === directory) return null
    directory = parent
  }
}

function hostOf(value: string): string {
  try {
    return new URL(value).hostname
  } catch {
    return value
  }
}
