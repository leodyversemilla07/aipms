"use client"

import { useQuery } from "@tanstack/react-query"
import { authClient } from "@workspace/auth/client"
import Link from "next/link"
import { AgentRuns } from "@/components/agent-runs"
import { AnalyticsPanel } from "@/components/analytics-panel"
import { useTRPC } from "@/lib/trpc/client"
import { CreateRequisition } from "./create-requisition"
import { ExceptionQueue } from "./exception-queue"
import { SignInCard } from "./sign-in"

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border bg-card p-4 shadow-sm">
      <span className="text-muted-foreground text-xs uppercase tracking-wide">
        {label}
      </span>
      <span className="font-semibold text-2xl tabular-nums">{value}</span>
    </div>
  )
}

function Dashboard() {
  const trpc = useTRPC()
  const { data: session } = authClient.useSession()
  const user = session?.user

  const pending = useQuery(trpc.approval.pendingList.queryOptions())
  const requisitions = useQuery(
    trpc.requisition.list.queryOptions({ q: "", page: 1, pageSize: 1 })
  )
  const orders = useQuery(
    trpc.purchaseOrder.list.queryOptions({ q: "", page: 1, pageSize: 1 })
  )
  const invoices = useQuery(
    trpc.invoice.list.queryOptions({ q: "", page: 1, pageSize: 1 })
  )
  const runs = useQuery(
    trpc.paymentRun.list.queryOptions({ q: "", page: 1, pageSize: 1 })
  )

  const size = (d: unknown): number => {
    if (Array.isArray(d)) return d.length
    if (
      d &&
      typeof d === "object" &&
      "rows" in d &&
      Array.isArray((d as { rows: unknown[] }).rows)
    ) {
      return (d as { rows: unknown[] }).rows.length
    }
    return 0
  }
  const count = (q: { isPending: boolean; data?: unknown }) =>
    q.isPending ? "…" : size(q.data)

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="font-semibold text-lg tracking-tight">
            Supervisory desk
          </h1>
          <p className="text-muted-foreground text-sm">
            {user?.email} · signed in
          </p>
        </div>
        <nav className="flex items-center gap-4 text-sm">
          <Link
            href="/procurement"
            className="text-muted-foreground underline hover:text-foreground"
          >
            Procurement
          </Link>
          <Link
            href="/finance"
            className="text-muted-foreground underline hover:text-foreground"
          >
            Finance
          </Link>
          <Link
            href="/audit"
            className="text-muted-foreground underline hover:text-foreground"
          >
            Audit
          </Link>
          <Link
            href="/intake"
            className="text-muted-foreground underline hover:text-foreground"
          >
            Intake
          </Link>
          <Link
            href="/master-data"
            className="text-muted-foreground underline hover:text-foreground"
          >
            Master data
          </Link>
          <button
            type="button"
            onClick={() => authClient.signOut()}
            className="text-muted-foreground underline hover:text-foreground"
          >
            Sign out
          </button>
        </nav>
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <StatCard label="Approvals" value={count(pending)} />
        <StatCard label="Requisitions" value={count(requisitions)} />
        <StatCard label="POs" value={count(orders)} />
        <StatCard label="Invoices" value={count(invoices)} />
        <StatCard label="Pay runs" value={count(runs)} />
      </div>

      <AgentRuns />
      <AnalyticsPanel />
      <ExceptionQueue />
      <CreateRequisition />
    </div>
  )
}

export function Cockpit() {
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
  return <Dashboard />
}
