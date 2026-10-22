"use client"

import { authClient } from "@workspace/auth/client"
import { AuditViewer } from "@/components/audit/viewer"
import { PageHeader } from "@/components/page-header"
import { SessionPending, SignInCard } from "@/components/sign-in"

function AuditBody() {
  return (
    <div className="flex w-full flex-col gap-8">
      <PageHeader
        title="Audit trail"
        description="Attributable, append-only activity"
      />
      <AuditViewer />
    </div>
  )
}

export function AuditDesk() {
  const { data: session, isPending } = authClient.useSession()

  if (isPending) {
    return <SessionPending />
  }
  if (!session) {
    return <SignInCard />
  }
  return <AuditBody />
}
