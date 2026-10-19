"use client"

import { authClient } from "@workspace/auth/client"
import { InvoiceList } from "@/components/finance/invoice-list"
import { PageHeader } from "@/components/page-header"
import { SignInCard } from "@/components/sign-in"

/**
 * Invoice exceptions: invoices the engine could not match, so a person has
 * to resolve them (§8.4). Its own page so the queue is a destination, not a
 * scroll target inside the dashboard.
 */
function ExceptionsBody() {
  return (
    <div className="flex w-full flex-col gap-8">
      <PageHeader
        title="Invoice exceptions"
        description="Invoices the policy engine could not match"
      />
      <InvoiceList status="exception" heading={null} />
    </div>
  )
}

export function ExceptionsDesk() {
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
  return <ExceptionsBody />
}
