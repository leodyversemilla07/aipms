"use client"

import { authClient } from "@workspace/auth/client"
import { Button } from "@workspace/ui/components/button"
import { useRouter } from "next/navigation"
import { useState } from "react"

/**
 * Sign-in for provisioned accounts. Proxies to the API at
 * /api/auth/* (better-auth) via Next rewrites; the session cookie is HttpOnly.
 */
export function SignInCard() {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const router = useRouter()

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await authClient.signIn.email({ email, password })
      if (res.error) setError(res.error.message ?? "Sign in failed")
      else router.refresh()
    } catch {
      setError("Unable to sign in. Please try again.")
    } finally {
      setBusy(false)
    }
  }

  /** §16.2 — enterprise SSO: route the email's domain to the org IdP. */
  async function signInWithSso(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const res = await authClient.signIn.sso({
      email,
      callbackURL: "/",
      errorCallbackURL: "/?sso=failed",
    })
    if (res.error) setError(res.error.message ?? "SSO sign-in failed")
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
          <span className="text-muted-foreground">Email</span>
          <input
            type="email"
            name="email"
            autoComplete="email"
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
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        </label>

        {error ? (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-destructive text-xs">
            {error}
          </p>
        ) : null}

        <Button type="submit" disabled={busy} className="mt-1">
          {busy ? "…" : "Sign in"}
        </Button>

        <p className="text-muted-foreground text-xs">
          Need access? Contact your organization’s administrator.
        </p>
      </form>

      <form onSubmit={signInWithSso} className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <span className="h-px flex-1 bg-border" />
          <span className="text-muted-foreground text-xs">or</span>
          <span className="h-px flex-1 bg-border" />
        </div>
        <Button
          type="submit"
          variant="outline"
          disabled={busy || !email}
          title={
            email
              ? "Continue with your organization's identity provider"
              : "Enter your work email first"
          }
        >
          Sign in with SSO
        </Button>
      </form>
    </div>
  )
}
