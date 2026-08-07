"use client"

import { authClient } from "@workspace/auth/client"
import Link from "next/link"
import { AuditViewer } from "@/components/audit/viewer"
import { SignInCard } from "@/components/sign-in"

function AuditBody() {
  const { data: session } = authClient.useSession()
  const user = session?.user

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="font-semibold text-lg tracking-tight">Audit trail</h1>
          <p className="text-muted-foreground text-sm">
            {user?.email} · §16 append-only review
          </p>
        </div>
        <nav className="flex items-center gap-4 text-sm">
          <Link
            href="/"
            className="text-muted-foreground underline hover:text-foreground"
          >
            Supervisory desk
          </Link>
          <Link
            href="/procurement"
            className="text-muted-foreground underline hover:text-foreground"
          >
            Procurement
          </Link>
          <Link
            href="/finance"
            className="text-muted-foreground underline hover:text-foreground"
          >
            Finance
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

      <AuditViewer />
    </div>
  )
}

export function AuditDesk() {
  const { data: session, isPending } = authClient.useSession()

  if (isPending) {
    return (
      <p className="py-24 text-center text-muted-foreground text-sm">
        Checking session…
      </p>
    )
  }
  if (!session) {
    return (
      <main className="flex min-h-svh items-center justify-center p-4">
        <SignInCard />
      </main>
    )
  }
  return <AuditBody />
}
