"use client"

import { authClient } from "@workspace/auth/client"
import Link from "next/link"
import { BudgetsPanel } from "@/components/master-data/budgets"
import { CatalogPanel } from "@/components/master-data/catalog"
import { PoliciesPanel } from "@/components/master-data/policies"
import { VendorsPanel } from "@/components/master-data/vendors"
import { SignInCard } from "@/components/sign-in"

function MasterDataBody() {
  const { data: session } = authClient.useSession()
  const user = session?.user

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="font-semibold text-lg tracking-tight">Master data</h1>
          <p className="text-muted-foreground text-sm">
            {user?.email} · vendors, catalog, budgets, policies
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
            href="/intake"
            className="text-muted-foreground underline hover:text-foreground"
          >
            Intake
          </Link>
          <Link
            href="/audit"
            className="text-muted-foreground underline hover:text-foreground"
          >
            Audit
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

      <VendorsPanel />
      <CatalogPanel />
      <BudgetsPanel />
      <PoliciesPanel />
    </div>
  )
}

export function MasterDataDesk() {
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
  return <MasterDataBody />
}
