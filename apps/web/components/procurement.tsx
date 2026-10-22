"use client"

import { MessagingQueue } from "@/components/messaging-queue"
import { PageHeader } from "@/components/page-header"
import { IssuePo } from "@/components/procurement/issue-po"
import { PoList } from "@/components/procurement/po-list"
import { Receipts } from "@/components/procurement/receipts"
import { Sourcing } from "@/components/procurement/sourcing"
import { SessionPending, SignInCard } from "@/components/sign-in"
import { useSessionGate } from "@/lib/use-session-gate"

function ProcurementBody() {
  return (
    <div className="flex w-full flex-col gap-8">
      <PageHeader
        title="Procurement desk"
        description="Sourcing, orders, receipts & vendor messaging"
      />
      <Sourcing />
      <IssuePo />
      <PoList />
      <Receipts />
      <MessagingQueue />
    </div>
  )
}

export function ProcurementDesk() {
  const { session, isChecking } = useSessionGate()

  if (isChecking) {
    return <SessionPending />
  }
  if (!session) {
    return <SignInCard />
  }
  return <ProcurementBody />
}
