"use client"

import { AuditViewer } from "@/components/audit/viewer"
import { PageHeader } from "@/components/page-header"
import { SessionPending, SignInCard } from "@/components/sign-in"
import { useSessionGate } from "@/lib/use-session-gate"

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
  const { session, isChecking } = useSessionGate()

  if (isChecking) {
    return <SessionPending />
  }
  if (!session) {
    return <SignInCard />
  }
  return <AuditBody />
}
