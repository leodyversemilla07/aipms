"use client"

import { useQuery } from "@tanstack/react-query"
import { authClient } from "@workspace/auth/client"
import { Badge } from "@workspace/ui/components/badge"
import { buttonVariants } from "@workspace/ui/components/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import { Skeleton } from "@workspace/ui/components/skeleton"
import Link from "next/link"
import { useEffect, useState } from "react"
import { AgentRuns } from "@/components/agent-runs"
import { AnalyticsPanel } from "@/components/analytics-panel"
import { useTRPC } from "@/lib/trpc/client"
import { CreateRequisition } from "./create-requisition"
import { ExceptionQueue } from "./exception-queue"
import { PageHeader } from "./page-header"
import { SignInCard } from "./sign-in"

function OverviewCard({
  title,
  count,
  description,
  href,
  linkLabel,
}: {
  title: string
  count: number | undefined
  description: string
  href: string
  linkLabel: string
}) {
  return (
    <Card size="sm" className="min-w-0">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {count === undefined ? (
          <Skeleton className="h-9 w-16" />
        ) : (
          <p className="font-semibold text-3xl tabular-nums">{count}</p>
        )}
      </CardContent>
      <CardFooter>
        <Link
          href={href}
          className={buttonVariants({ variant: "link", size: "sm" })}
        >
          {linkLabel} →
        </Link>
      </CardFooter>
    </Card>
  )
}

function Dashboard() {
  const trpc = useTRPC()
  const me = useQuery(trpc.users.me.queryOptions())
  const role = me.data?.role
  const isSupervisor =
    role === "procurement" || role === "finance" || role === "admin"
  const isFinance = role === "finance" || role === "admin"
  const pending = useQuery({
    ...trpc.approval.pendingList.queryOptions(),
    enabled: isSupervisor,
  })
  const requisitions = useQuery(
    trpc.requisition.list.queryOptions({ q: "", page: 1, pageSize: 1 })
  )
  const orders = useQuery({
    ...trpc.purchaseOrder.list.queryOptions({ q: "", page: 1, pageSize: 1 }),
    enabled: isSupervisor,
  })
  const invoices = useQuery({
    ...trpc.invoice.list.queryOptions({ q: "", page: 1, pageSize: 25 }),
    enabled: isFinance,
  })
  const runs = useQuery({
    ...trpc.agent.runs.queryOptions({ q: "", page: 1, pageSize: 8 }),
    enabled: isSupervisor,
  })
  const invoiceRows = invoices.data as { status: string }[] | undefined
  const exceptionInvoices = invoiceRows?.filter(
    (invoice) => invoice.status === "exception"
  ).length
  const recentRuns = runs.data?.rows as { status: string }[] | undefined
  const failedRecentRuns = recentRuns?.filter(
    (run) => run.status === "failed"
  ).length

  return (
    <div className="flex w-full flex-col gap-8">
      <PageHeader
        title="Supervisory desk"
        description="Human decisions and agent operations"
      />

      {isSupervisor && (
        <section
          aria-labelledby="attention-title"
          className="flex flex-col gap-4"
        >
          <div className="flex flex-wrap items-center gap-3">
            <h2
              id="attention-title"
              className="font-heading font-semibold text-xl"
            >
              Needs attention
            </h2>
            {pending.data && pending.data.length > 0 ? (
              <Badge variant="destructive">
                {pending.data.length} awaiting review
              </Badge>
            ) : null}
            <span className="text-muted-foreground text-sm">
              Human decisions and operational exceptions
            </span>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <OverviewCard
              title="Pending approvals"
              count={pending.data?.length}
              description="Decisions awaiting a human"
              href="#exception-queue"
              linkLabel="Review queue"
            />
            <OverviewCard
              title="Invoice exceptions"
              count={exceptionInvoices}
              description="Among the 25 most recent invoices"
              href="/finance"
              linkLabel="Open finance"
            />
            <OverviewCard
              title="Failed agent runs"
              count={failedRecentRuns}
              description="Among the 8 most recent runs"
              href="#agent-activity"
              linkLabel="Inspect runs"
            />
          </div>
          {pending.isError || invoices.isError || runs.isError ? (
            <p role="alert" className="text-destructive text-sm">
              Some attention counts could not load. Check the sections below or
              refresh.
            </p>
          ) : null}
          <div id="exception-queue" className="scroll-mt-6">
            <ExceptionQueue />
          </div>
        </section>
      )}

      <div className="grid gap-8 lg:grid-cols-2">
        <section aria-labelledby="flow-title" className="flex flex-col gap-3">
          <div>
            <h2 id="flow-title" className="font-heading font-semibold text-xl">
              Procurement flow
            </h2>
            <p className="text-muted-foreground text-sm">
              Records across the lifecycle · all time
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3">
            <OverviewCard
              title="Requisitions"
              count={requisitions.data?.total}
              description="Purchase requests"
              href="/procurement"
              linkLabel="View requests"
            />
            {isSupervisor && (
              <OverviewCard
                title="Purchase orders"
                count={orders.data?.total}
                description="Orders issued"
                href="/procurement"
                linkLabel="View orders"
              />
            )}
            {isFinance && (
              <OverviewCard
                title="Invoices"
                count={invoiceRows?.length}
                description="Most recent 25 · all statuses"
                href="/finance"
                linkLabel="View invoices"
              />
            )}
          </div>
          {requisitions.isError || orders.isError ? (
            <p role="alert" className="text-destructive text-sm">
              Could not load some procurement counts.
            </p>
          ) : null}
        </section>
        {isSupervisor && (
          <div id="agent-activity" className="scroll-mt-6">
            <AgentRuns />
          </div>
        )}
      </div>

      {isSupervisor && <AnalyticsPanel />}
      <CreateRequisition />
    </div>
  )
}

export function Cockpit() {
  const { data: session, isPending } = authClient.useSession()
  // Background session refetches must not unmount a partially filled sign-in form.
  const [initialCheckDone, setInitialCheckDone] = useState(false)
  useEffect(() => {
    if (!isPending) setInitialCheckDone(true)
  }, [isPending])

  if (!initialCheckDone) {
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
  return <Dashboard />
}
