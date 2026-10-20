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
import { AnalyticsPanel } from "@/components/analytics-panel"
import { PageSection } from "@/components/page-section"
import { SectionTitle } from "@/components/section-title"
import { useTRPC } from "@/lib/trpc/client"
import { CreateRequisition } from "./create-requisition"
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
    ...trpc.approval.pendingList.queryOptions({ q: "", page: 1, pageSize: 8 }),
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
        <PageSection
          titleId="attention-title"
          title="Needs attention"
          description="Human decisions and operational exceptions"
          action={
            pending.data && pending.data.total > 0 ? (
              <Badge variant="destructive">
                {pending.data.total} awaiting review
              </Badge>
            ) : null
          }
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <OverviewCard
              title="Pending approvals"
              count={pending.data?.total}
              description="Decisions awaiting a human"
              href="/approvals"
              linkLabel="Review queue"
            />
            <OverviewCard
              title="Invoice exceptions"
              count={exceptionInvoices}
              description="Among the 25 most recent invoices"
              href="/exceptions"
              linkLabel="Open exceptions"
            />
            <OverviewCard
              title="Agent runs"
              count={failedRecentRuns}
              description="Among the 8 most recent runs"
              href="/agent-runs"
              linkLabel="Inspect runs"
            />
          </div>
          {pending.isError || invoices.isError || runs.isError ? (
            <p role="alert" className="text-destructive text-sm">
              Some attention counts could not load. Check the sections below or
              refresh.
            </p>
          ) : null}
        </PageSection>
      )}

      <PageSection
        titleId="flow-title"
        title="Procurement flow"
        description="Records across the lifecycle · all time"
      >
        <div className="grid gap-3 sm:grid-cols-3">
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
      </PageSection>

      <CreateRequisition
        heading={
          <SectionTitle
            title="New requisition"
            description="Cut a requisition from a budget; the policy engine gates it and routes exceptions to the approval queue."
          />
        }
      />

      {isSupervisor && (
        <AnalyticsPanel
          heading={
            <SectionTitle
              title="Financial control & operations"
              description="Budget, gates, latency and retention hygiene"
            />
          }
        />
      )}
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
