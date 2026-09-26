"use client"

import { authClient } from "@workspace/auth/client"
import { DemoSwitcher } from "@/components/demo-switcher"
import { BirReports } from "@/components/finance/bir-reports"
import { ErpSync } from "@/components/finance/erp-sync"
import { InvoiceList } from "@/components/finance/invoice-list"
import { InvoiceRegister } from "@/components/finance/invoice-register"
import { PaymentRuns } from "@/components/finance/payment-runs"
import { PageHeader } from "@/components/page-header"
import { SignInCard } from "@/components/sign-in"

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
  return <FinanceBody />
}
