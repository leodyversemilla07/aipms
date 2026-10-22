"use client"

import { authClient } from "@workspace/auth/client"
import { ExceptionQueue } from "@/components/exception-queue"
import { PageHeader } from "@/components/page-header"
import { SessionPending, SignInCard } from "@/components/sign-in"

/**
 * Approvals: the decisions a person still owes the process (§16.4 - the maker
 * and the checker must differ). Its own page so the queue is a destination,
 * not a scroll target inside the dashboard.
 */
function ApprovalsBody() {
  return (
    <div className="flex w-full flex-col gap-8">
      <PageHeader
        title="Approvals"
        description="Requisitions and invoices waiting for a human decision"
      />
      <ExceptionQueue heading={null} />
    </div>
  )
}

export function ApprovalsDesk() {
  const { data: session, isPending } = authClient.useSession()

  if (isPending) {
    return <SessionPending />
  }
  if (!session) {
    return <SignInCard />
  }
  return <ApprovalsBody />
}
