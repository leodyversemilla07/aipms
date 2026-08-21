"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { authClient } from "@workspace/auth/client"
import { Button } from "@workspace/ui/components/button"
import Link from "next/link"
import { useState } from "react"
import { SignInCard } from "@/components/sign-in"
import { useTRPC } from "@/lib/trpc/client"

type ProviderRow = {
  providerId: string
  issuer: string
  domain: string
  type: string
  createdBy: string
}

type ScimRow = {
  providerId: string
  maskedToken: string
}

/**
 * §16.2 — the instance's identity configuration. Admins register the org's
 * IdP (OIDC/SAML) for sign-in and mint SCIM tokens so the IdP can provision
 * users. Server-side this is human-admin-only; every change is audited.
 */
export function SsoAdmin() {
  const { data: session } = authClient.useSession()
  const user = session?.user as { role?: string } | undefined

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="font-semibold text-lg tracking-tight">
            Identity &amp; SSO
          </h1>
          <p className="text-muted-foreground text-sm">
            Single sign-on for this instance — OIDC/SAML sign-in and SCIM
            provisioning
          </p>
        </div>
        <nav className="flex items-center gap-4 text-sm">
          <Link
            href="/"
            className="text-muted-foreground underline hover:text-foreground"
          >
            Supervisory desk
          </Link>
          <button
            type="button"
            onClick={() => authClient.signOut()}
            className="text-muted-foreground underline hover:text-foreground"
          >
            Sign out
          </button>
        </nav>
      </header>

      {user ? (
        user.role === "admin" ? (
          <SsoAdminBody />
        ) : (
          <p className="rounded-md border bg-card px-4 py-3 text-muted-foreground text-sm">
            SSO configuration requires an admin account.
          </p>
        )
      ) : (
        <SignInCard />
      )}
    </div>
  )
}

function SsoAdminBody() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()

  const providers = useQuery(trpc.sso.listProviders.queryOptions())
  const scim = useQuery(trpc.sso.listScimConnections.queryOptions())

  const [providerId, setProviderId] = useState("")
  const [issuer, setIssuer] = useState("")
  const [domain, setDomain] = useState("")
  const [clientId, setClientId] = useState("")
  const [clientSecret, setClientSecret] = useState("")
  const [discoveryEndpoint, setDiscoveryEndpoint] = useState("")
  const [scimProviderId, setScimProviderId] = useState("")
  const [mintedToken, setMintedToken] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const invalidate = () => {
    queryClient.invalidateQueries({
      queryKey: trpc.sso.listProviders.queryKey(),
    })
    queryClient.invalidateQueries({
      queryKey: trpc.sso.listScimConnections.queryKey(),
    })
  }

  const register = useMutation(
    trpc.sso.registerProvider.mutationOptions({
      onSuccess: (created) => {
        setNotice(`Registered ${created.providerId} (${created.type})`)
        setError(null)
        setProviderId("")
        setIssuer("")
        setDomain("")
        setClientId("")
        setClientSecret("")
        setDiscoveryEndpoint("")
        invalidate()
      },
      onError: (e) => setError(e.message),
    })
  )

  const remove = useMutation(
    trpc.sso.deleteProvider.mutationOptions({
      onSuccess: () => {
        setNotice("Provider removed")
        setError(null)
        invalidate()
      },
      onError: (e) => setError(e.message),
    })
  )

  const mint = useMutation(
    trpc.sso.generateScimToken.mutationOptions({
      onSuccess: (result) => {
        setMintedToken(result.scimToken)
        setScimProviderId("")
        setError(null)
        invalidate()
      },
      onError: (e) => setError(e.message),
    })
  )

  const rows = (providers.data ?? []) as unknown as ProviderRow[]
  const scimRows = (scim.data ?? []) as unknown as ScimRow[]

  return (
    <div className="flex flex-col gap-6">
      {notice ? (
        <p className="rounded-md bg-primary/10 px-3 py-2 text-primary text-xs">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-destructive text-xs">
          {error}
        </p>
      ) : null}

      <section className="flex flex-col gap-3 rounded-xl border bg-card p-5 shadow-sm">
        <h2 className="font-medium text-sm">Sign-in providers</h2>
        {rows.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No IdP configured — users sign in with email and password.
          </p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="text-muted-foreground text-xs uppercase">
              <tr>
                <th className="py-1 pr-3">Provider</th>
                <th className="py-1 pr-3">Type</th>
                <th className="py-1 pr-3">Issuer</th>
                <th className="py-1 pr-3">Domain</th>
                <th className="py-1" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.providerId} className="border-t">
                  <td className="py-1.5 pr-3 font-mono">{row.providerId}</td>
                  <td className="py-1.5 pr-3 uppercase">{row.type}</td>
                  <td className="max-w-52 truncate py-1.5 pr-3">
                    {row.issuer}
                  </td>
                  <td className="py-1.5 pr-3">{row.domain}</td>
                  <td className="py-1.5 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={remove.isPending}
                      onClick={() =>
                        remove.mutate({ providerId: row.providerId })
                      }
                    >
                      Remove
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <form
          className="mt-2 grid grid-cols-2 gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            register.mutate({
              providerId,
              issuer,
              domain,
              oidcConfig: clientId
                ? {
                    clientId,
                    clientSecret,
                    ...(discoveryEndpoint ? { discoveryEndpoint } : {}),
                  }
                : undefined,
            })
          }}
        >
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">Provider ID</span>
            <input
              value={providerId}
              onChange={(e) => setProviderId(e.target.value)}
              required
              placeholder="company-okta"
              className="h-9 rounded-md border bg-background px-3 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">Email domain</span>
            <input
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              required
              placeholder="company.ph"
              className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </label>
          <label className="col-span-2 flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">Issuer URL</span>
            <input
              value={issuer}
              onChange={(e) => setIssuer(e.target.value)}
              required
              placeholder="https://idp.company.ph"
              className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">OIDC client ID</span>
            <input
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">OIDC client secret</span>
            <input
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </label>
          <label className="col-span-2 flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">
              Discovery endpoint (optional — defaults to issuer +
              /.well-known/…)
            </span>
            <input
              value={discoveryEndpoint}
              onChange={(e) => setDiscoveryEndpoint(e.target.value)}
              placeholder="https://idp.company.ph/.well-known/openid-configuration"
              className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </label>
          <div className="col-span-2">
            <Button type="submit" disabled={register.isPending}>
              {register.isPending ? "…" : "Register provider"}
            </Button>
          </div>
        </form>
      </section>

      <section className="flex flex-col gap-3 rounded-xl border bg-card p-5 shadow-sm">
        <h2 className="font-medium text-sm">SCIM provisioning</h2>
        <p className="text-muted-foreground text-xs">
          Point your IdP at <code>/api/auth/scim/v2</code> with a bearer token.
          The token is shown once.
        </p>
        {mintedToken ? (
          <p className="break-all rounded-md bg-primary/10 px-3 py-2 font-mono text-primary text-xs">
            {mintedToken}
          </p>
        ) : null}
        {scimRows.length > 0 ? (
          <ul className="text-sm">
            {scimRows.map((row) => (
              <li key={row.providerId} className="border-t py-1.5 font-mono">
                {row.providerId}
                <span className="text-muted-foreground">
                  {" "}
                  · {row.maskedToken}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        <form
          className="flex items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            mint.mutate({ providerId: scimProviderId })
          }}
        >
          <label className="flex flex-1 flex-col gap-1 text-sm">
            <span className="text-muted-foreground">Connection ID</span>
            <input
              value={scimProviderId}
              onChange={(e) => setScimProviderId(e.target.value)}
              required
              placeholder="company-okta-scim"
              className="h-9 rounded-md border bg-background px-3 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </label>
          <Button type="submit" variant="outline" disabled={mint.isPending}>
            {mint.isPending ? "…" : "Generate token"}
          </Button>
        </form>
      </section>
    </div>
  )
}
