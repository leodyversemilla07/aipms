"use client"

import { InvoiceList } from "@/components/finance/invoice-list"
import { PageHeader } from "@/components/page-header"
import { SessionPending, SignInCard } from "@/components/sign-in"
import { useSessionGate } from "@/lib/use-session-gate"

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
  const { session, isChecking } = useSessionGate()

  if (isChecking) {
    return <SessionPending />
  }
  if (!session) {
    return <SignInCard />
  }
  return <ExceptionsBody />
}
