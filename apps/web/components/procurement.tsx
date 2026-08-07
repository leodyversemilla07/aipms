"use client"

import { authClient } from "@workspace/auth/client"
import Link from "next/link"
import { IssuePo } from "@/components/procurement/issue-po"
import { PoList } from "@/components/procurement/po-list"
import { SignInCard } from "@/components/sign-in"

function ProcurementBody() {
  const { data: session } = authClient.useSession()
  const user = session?.user

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="font-semibold text-lg tracking-tight">
            Procurement desk
          </h1>
          <p className="text-muted-foreground text-sm">
            {user?.email} · sourcing & purchase orders
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
            href="/finance"
            className="text-muted-foreground underline hover:text-foreground"
          >
            Finance desk
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

      <IssuePo />
      <PoList />
    </div>
  )
}

export function ProcurementDesk() {
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
  return <ProcurementBody />
}
