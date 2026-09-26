"use client"

import { authClient } from "@workspace/auth/client"
import { MessagingQueue } from "@/components/messaging-queue"
import { PageHeader } from "@/components/page-header"
import { IssuePo } from "@/components/procurement/issue-po"
import { PoList } from "@/components/procurement/po-list"
import { Receipts } from "@/components/procurement/receipts"
import { SignInCard } from "@/components/sign-in"

function ProcurementBody() {
  return (
    <div className="flex w-full flex-col gap-8">
      <PageHeader
        title="Procurement desk"
        description="Sourcing, orders, receipts & vendor messaging"
      />
      <IssuePo />
      <PoList />
      <Receipts />
      <MessagingQueue />
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
