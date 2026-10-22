"use client"

import { useQuery } from "@tanstack/react-query"
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"
import { cn } from "@workspace/ui/lib/utils"
import {
  ArrowRightIcon,
  BotIcon,
  ClipboardCheckIcon,
  type LucideIcon,
  PlusIcon,
  TriangleAlertIcon,
  WalletIcon,
} from "lucide-react"
import Link from "next/link"
import type { ReactNode } from "react"
import { AnalyticsPanel } from "@/components/analytics-panel"
import { SectionTitle } from "@/components/section-title"
import { EmptyState } from "@/components/states/empty-state"
import { ErrorState } from "@/components/states/error-state"
import { PendingState } from "@/components/states/pending-state"
import { minorToPhp } from "@/lib/money"
import { fmtTime } from "@/lib/time"
import { useTRPC } from "@/lib/trpc/client"
import { useSessionGate } from "@/lib/use-session-gate"
import { CreateRequisition } from "./create-requisition"
import { PageHeader } from "./page-header"
import { SessionPending, SignInCard } from "./sign-in"

/**
 * The dashboard answers three questions in reading order:
 * what needs a decision now (KPI row), where the flow is heading (trend),
 * and what the individual records are (queue). The detailed analytics sit
 * below as the drill-down, so the first screen stays a glance.
 */

const CHART_MONTHS = 6

const KIND_LABEL: Record<string, string> = {
  threshold: "Threshold exceeded",
  budgetOverride: "Budget override",
  vendorGate: "Vendor gate",
  policyGate: "Policy gate",
  poCancellation: "PO cancellation",
}

type SpendRow = {
  costCenter: string
  period: string
  limitMinor: number
  spentMinor: number
  utilizationPct: number
}

type MonthCount = { month: string; count: number }

type AgentStats = {
  total: number
  succeeded: number
  failed: number
  running: number
}

/** "waiting" in the reader's terms: how long a record has sat in the queue. */
function waitingFor(at: string | Date): string {
  const hours = Math.floor((Date.now() - new Date(at).getTime()) / 3_600_000)
  if (hours < 1) return "under 1h"
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/** The six calendar months ending now, with zero-filled gaps. */
function monthSeries(points: MonthCount[]) {
  const byMonth = new Map(points.map((point) => [point.month, point.count]))
  const now = new Date()
  return Array.from({ length: CHART_MONTHS }, (_, index) => {
    const date = new Date(
      now.getFullYear(),
      now.getMonth() - (CHART_MONTHS - 1 - index),
      1
    )
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`
    return {
      month: key,
      label: date.toLocaleString("en-PH", { month: "short" }),
      count: byMonth.get(key) ?? 0,
    }
  })
}

function kpiValue(
  value: number | undefined,
  isPending: boolean,
  isError: boolean
): ReactNode {
  if (isPending) return <Skeleton className="h-8 w-16" />
  if (isError || value === undefined) return "—"
  return value.toLocaleString("en-PH")
}

function CardLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1 font-medium text-primary text-sm hover:underline"
    >
      {children}
      <ArrowRightIcon aria-hidden="true" className="size-3.5" />
    </Link>
  )
}

function KpiCard({
  label,
  value,
  detail,
  icon: Icon,
  href,
  linkLabel,
}: {
  label: string
  value: ReactNode
  detail: ReactNode
  icon: LucideIcon
  href: string
  linkLabel: string
}) {
  return (
    <Card size="sm" className="min-w-0">
      <CardHeader>
        <div className="flex items-center justify-between gap-2 text-muted-foreground text-sm">
          <span className="font-medium text-foreground">{label}</span>
          <Icon aria-hidden="true" className="size-4" />
        </div>
        <CardTitle className="font-semibold text-3xl tabular-nums leading-none">
          {value}
        </CardTitle>
      </CardHeader>
      <CardContent className="min-h-10">
        <p className="text-muted-foreground text-sm">{detail}</p>
      </CardContent>
      <CardFooter className="mt-auto">
        <CardLink href={href}>{linkLabel}</CardLink>
      </CardFooter>
    </Card>
  )
}

function ExceptionVolumeCard({
  points,
  isPending,
  isError,
  errorMessage,
}: {
  points: MonthCount[]
  isPending: boolean
  isError: boolean
  errorMessage: string
}) {
  const series = monthSeries(points)
  const total = series.reduce((sum, month) => sum + month.count, 0)
  const latest = series.at(-1)?.count ?? 0
  const previous = series.at(-2)?.count ?? 0
  const delta = latest - previous
  const max = Math.max(1, ...series.map((month) => month.count))

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle>Requisition exceptions</CardTitle>
        <CardDescription>
          Requisitions that failed a gate, by month
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col justify-center">
        {isError ? (
          <ErrorState
            title="Could not load the exception trend"
            message={errorMessage}
          />
        ) : isPending ? (
          <PendingState label="Loading the exception trend" rows={3} />
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="font-heading font-semibold text-3xl tabular-nums">
                {total.toLocaleString("en-PH")}
              </span>
              <span className="text-muted-foreground text-sm">
                gate exceptions in the last {CHART_MONTHS} months
              </span>
              <span
                className={cn(
                  "text-xs",
                  delta > 0
                    ? "text-destructive"
                    : delta < 0
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-muted-foreground"
                )}
              >
                {latest} this month
                {delta === 0
                  ? " · level with last month"
                  : ` · ${delta > 0 ? "+" : ""}${delta} vs last month`}
              </span>
            </div>
            <div className="flex items-end gap-1.5 sm:gap-3">
              {series.map((month, index) => (
                <div
                  key={month.month}
                  className="flex min-w-0 flex-1 flex-col items-center gap-1"
                >
                  <span className="text-muted-foreground text-xs tabular-nums">
                    {month.count}
                  </span>
                  <div
                    className={cn(
                      "w-full max-w-16 rounded-t-sm",
                      month.count === 0
                        ? "bg-muted-foreground/25"
                        : index === series.length - 1
                          ? "bg-primary"
                          : "bg-primary/35"
                    )}
                    style={{
                      height: `${month.count === 0 ? 2 : 8 + (month.count / max) * 80}px`,
                    }}
                    title={`${month.label}: ${month.count}`}
                  />
                  <span className="text-muted-foreground text-xs">
                    {month.label}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function BudgetWatchCard({
  spend,
  isPending,
  isError,
  errorMessage,
}: {
  spend: SpendRow[]
  isPending: boolean
  isError: boolean
  errorMessage: string
}) {
  const rows = [...spend]
    .sort((a, b) => b.utilizationPct - a.utilizationPct)
    .slice(0, 4)

  return (
    <Card size="sm" className="flex flex-col">
      <CardHeader>
        <CardTitle>Budget watch</CardTitle>
        <CardDescription>Highest utilization in the window</CardDescription>
      </CardHeader>
      <CardContent className="flex-1">
        {isError ? (
          <ErrorState
            title="Could not load budget use"
            message={errorMessage}
          />
        ) : isPending ? (
          <PendingState label="Loading spend" rows={3} />
        ) : rows.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No budgets tracked in this window.
          </p>
        ) : (
          <ul className="flex flex-col gap-4">
            {rows.map((budget) => {
              const bar =
                budget.utilizationPct >= 90
                  ? "bg-destructive"
                  : budget.utilizationPct >= 75
                    ? "bg-amber-500"
                    : "bg-primary"
              return (
                <li
                  key={`${budget.costCenter}-${budget.period}`}
                  className="flex flex-col gap-1.5"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate font-medium text-sm">
                      {budget.costCenter}
                    </span>
                    <span
                      className={cn(
                        "text-sm tabular-nums",
                        budget.utilizationPct >= 90
                          ? "text-destructive"
                          : budget.utilizationPct >= 75
                            ? "text-amber-600 dark:text-amber-400"
                            : "text-muted-foreground"
                      )}
                    >
                      {budget.utilizationPct.toFixed(1)}%
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                    <div
                      className={cn("h-full rounded-full", bar)}
                      style={{
                        width: `${Math.min(100, Math.max(0, budget.utilizationPct))}%`,
                      }}
                    />
                  </div>
                  <span className="text-muted-foreground text-xs">
                    {budget.period} · {minorToPhp(budget.spentMinor)} of{" "}
                    {minorToPhp(budget.limitMinor)}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
      <CardFooter>
        <CardLink href="#operations">See all budgets</CardLink>
      </CardFooter>
    </Card>
  )
}

function AgentHealthCard({
  agents,
  isPending,
  isError,
  errorMessage,
}: {
  agents: AgentStats | undefined
  isPending: boolean
  isError: boolean
  errorMessage: string
}) {
  const total = agents?.total ?? 0
  const successRate =
    agents && total > 0 ? Math.round((agents.succeeded / total) * 100) : null
  const share = (value: number) =>
    total > 0 ? `${(value / total) * 100}%` : "0%"

  return (
    <Card size="sm" className="flex flex-col">
      <CardHeader>
        <CardTitle>Agent health</CardTitle>
        <CardDescription>
          Unattended runs, last {CHART_MONTHS} months
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col justify-center gap-4">
        {isError ? (
          <ErrorState
            title="Could not load agent health"
            message={errorMessage}
          />
        ) : isPending || !agents ? (
          <PendingState label="Loading agent health" rows={3} />
        ) : total === 0 ? (
          <p className="text-muted-foreground text-sm">
            No agent runs in this window.
          </p>
        ) : (
          <>
            <div className="flex items-baseline gap-2">
              <span className="font-heading font-semibold text-3xl tabular-nums">
                {successRate === null ? "—" : `${successRate}%`}
              </span>
              <span className="text-muted-foreground text-sm">succeeded</span>
            </div>
            <div className="flex h-2 overflow-hidden rounded-full bg-muted">
              <div
                className="bg-primary"
                style={{ width: share(agents.succeeded) }}
              />
              <div
                className="bg-destructive"
                style={{ width: share(agents.failed) }}
              />
              <div
                className="bg-amber-500"
                style={{ width: share(agents.running) }}
              />
            </div>
            <dl className="grid grid-cols-3 gap-2">
              <div className="flex flex-col gap-0.5">
                <dt className="text-muted-foreground text-xs">Succeeded</dt>
                <dd className="font-medium tabular-nums">
                  {agents.succeeded.toLocaleString("en-PH")}
                </dd>
              </div>
              <div className="flex flex-col gap-0.5">
                <dt className="text-muted-foreground text-xs">Failed</dt>
                <dd
                  className={cn(
                    "font-medium tabular-nums",
                    agents.failed > 0 && "text-destructive"
                  )}
                >
                  {agents.failed.toLocaleString("en-PH")}
                </dd>
              </div>
              <div className="flex flex-col gap-0.5">
                <dt className="text-muted-foreground text-xs">Running</dt>
                <dd
                  className={cn(
                    "font-medium tabular-nums",
                    agents.running > 0 && "text-amber-600 dark:text-amber-400"
                  )}
                >
                  {agents.running.toLocaleString("en-PH")}
                </dd>
              </div>
            </dl>
          </>
        )}
      </CardContent>
      <CardFooter className="justify-between">
        <span className="text-muted-foreground text-xs">
          {total.toLocaleString("en-PH")} runs in window
        </span>
        <CardLink href="/agent-runs">Inspect runs</CardLink>
      </CardFooter>
    </Card>
  )
}

type PendingApproval = {
  id: string
  kind: string
  createdAt: string | Date
  escalatedAt: string | Date | null
  requisition: {
    requestNumber: string
    costCenter: string
    lines: { lineTotalMinor: number }[]
  } | null
}

function ApprovalQueueCard({
  rows,
  total,
  isPending,
  isError,
  errorMessage,
}: {
  rows: PendingApproval[]
  total: number
  isPending: boolean
  isError: boolean
  errorMessage: string
}) {
  return (
    <Card className="lg:col-span-2">
      <CardContent>
        {isError ? (
          <ErrorState
            title="Could not load the approval queue"
            message={errorMessage}
          />
        ) : isPending ? (
          <PendingState label="Loading the approval queue" rows={4} />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No decisions waiting."
            description="Approvals routed to a person appear here, oldest first."
            action={
              <Link
                href="#new-requisition"
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                Raise a requisition
              </Link>
            }
            className="border-0"
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Request</TableHead>
                <TableHead>Waiting</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="hidden md:table-cell">Gate</TableHead>
                <TableHead className="hidden md:table-cell">
                  Cost center
                </TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">Action</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((approval) => {
                const amount =
                  approval.requisition?.lines.reduce(
                    (sum, line) => sum + line.lineTotalMinor,
                    0
                  ) ?? 0
                return (
                  <TableRow key={approval.id}>
                    <TableCell>
                      <Link
                        href="/approvals"
                        className="font-medium hover:underline"
                      >
                        {approval.requisition?.requestNumber ?? "Approval"}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <span
                        className="tabular-nums"
                        title={fmtTime(approval.createdAt)}
                      >
                        {waitingFor(approval.createdAt)}
                      </span>
                      {approval.escalatedAt ? (
                        <Badge
                          variant="destructive"
                          className="ml-2"
                          title="Past the approval SLA"
                        >
                          SLA
                        </Badge>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {approval.requisition ? minorToPhp(amount) : "—"}
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground md:table-cell">
                      {KIND_LABEL[approval.kind] ?? approval.kind}
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      {approval.requisition?.costCenter ?? "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <Link
                        href="/approvals"
                        className={buttonVariants({
                          variant: "ghost",
                          size: "sm",
                        })}
                        aria-label={`Review ${approval.requisition?.requestNumber ?? "approval"}`}
                      >
                        Review
                      </Link>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
      <CardFooter className="justify-between">
        <span className="text-muted-foreground text-xs">
          {total.toLocaleString("en-PH")} pending · oldest first
        </span>
        <CardLink href="/approvals">Open queue</CardLink>
      </CardFooter>
    </Card>
  )
}

function FlowStrip({
  requisitions,
  orders,
  invoices,
  isFinance,
}: {
  requisitions: number | undefined
  orders: number | undefined
  invoices: number | undefined
  isFinance: boolean
}) {
  const count = (value: number | undefined) =>
    value === undefined ? "…" : value.toLocaleString("en-PH")
  const noun = (value: number | undefined, singular: string, plural: string) =>
    value === 1 ? singular : plural

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border bg-card px-4 py-3 text-sm shadow-sm ring-1 ring-foreground/5">
      <span className="text-muted-foreground">In the flow</span>
      <Link
        href="/procurement"
        className="group inline-flex items-baseline gap-1.5"
      >
        <span className="font-medium tabular-nums">{count(requisitions)}</span>
        <span className="text-muted-foreground group-hover:text-foreground">
          {noun(requisitions, "Requisition", "Requisitions")}
        </span>
      </Link>
      <Link
        href="/procurement"
        className="group inline-flex items-baseline gap-1.5"
      >
        <span className="font-medium tabular-nums">{count(orders)}</span>
        <span className="text-muted-foreground group-hover:text-foreground">
          {noun(orders, "Purchase order", "Purchase orders")}
        </span>
      </Link>
      {isFinance ? (
        <Link
          href="/finance"
          className="group inline-flex items-baseline gap-1.5"
        >
          <span className="font-medium tabular-nums">{count(invoices)}</span>
          <span className="text-muted-foreground group-hover:text-foreground">
            {noun(invoices, "Invoice", "Invoices")}
          </span>
        </Link>
      ) : null}
    </div>
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
    ...trpc.approval.pendingList.queryOptions({
      q: "",
      page: 1,
      pageSize: 5,
    }),
    enabled: isSupervisor,
  })
  const overview = useQuery({
    ...trpc.analytics.overview.queryOptions({ months: CHART_MONTHS }),
    enabled: isSupervisor,
  })
  const invoiceExceptions = useQuery({
    ...trpc.invoice.page.queryOptions({
      q: "",
      page: 1,
      pageSize: 1,
      status: "exception",
    }),
    enabled: isFinance,
  })
  const invoices = useQuery({
    ...trpc.invoice.page.queryOptions({ q: "", page: 1, pageSize: 1 }),
    enabled: isFinance,
  })
  const failedRuns = useQuery({
    ...trpc.agent.runs.queryOptions({
      q: "",
      page: 1,
      pageSize: 1,
      status: "failed",
    }),
    enabled: isSupervisor,
  })
  const requisitions = useQuery(
    trpc.requisition.list.queryOptions({ q: "", page: 1, pageSize: 1 })
  )
  const orders = useQuery({
    ...trpc.purchaseOrder.list.queryOptions({ q: "", page: 1, pageSize: 1 }),
    enabled: isSupervisor,
  })

  if (me.isPending) {
    return (
      <div className="flex w-full flex-col gap-8">
        <PageHeader
          title="Supervisory desk"
          description="Decisions, exceptions and the state of the flow"
        />
        <PendingState label="Loading your dashboard" rows={4} />
      </div>
    )
  }

  if (!isSupervisor) {
    return (
      <div className="flex w-full flex-col gap-8">
        <PageHeader
          title="Supervisory desk"
          description="Raise a requisition and follow it through the flow"
        />
        <CreateRequisition
          heading={
            <SectionTitle
              title="New requisition"
              description="Raise a requisition from a budget; the policy engine gates it and routes exceptions to the approval queue."
            />
          }
        />
      </div>
    )
  }

  const pendingRows = (pending.data?.rows ?? []) as PendingApproval[]
  const pendingTotal = pending.data?.total ?? 0
  const oldest = pendingRows[0]?.createdAt
  const budgets = overview.data?.spend ?? []
  const atRisk = budgets.filter((budget) => budget.utilizationPct >= 90).length
  const highestUse = budgets.reduce(
    (highest, budget) => Math.max(highest, budget.utilizationPct),
    0
  )

  return (
    <div className="flex w-full flex-col gap-8">
      <PageHeader
        title="Supervisory desk"
        description="Decisions, exceptions and the state of the flow"
        action={
          <Link
            href="#new-requisition"
            className={buttonVariants({ size: "sm" })}
          >
            <PlusIcon aria-hidden="true" className="size-4" />
            New requisition
          </Link>
        }
      />

      <div
        className={cn(
          "grid gap-3 sm:grid-cols-2",
          isFinance ? "xl:grid-cols-4" : "xl:grid-cols-3"
        )}
      >
        <KpiCard
          label="Pending approvals"
          icon={ClipboardCheckIcon}
          value={kpiValue(
            pending.data?.total,
            pending.isPending,
            pending.isError
          )}
          detail={
            pending.isPending
              ? "Checking the approval queue…"
              : pending.isError
                ? "The approval queue could not load."
                : pendingRows.length > 0 && oldest
                  ? `Oldest waiting ${waitingFor(oldest)}`
                  : "No decision is waiting on a person."
          }
          href="/approvals"
          linkLabel="Review queue"
        />
        {isFinance ? (
          <KpiCard
            label="Invoice exceptions"
            icon={TriangleAlertIcon}
            value={kpiValue(
              invoiceExceptions.data?.total,
              invoiceExceptions.isPending,
              invoiceExceptions.isError
            )}
            detail={
              invoices.isPending
                ? "Loading the invoice count…"
                : invoices.data
                  ? `${invoices.data.total.toLocaleString("en-PH")} invoices on file`
                  : "Invoices registered through intake."
            }
            href="/exceptions"
            linkLabel="Open exceptions"
          />
        ) : null}
        <KpiCard
          label="Failed agent runs"
          icon={BotIcon}
          value={kpiValue(
            failedRuns.data?.total,
            failedRuns.isPending,
            failedRuns.isError
          )}
          detail={
            overview.isPending
              ? "Loading run outcomes…"
              : overview.isError
                ? "Run outcomes could not load."
                : overview.data && overview.data.agents.total > 0
                  ? `All time · ${Math.round((overview.data.agents.succeeded / overview.data.agents.total) * 100)}% of ${overview.data.agents.total.toLocaleString("en-PH")} runs succeeded in the last ${CHART_MONTHS} months`
                  : "All time · no runs in the last 6 months."
          }
          href="/agent-runs"
          linkLabel="Inspect runs"
        />
        <KpiCard
          label="Budgets at risk"
          icon={WalletIcon}
          value={kpiValue(atRisk, overview.isPending, overview.isError)}
          detail={
            overview.isPending
              ? "Loading budget use…"
              : overview.isError
                ? "Budget use could not load."
                : budgets.length > 0
                  ? `${highestUse.toFixed(1)}% highest use · ${budgets.length} budget line${budgets.length === 1 ? "" : "s"}`
                  : "No budgets tracked in this window."
          }
          href="#operations"
          linkLabel="See all budgets"
        />
      </div>

      <FlowStrip
        requisitions={requisitions.data?.total}
        orders={orders.data?.total}
        invoices={invoices.data?.total}
        isFinance={isFinance}
      />

      <section
        aria-labelledby="flow-health-title"
        className="flex flex-col gap-4"
      >
        <SectionTitle
          id="flow-health-title"
          title="Flow health"
          description={`Exceptions and budget use · last ${CHART_MONTHS} months`}
        />
        <div className="grid gap-4 lg:grid-cols-3">
          <ExceptionVolumeCard
            points={overview.data?.exceptionVolume ?? []}
            isPending={overview.isPending}
            isError={overview.isError}
            errorMessage={
              overview.error?.message ?? "Refresh the page to retry."
            }
          />
          <BudgetWatchCard
            spend={budgets}
            isPending={overview.isPending}
            isError={overview.isError}
            errorMessage={
              overview.error?.message ?? "Refresh the page to retry."
            }
          />
        </div>
      </section>

      <section aria-labelledby="decision-title" className="flex flex-col gap-4">
        <SectionTitle
          id="decision-title"
          title="Awaiting decision"
          description="Approvals routed to a person · oldest first"
          action={
            pendingTotal > 0 ? (
              <Badge variant="destructive">{pendingTotal} pending</Badge>
            ) : null
          }
        />
        <div className="grid gap-4 lg:grid-cols-3">
          <ApprovalQueueCard
            rows={pendingRows}
            total={pendingTotal}
            isPending={pending.isPending}
            isError={pending.isError}
            errorMessage={
              pending.error?.message ?? "Refresh the page to retry."
            }
          />
          <AgentHealthCard
            agents={overview.data?.agents}
            isPending={overview.isPending}
            isError={overview.isError}
            errorMessage={
              overview.error?.message ?? "Refresh the page to retry."
            }
          />
        </div>
      </section>

      <div id="new-requisition" className="scroll-mt-6">
        <CreateRequisition
          heading={
            <SectionTitle
              title="New requisition"
              description="Raise a requisition from a budget; the policy engine gates it and routes exceptions to the approval queue."
            />
          }
        />
      </div>

      <div id="operations" className="scroll-mt-6">
        <AnalyticsPanel
          heading={
            <SectionTitle
              title="Operations detail"
              description="Gates, approval latency, retention and the full budget ledger"
            />
          }
        />
      </div>
    </div>
  )
}

export function Cockpit() {
  const { session, isChecking } = useSessionGate()

  if (isChecking) {
    return <SessionPending />
  }
  if (!session) {
    return <SignInCard />
  }
  return <Dashboard />
}
