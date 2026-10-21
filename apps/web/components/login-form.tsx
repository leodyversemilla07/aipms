"use client"

import { authClient } from "@workspace/auth/client"
import { Button } from "@workspace/ui/components/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import { cn } from "@workspace/ui/lib/utils"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { InlineError } from "@/components/states/error-state"

/**
 * Sign-in for provisioned accounts. Proxies to the API at
 * /api/auth/* (better-auth) via Next rewrites; the session cookie is HttpOnly.
 *
 * The shape follows the shadcn `login-01` block: a card, the email and
 * password fields, the primary action, and a secondary identity-provider
 * action in its place. The block's "forgot your password" link is left out -
 * the platform has no self-service reset, and a link that goes nowhere is
 * worse than its absence.
 */
export function LoginForm({
  className,
  ...props
}: React.ComponentProps<"div">) {
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
  async function signInWithSso() {
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
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <Card>
        <CardHeader>
          <CardTitle>Sign in to AIPMS</CardTitle>
          <CardDescription>
            Enter your work email to reach the supervisory desk.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="email">Email</FieldLabel>
                <Input
                  id="email"
                  type="email"
                  name="email"
                  autoComplete="email"
                  placeholder="you@company.ph"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </Field>
              <Field>
                <div className="flex items-center">
                  <FieldLabel htmlFor="password">Password</FieldLabel>
                </div>
                <Input
                  id="password"
                  type="password"
                  name="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </Field>

              {error ? <InlineError message={error} /> : null}

              <Field>
                <Button type="submit" disabled={busy}>
                  {busy ? "Signing in…" : "Sign in"}
                </Button>
                <Button
                  variant="outline"
                  type="button"
                  disabled={busy || !email}
                  onClick={signInWithSso}
                  title={
                    email
                      ? "Continue with your organization's identity provider"
                      : "Enter your work email first"
                  }
                >
                  Sign in with SSO
                </Button>
                <FieldDescription className="text-center">
                  Need access? Contact your organization&rsquo;s administrator.
                </FieldDescription>
              </Field>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
