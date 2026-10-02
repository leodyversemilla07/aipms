#!/usr/bin/env node
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { requireFreePort, runDemo } from "./local-demo.mjs"

// Real Docker/Prisma/API/web smoke. Never targets DATABASE_URL from the caller.
const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const children = []
try {
  await requireFreePort(3000)
  await requireFreePort(3001)
  await runDemo("setup")
  for (const action of ["api", "web"]) {
    const child = spawn(process.execPath, ["scripts/local-demo.mjs", action], {
      cwd: root,
      stdio: "inherit",
      detached: process.platform !== "win32",
    })
    children.push(child)
  }
  const deadline = Date.now() + 150_000
  let ready = false
  while (Date.now() < deadline) {
    if (children.some((child) => child.exitCode !== null))
      throw new Error("A demo application exited before readiness")
    try {
      await runDemo("status", { log: () => {} })
      ready = true
      break
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }
  assert.ok(ready, "Demo readiness timed out")
  for (const [email, password, role] of [
    ["maker@demo.aipms", "demo-maker-123", "finance"],
    ["checker@demo.aipms", "demo-checker-123", "admin"],
  ]) {
    const signIn = await fetch("http://localhost:3000/api/auth/sign-in/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:3000",
      },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(10_000),
    })
    assert.equal(
      signIn.ok,
      true,
      `Demo login must work through the same-origin web proxy (HTTP ${signIn.status})`
    )
    const cookies = signIn.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ")
    assert.ok(cookies, "Demo login must issue a session cookie")
    const me = await fetch("http://localhost:3000/api/trpc/users.me", {
      headers: { cookie: cookies },
      signal: AbortSignal.timeout(10_000),
    })
    assert.equal(me.ok, true)
    const user = (await me.json()).result?.data
    assert.equal(user?.email, email)
    assert.equal(user?.role, role)
  }
  console.log(
    "Local demo stack smoke passed: isolated migrations/seed, API/web readiness, maker/checker sign-in."
  )
} finally {
  for (const child of children) {
    if (!child.pid) continue
    if (process.platform === "win32") {
      await new Promise((resolve) => {
        const kill = spawn(
          "taskkill",
          ["/pid", String(child.pid), "/t", "/f"],
          { stdio: "ignore" }
        )
        kill.on("error", resolve)
        kill.on("close", resolve)
      })
    } else {
      try {
        process.kill(-child.pid, "SIGTERM")
      } catch {}
    }
  }
  // No down --volumes, database reset, or .env overwrite, even on failure.
  await runDemo("stop").catch(() => {})
}
