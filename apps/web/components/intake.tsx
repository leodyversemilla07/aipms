"use client"

import { authClient } from "@workspace/auth/client"
import { IntakeQueue } from "@/components/intake/queue"
import { PageHeader } from "@/components/page-header"
import { SessionPending, SignInCard } from "@/components/sign-in"

function IntakeBody() {
  return (
    <div className="flex w-full flex-col gap-8">
      <PageHeader
        title="Intake desk"
        description="Incoming documents and classification"
      />
      <IntakeQueue />
    </div>
  )
}

export function IntakeDesk() {
  const { data: session, isPending } = authClient.useSession()

  if (isPending) {
    return <SessionPending />
  }
  if (!session) {
    return <SignInCard />
  }
  return <IntakeBody />
}
