"use client"

import { DemoSwitcher } from "@/components/demo-switcher"
import { BirReports } from "@/components/finance/bir-reports"
import { ErpSync } from "@/components/finance/erp-sync"
import { InvoiceList } from "@/components/finance/invoice-list"
import { InvoiceRegister } from "@/components/finance/invoice-register"
import { PaymentRuns } from "@/components/finance/payment-runs"
import { PageHeader } from "@/components/page-header"
import { SessionPending, SignInCard } from "@/components/sign-in"
import { useSessionGate } from "@/lib/use-session-gate"

function FinanceBody() {
  return (
    <div className="flex w-full flex-col gap-8">
      <PageHeader
        title="Finance desk"
        description="Invoices, payment runs & reconciliation"
        action={<DemoSwitcher />}
      />

      <InvoiceRegister />
      <InvoiceList />
      <PaymentRuns />
      <ErpSync />
      <BirReports />
    </div>
  )
}

export function FinanceDesk() {
  const { session, isChecking } = useSessionGate()

  if (isChecking) {
    return <SessionPending />
  }
  if (!session) {
    return <SignInCard />
  }
  return <FinanceBody />
}
