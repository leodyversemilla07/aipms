"use client"

import { authClient } from "@workspace/auth/client"
import { AgentRuns } from "@/components/agent-runs"
import { PageHeader } from "@/components/page-header"
import { SignInCard } from "@/components/sign-in"

/**
 * Agent runs: what the unattended workers did and how they ended. Its own
 * page so the queue is a destination, not a scroll target inside the
 * dashboard.
 */
function AgentRunsBody() {
  return (
    <div className="flex w-full flex-col gap-8">
      <PageHeader
        title="Agent runs"
        description="Unattended runs and their outcomes"
      />
      <AgentRuns heading={null} />
    </div>
  )
}

export function AgentRunsDesk() {
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
  return <AgentRunsBody />
}
