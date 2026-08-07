"use client"

import { authClient } from "@workspace/auth/client"

/**
 * §16.4 helper — alternate between the two demo identities (Maker / Checker)
 * so the "approver must differ from maker" gate is demoable from one browser.
 * Compiled out of production builds (NODE_ENV=production): the demo users are
 * only seeded by the API when AUTH_SEED_DEMO=1.
 */
const DEMO = [
  { label: "Maker", email: "maker@demo.aipms", password: "demo-maker-123" },
  {
    label: "Checker",
    email: "checker@demo.aipms",
    password: "demo-checker-123",
  },
] as const

export function DemoSwitcher() {
  if (process.env.NODE_ENV === "production") return null
  const { data: session } = authClient.useSession()

  async function switchTo(email: string, password: string) {
    const res = await authClient.signIn.email({ email, password })
    if (res?.error) return
    window.location.reload()
  }

  return (
    <span className="flex items-center gap-2 text-muted-foreground text-xs">
      <span>demo:</span>
      {DEMO.map((d) => (
        <button
          key={d.email}
          type="button"
          disabled={session?.user?.email === d.email}
          onClick={() => void switchTo(d.email, d.password)}
          className="underline underline-offset-2 enabled:hover:text-foreground disabled:opacity-50"
        >
          {d.label}
        </button>
      ))}
    </span>
  )
}
