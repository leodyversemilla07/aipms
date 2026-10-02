#!/usr/bin/env node
import { spawn } from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { parseEnv } from "../packages/env/src/index.ts"

const rootDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const secret = () => randomBytes(32).toString("hex")
const fixed = {
  NODE_ENV: "development",
  POSTGRES_USER: "demo",
  POSTGRES_DB: "aipms_demo",
  POSTGRES_PORT: "55433",
  APP_URL: "http://localhost:3000",
  AUTH_TRUSTED_ORIGINS: "http://localhost:3000",
  API_URL: "http://localhost:3001",
  API_BIND_HOST: "127.0.0.1",
  NEXT_PUBLIC_API_URL: "http://localhost:3001",
  AUTH_SEED_DEMO: "1",
  AIPMS_MESSAGING_TRANSPORT: "log",
  AGENT_AUTORUN: "0",
  AIPMS_AGENT_WAKE: "0",
}
const secretNames = [
  "POSTGRES_PASSWORD",
  "BETTER_AUTH_SECRET",
  "AIPMS_TOKEN_ENCRYPTION_SECRET",
  "AIPMS_AGENT_SIGNING_SECRET",
  "AIPMS_SERVICE_TOKEN",
  "OPERATIONS_MONITORING_TOKEN",
]

export function newDemoConfig() {
  const config = { ...fixed, AIPMS_DEMO_ID: randomUUID() }
  for (const name of secretNames) config[name] = secret()
  config.DATABASE_URL = `postgresql://demo:${config.POSTGRES_PASSWORD}@127.0.0.1:55433/aipms_demo`
  return config
}

export function validateDemoConfig(config) {
  const allowed = new Set([
    ...Object.keys(fixed),
    ...secretNames,
    "AIPMS_DEMO_ID",
    "DATABASE_URL",
  ])
  if (Object.keys(config).some((key) => !allowed.has(key))) {
    throw new Error(
      ".env.demo contains unsupported settings; use a separate environment for integrations"
    )
  }
  for (const [key, value] of Object.entries(fixed)) {
    if (config[key] !== value)
      throw new Error(`.env.demo must retain its safe ${key} setting`)
  }
  if (!/^[a-f0-9-]{36}$/.test(config.AIPMS_DEMO_ID ?? ""))
    throw new Error(".env.demo has no valid ownership ID")
  for (const name of secretNames) {
    if (!/^[a-f0-9]{64}$/.test(config[name] ?? ""))
      throw new Error(`.env.demo needs a generated ${name}`)
  }
  const expected = `postgresql://demo:${config.POSTGRES_PASSWORD}@127.0.0.1:55433/aipms_demo`
  if (config.DATABASE_URL !== expected) {
    throw new Error(
      "Refusing to migrate or seed a database outside the isolated local demo"
    )
  }
  return config
}

export function loadDemoConfig(root, create = false) {
  const file = join(root, ".env.demo")
  if (existsSync(file)) {
    if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink())
      throw new Error(".env.demo must be a regular file")
    return validateDemoConfig(parseEnv(readFileSync(file, "utf8")))
  }
  if (!create)
    throw new Error("Run pnpm demo:setup first; .env.demo is missing")
  const config = newDemoConfig()
  const source = [
    "# Generated local demo only. Do not use for deployment or integration tests.",
    ...Object.entries(config).map(([key, value]) => `${key}="${value}"`),
    "",
  ].join("\n")
  writeFileSync(file, source, { flag: "wx", mode: 0o600 })
  return config
}

export function demoEnvironment(root, config, inherited = process.env) {
  // Do not inherit database targets, provider credentials, NODE_OPTIONS, or
  // deployment flags. Explicit root-env selection also prevents dotenv fallback.
  const env = {}
  for (const name of [
    "PATH",
    "Path",
    "SystemRoot",
    "SYSTEMROOT",
    "ComSpec",
    "COMSPEC",
    "PATHEXT",
    "HOME",
    "USERPROFILE",
    "TEMP",
    "TMP",
    "TMPDIR",
    "APPDATA",
    "LOCALAPPDATA",
    "PNPM_HOME",
    "COREPACK_HOME",
    "XDG_CACHE_HOME",
    "TERM",
    "COLORTERM",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
  ]) {
    if (inherited[name] !== undefined) env[name] = inherited[name]
  }
  return {
    ...env,
    ...validateDemoConfig(config),
    AIPMS_ENV_FILE: join(root, ".env.demo"),
  }
}

export async function runCommand(
  command,
  args,
  { cwd, env, capture = false, timeoutMs = capture ? 15_000 : 0 } = {}
) {
  const windowsPnpm = process.platform === "win32" && command === "pnpm"
  // All pnpm arguments are fixed internal commands, never user input/secrets.
  const executable = windowsPnpm ? (process.env.ComSpec ?? "cmd.exe") : command
  const parameters = windowsPnpm
    ? ["/d", "/s", "/c", ["pnpm", ...args].join(" ")]
    : args
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, parameters, {
      cwd,
      env,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    })
    let output = ""
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            child.kill()
            reject(
              new Error(
                `${command} timed out; no reset or cleanup was attempted`
              )
            )
          }, timeoutMs)
        : null
    const clearTimer = () => {
      if (timer) clearTimeout(timer)
    }
    child.once("error", clearTimer)
    child.once("close", clearTimer)
    child.stdout?.on("data", (chunk) => {
      output += chunk
    })
    // Captured dependency diagnostics can contain secrets; don't reprint them.
    child.stderr?.resume()
    child.on("error", () =>
      reject(new Error(`Cannot launch ${command}; check installation and PATH`))
    )
    child.on("close", (code) =>
      code === 0
        ? resolveResult(output.trim())
        : reject(
            new Error(
              `${command} ${args[0] ?? ""} failed; no reset or cleanup was attempted`
            )
          )
    )
  })
}

const composeArgs = [
  "compose",
  "--env-file",
  ".env.demo",
  "-f",
  "docker-compose.demo.yml",
  "-p",
  "aipms-demo",
]

async function requireDocker(run, options) {
  let endpoint
  try {
    await run("docker", ["info", "--format", "{{.ServerVersion}}"], {
      ...options,
      capture: true,
    })
    await run("docker", ["compose", "version", "--short"], {
      ...options,
      capture: true,
    })
    endpoint = JSON.parse(
      await run(
        "docker",
        ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"],
        { ...options, capture: true }
      )
    )
  } catch {
    throw new Error(
      "Docker/Compose is unavailable. Start Docker Desktop's Linux engine (or your Docker daemon), then retry. No database was changed."
    )
  }
  if (
    typeof endpoint !== "string" ||
    !(
      endpoint.startsWith("unix:///") ||
      endpoint.startsWith("npipe:////./pipe/")
    )
  ) {
    throw new Error(
      "Local demo requires a local Unix socket or Windows named-pipe Docker context; refusing remote daemons"
    )
  }
}

async function requireOwnership(run, options, config) {
  for (const [kind, name, labelPath] of [
    ["container", "aipms-demo-postgres", ".Config.Labels"],
    ["volume", "aipms-demo-postgres-data", ".Labels"],
  ]) {
    const names = await run(
      "docker",
      [
        kind,
        "ls",
        ...(kind === "container" ? ["--all"] : []),
        "--filter",
        `name=^/?${name}$`,
        "--format",
        kind === "container" ? "{{.Names}}" : "{{.Name}}",
      ],
      { ...options, capture: true }
    )
    if (!names) continue
    const labels = JSON.parse(
      (await run(
        "docker",
        [kind, "inspect", name, "--format", `{{json ${labelPath}}}`],
        { ...options, capture: true }
      )) || "{}"
    )
    if (labels?.["aipms.demo.owner"] !== config.AIPMS_DEMO_ID) {
      throw new Error(
        `Refusing to adopt existing ${kind} ${name}: its ownership does not match .env.demo`
      )
    }
  }
}

export async function requireFreePort(port) {
  return new Promise((resolveResult, reject) => {
    const server = createServer()
    server.once("error", () =>
      reject(
        new Error(
          `Local port ${port} is occupied. Stop the conflicting service; demo ports are intentionally fixed.`
        )
      )
    )
    server.listen(port, "127.0.0.1", () => server.close(resolveResult))
  })
}

export async function runDemo(
  action,
  {
    root = rootDirectory,
    run = runCommand,
    log = console.log,
    inherited = process.env,
    freePort = requireFreePort,
    fetchUrl = fetch,
  } = {}
) {
  if (!["setup", "api", "web", "status", "stop"].includes(action)) {
    throw new Error(
      "Usage: node scripts/local-demo.mjs setup|api|web|status|stop"
    )
  }
  if (process.versions.node.split(".")[0] !== "24")
    throw new Error("The local demo requires Node.js 24.x")
  // Fail before writing credentials/installing dependencies if Docker is down.
  const base = {
    cwd: root,
    env: demoEnvironment(root, newDemoConfig(), inherited),
  }
  await requireDocker(run, base)
  const config = loadDemoConfig(root, action === "setup")
  const options = { cwd: root, env: demoEnvironment(root, config, inherited) }
  await requireOwnership(run, options, config)

  if (action === "setup") {
    await run("pnpm", ["install", "--frozen-lockfile"], options)
    await run(
      "docker",
      [
        ...composeArgs,
        "up",
        "--detach",
        "--wait",
        "--wait-timeout",
        "90",
        "postgres",
      ],
      options
    )
    for (const script of ["db:generate", "db:deploy", "db:seed"])
      await run("pnpm", [script], options)
    log(
      "Local demo prepared. Existing .env/.env.local files and non-demo databases were not selected."
    )
    log(
      "Next: pnpm demo:api and pnpm demo:web in separate terminals; then pnpm demo:status."
    )
  } else if (action === "api" || action === "web") {
    await freePort(action === "api" ? 3001 : 3000)
    await run(
      "pnpm",
      action === "api"
        ? ["--filter", "api", "start"]
        : [
            "--filter",
            "web",
            "dev",
            "--hostname",
            "127.0.0.1",
            "--port",
            "3000",
          ],
      {
        ...options,
        env: { ...options.env, PORT: action === "api" ? "3001" : "3000" },
      }
    )
  } else if (action === "stop") {
    await run("docker", [...composeArgs, "stop", "postgres"], options)
    log(
      "Demo PostgreSQL stopped; its data volume was preserved. Stop API/web terminals separately."
    )
  } else {
    try {
      const api = await fetchUrl("http://localhost:3001/health/ready", {
        signal: AbortSignal.timeout(5000),
      })
      if (!api.ok || (await api.json()).status !== "ready")
        throw new Error("not ready")
      const web = await fetchUrl("http://localhost:3000", {
        signal: AbortSignal.timeout(5000),
      })
      if (!web.ok) throw new Error("web unavailable")
    } catch {
      throw new Error(
        "Demo is not ready. Start pnpm demo:api and pnpm demo:web; check both terminal logs."
      )
    }
    log("API ready: http://localhost:3001/health/ready")
    log("Web reachable: http://localhost:3000 — follow docs/local-demo.md")
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  runDemo(process.argv[2]).catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
