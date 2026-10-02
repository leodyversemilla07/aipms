import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

const moduleUrl = new URL("../src/index.ts", import.meta.url).href
test("an explicit env file is exclusive and respects explicit process overrides", () => {
  const root = mkdtempSync(join(tmpdir(), "aipms-env-selected-"))
  try {
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []")
    writeFileSync(join(root, ".env"), "ROOT_SENTINEL=must-not-load")
    writeFileSync(join(root, ".env.local"), "LOCAL_SENTINEL=must-not-load")
    writeFileSync(
      join(root, ".env.demo"),
      "SELECTED_SENTINEL=demo\nOVERRIDE_SENTINEL=file"
    )
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { loadRootEnv } from ${JSON.stringify(moduleUrl)}
      loadRootEnv()
      console.log(JSON.stringify({
        selected: process.env.SELECTED_SENTINEL,
        override: process.env.OVERRIDE_SENTINEL,
        root: process.env.ROOT_SENTINEL,
        local: process.env.LOCAL_SENTINEL
      }))
    `,
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          AIPMS_ENV_FILE: ".env.demo",
          OVERRIDE_SENTINEL: "process",
        },
      }
    )
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), {
      selected: "demo",
      override: "process",
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("missing selected files fail closed instead of falling back", () => {
  const root = mkdtempSync(join(tmpdir(), "aipms-env-missing-"))
  try {
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []")
    writeFileSync(join(root, ".env"), "DATABASE_URL=must-not-load")
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { loadRootEnv } from ${JSON.stringify(moduleUrl)}
      loadRootEnv()
    `,
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, AIPMS_ENV_FILE: ".env.missing" },
      }
    )
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /ENOENT/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
