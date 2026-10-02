import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, test } from "node:test"
import {
  demoEnvironment,
  loadDemoConfig,
  newDemoConfig,
  runCommand,
  runDemo,
  validateDemoConfig,
} from "./local-demo.mjs"

const roots = []
const dependencyOutput = (args) =>
  args[0] === "context" ? JSON.stringify("unix:///var/run/docker.sock") : ""
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aipms-demo-"))
  roots.push(root)
  const calls = []
  const log = []
  const run = async (command, args, options) => {
    calls.push({ command, args, options })
    return dependencyOutput(args)
  }
  return {
    root,
    calls,
    options: { root, run, log: (value) => log.push(value) },
    log,
  }
}

test("generates independent secrets and only an isolated loopback database", () => {
  const config = newDemoConfig()
  assert.equal(
    new Set(
      Object.entries(config)
        .filter(
          ([key]) =>
            key.endsWith("SECRET") ||
            key.endsWith("TOKEN") ||
            key === "POSTGRES_PASSWORD"
        )
        .map(([, value]) => value)
    ).size,
    6
  )
  assert.equal(validateDemoConfig(config), config)
  assert.match(config.DATABASE_URL, /@127\.0\.0\.1:55433\/aipms_demo$/)
})

test("rejects unsafe database/origin/provider/automation configuration without echoing values", () => {
  const config = newDemoConfig()
  for (const patch of [
    { DATABASE_URL: "postgresql://secret@production/company" },
    { APP_URL: "https://production.example" },
    { NODE_ENV: "production" },
    { AUTH_SEED_DEMO: "0" },
    { AIPMS_MESSAGING_TRANSPORT: "smtp" },
    { AGENT_AUTORUN: "1" },
    { AIPMS_IMAP_HOST: "live-mail.example" },
    { POSTGRES_PASSWORD: "weak-password" },
  ]) {
    assert.throws(() => validateDemoConfig({ ...config, ...patch }))
  }
})

test("reuses credentials without overwriting root environments or existing demo data", () => {
  const f = fixture()
  writeFileSync(join(f.root, ".env"), "DATABASE_URL=production-sentinel")
  writeFileSync(
    join(f.root, ".env.local"),
    "AIPMS_SMTP_PASSWORD=private-sentinel"
  )
  const first = loadDemoConfig(f.root, true)
  const bytes = readFileSync(join(f.root, ".env.demo"), "utf8")
  assert.deepEqual(loadDemoConfig(f.root, true), first)
  assert.equal(readFileSync(join(f.root, ".env.demo"), "utf8"), bytes)
  assert.equal(
    readFileSync(join(f.root, ".env"), "utf8"),
    "DATABASE_URL=production-sentinel"
  )
  assert.equal(
    readFileSync(join(f.root, ".env.local"), "utf8"),
    "AIPMS_SMTP_PASSWORD=private-sentinel"
  )
})

test("never inherits active database or external provider settings", () => {
  const config = newDemoConfig()
  const env = demoEnvironment("/isolated-root", config, {
    PATH: "/bin",
    DATABASE_URL: "production",
    AIPMS_SMTP_HOST: "live-mail",
    QBO_CLIENT_SECRET: "private",
    GOOGLE_CLIENT_SECRET: "private",
    NODE_ENV: "production",
    NODE_OPTIONS: "--inspect=0.0.0.0",
    AIPMS_TEST_DATABASE_URL: "development",
    AGENT_AUTORUN: "1",
  })
  assert.equal(env.PATH, "/bin")
  assert.equal(env.DATABASE_URL, config.DATABASE_URL)
  assert.equal(env.AGENT_AUTORUN, "0")
  for (const key of [
    "AIPMS_SMTP_HOST",
    "QBO_CLIENT_SECRET",
    "GOOGLE_CLIENT_SECRET",
    "NODE_OPTIONS",
    "AIPMS_TEST_DATABASE_URL",
  ])
    assert.equal(env[key], undefined)
  assert.equal(env.AIPMS_ENV_FILE, join("/isolated-root", ".env.demo"))
})

test("setup orders install, owned PostgreSQL, generation, migrations, then seeding", async () => {
  const f = fixture()
  await runDemo("setup", f.options)
  assert.deepEqual(
    f.calls.filter((call) => call.command === "pnpm").map((call) => call.args),
    [
      ["install", "--frozen-lockfile"],
      ["db:generate"],
      ["db:deploy"],
      ["db:seed"],
    ]
  )
  const up = f.calls.findIndex((call) => call.args.includes("up"))
  const deploy = f.calls.findIndex((call) => call.args.includes("db:deploy"))
  const seed = f.calls.findIndex((call) => call.args.includes("db:seed"))
  assert.ok(up < deploy && deploy < seed)
  for (const call of f.calls) {
    assert.ok(!call.args.includes("reset") && !call.args.includes("down"))
    if (call.args.includes("compose") && !call.args.includes("version"))
      assert.ok(call.args.includes("docker-compose.demo.yml"))
  }
})

test("fails on unavailable Docker before writing credentials or installing dependencies", async () => {
  const f = fixture()
  await assert.rejects(
    runDemo("setup", {
      ...f.options,
      run: async () => {
        throw new Error("private dependency diagnostics")
      },
    }),
    /Docker\/Compose is unavailable/
  )
  assert.throws(() => readFileSync(join(f.root, ".env.demo")))
  assert.equal(f.calls.length, 0)
})

test("refuses foreign container and orphaned volume ownership before migrations", async () => {
  for (const kind of ["container", "volume"]) {
    const f = fixture()
    await assert.rejects(
      runDemo("setup", {
        ...f.options,
        run: async (command, args, options) => {
          f.calls.push({ command, args, options })
          if (args[0] === kind && args[1] === "ls") return "foreign-resource"
          if (args[0] === kind && args[1] === "inspect")
            return JSON.stringify({ "aipms.demo.owner": "another-workspace" })
          return dependencyOutput(args)
        },
      }),
      /Refusing to adopt/
    )
    assert.ok(
      !f.calls.some(
        (call) => call.args.includes("up") || call.command === "pnpm"
      )
    )
  }
})

test("allows explicitly owned resources on repeat setup", async () => {
  const f = fixture()
  const config = loadDemoConfig(f.root, true)
  await runDemo("setup", {
    ...f.options,
    run: async (command, args, options) => {
      f.calls.push({ command, args, options })
      if (args[0] === "context") return dependencyOutput(args)
      if (args[1] === "ls") return "owned-resource"
      if (args[1] === "inspect")
        return JSON.stringify({ "aipms.demo.owner": config.AIPMS_DEMO_ID })
      return dependencyOutput(args)
    },
  })
  assert.ok(f.calls.some((call) => call.args.includes("db:seed")))
})

test("does not seed after a failed migration or remove any resources", async () => {
  const f = fixture()
  await assert.rejects(
    runDemo("setup", {
      ...f.options,
      run: async (command, args, options) => {
        f.calls.push({ command, args, options })
        if (args.includes("db:deploy")) throw new Error("migration failed")
        return dependencyOutput(args)
      },
    }),
    /migration failed/
  )
  assert.ok(
    !f.calls.some(
      (call) => call.args.includes("db:seed") || call.args.includes("down")
    )
  )
})

test("API/web check free ports and use isolated environments without starting an AI runtime", async () => {
  for (const action of ["api", "web"]) {
    const f = fixture()
    loadDemoConfig(f.root, true)
    const ports = []
    await runDemo(action, {
      ...f.options,
      freePort: async (port) => ports.push(port),
    })
    assert.deepEqual(ports, [action === "api" ? 3001 : 3000])
    const launched = f.calls.at(-1)
    assert.equal(launched.options.env.NODE_ENV, "development")
    assert.equal(launched.options.env.API_BIND_HOST, "127.0.0.1")
    assert.ok(launched.args.includes(action))
    assert.ok(!launched.args.includes("agent"))
  }
})

test("occupied ports fail before starting an application", async () => {
  const f = fixture()
  loadDemoConfig(f.root, true)
  await assert.rejects(
    runDemo("api", {
      ...f.options,
      freePort: async () => {
        throw new Error("occupied")
      },
    }),
    /occupied/
  )
  assert.ok(!f.calls.some((call) => call.command === "pnpm"))
})

test("stop preserves the volume and never selects deployment Compose", async () => {
  const f = fixture()
  loadDemoConfig(f.root, true)
  await runDemo("stop", f.options)
  assert.ok(f.calls.at(-1).args.includes("stop"))
  assert.ok(f.calls.at(-1).args.includes("docker-compose.demo.yml"))
  assert.ok(
    !f.calls.some(
      (call) => call.args.includes("--volumes") || call.args.includes("down")
    )
  )
})

test("status requires actual API readiness and web reachability", async () => {
  const f = fixture()
  loadDemoConfig(f.root, true)
  await runDemo("status", {
    ...f.options,
    fetchUrl: async (url) => ({
      ok: true,
      json: async () => ({ status: url.includes("health") ? "ready" : "web" }),
    }),
  })
  assert.ok(f.log.some((line) => line.includes("API ready")))
  await assert.rejects(
    runDemo("status", { ...f.options, fetchUrl: async () => ({ ok: false }) }),
    /not ready/
  )
})

test("remote Docker contexts are refused before creating credentials or resources", async () => {
  const f = fixture()
  await assert.rejects(
    runDemo("setup", {
      ...f.options,
      run: async (_command, args) =>
        args[0] === "context" ? JSON.stringify("ssh://production-server") : "",
    }),
    /refusing remote daemons/
  )
  assert.throws(() => readFileSync(join(f.root, ".env.demo")))
})

test("captured dependencies have bounded waits and do not expose diagnostic secrets", async () => {
  await assert.rejects(
    runCommand(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
      capture: true,
      timeoutMs: 50,
    }),
    /timed out/
  )
  await assert.rejects(
    runCommand(
      process.execPath,
      ["-e", "console.error('diagnostic-secret'); process.exit(2)"],
      {
        capture: true,
      }
    ),
    (error) =>
      !error.message.includes("diagnostic-secret") &&
      error.message.includes("failed")
  )
})

test("unknown actions are refused without dependency calls", async () => {
  const f = fixture()
  await assert.rejects(runDemo("reset", f.options), /Usage/)
  assert.equal(f.calls.length, 0)
})
