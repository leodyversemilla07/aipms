"use client"

import { authClient } from "@workspace/auth/client"
import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"
import { useState } from "react"

/**
 * Email/password sign-in card with a sign-up toggle. Proxies to the API at
 * /api/auth/* (better-auth) via Next rewrites; the session cookie is HttpOnly.
 */
export function SignInCard() {
  const [mode, setMode] = useState<"signin" | "signup">("signin")
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    if (mode === "signup") {
      const res = await authClient.signUp.email({
        name,
        email,
        password,
        callbackURL: "/",
      })
      if (res.error) setError(res.error.message ?? "Sign up failed")
    } else {
      const res = await authClient.signIn.email({ email, password })
      if (res.error) setError(res.error.message ?? "Sign in failed")
    }
    setBusy(false)
  }

  return (
    <div className="mx-auto flex w-full max-w-sm flex-col gap-6">
      <div>
        <h1 className="font-semibold text-xl tracking-tight">aipms</h1>
        <p className="text-muted-foreground text-sm">
          AI procurement for the enterprise — sign in to the supervisory desk.
        </p>
      </div>

      <form
        onSubmit={submit}
        className="flex flex-col gap-3 rounded-xl border bg-card p-5 shadow-sm"
      >
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required={mode === "signup"}
            placeholder="Finance Officer"
            className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            placeholder="you@company.ph"
            className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        </label>

        {error ? (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-destructive text-xs">
            {error}
          </p>
        ) : null}

        <Button type="submit" disabled={busy} className="mt-1">
          {busy ? "…" : mode === "signin" ? "Sign in" : "Create account"}
        </Button>

        <button
          type="button"
          onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
          className={cn("text-muted-foreground text-xs underline")}
        >
          {mode === "signin"
            ? "No account? Create one"
            : "Have an account? Sign in"}
        </button>
      </form>
    </div>
  )
}
