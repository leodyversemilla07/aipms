"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"
import { type ReactNode, useState } from "react"
import { EmptyState } from "@/components/states/empty-state"
import { InlineError } from "@/components/states/error-state"
import { PendingCard } from "@/components/states/pending-state"
import { minorToPhp, phpToMinor } from "@/lib/money"
import { useTRPC } from "@/lib/trpc/client"

type BudgetRow = {
  id: string
  name: string
  costCenter: string
  period: string
  limitMinor: number
  committedMinor: number
  spentMinor: number
}

type ReconciliationRow = {
  poNumber: string
  status: string
  committedMinor: number
  settledMinor: number
  remainingMinor: number
  live: boolean
}

type Reconciliation = {
  committedMinor: number
  spentMinor: number
  expectedCommittedMinor: number
  expectedSpentMinor: number
  committedDriftMinor: number
  spentDriftMinor: number
  ok: boolean
  rows: ReconciliationRow[]
  issues: string[]
}

/** Budget master — cost-center + period spend envelopes (§9 invariants). */
export function BudgetsPanel() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()

  const [name, setName] = useState("")
  const [costCenter, setCostCenter] = useState("")
  const [period, setPeriod] = useState("")
  const [limit, setLimit] = useState("")
  const [reconcileId, setReconcileId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const list = useQuery(
    trpc.budget.list.queryOptions({ q: "", page: 1, pageSize: 50 })
  )
  const rows = (list.data?.rows ?? []) as BudgetRow[]

  const create = useMutation(trpc.budget.create.mutationOptions())
  const reconciliation = useQuery({
    ...trpc.budget.reconciliation.queryOptions({ id: reconcileId ?? "" }),
    enabled: reconcileId != null,
  })
  function refresh() {
    queryClient.invalidateQueries(trpc.budget.pathFilter())
  }

  async function doCreate() {
    setNotice(null)
    setError(null)
    const limitMinor = phpToMinor(limit)
    if (limitMinor == null) {
      setError("Enter a valid limit (₱).")
      return
    }
    try {
      await create.mutateAsync({
        idempotencyKey: `web-budget-${crypto.randomUUID()}`,
        name,
        costCenter,
        period,
        limitMinor,
      })
      setNotice(`Budget ${name} created`)
      setName("")
      setCostCenter("")
      setPeriod("")
      setLimit("")
      refresh()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h2 className="scroll-mt-6 font-heading font-semibold text-xl tracking-tight">
          Budgets
        </h2>
        <span className="text-muted-foreground text-xs">{rows.length}</span>
      </div>

      <div className="flex flex-wrap items-end gap-2 rounded-xl border bg-card p-4 shadow-sm">
        <Field label="Name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        </Field>
        <Field label="Cost center">
          <input
            value={costCenter}
            onChange={(e) => setCostCenter(e.target.value)}
            className="h-9 w-32 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        </Field>
        <Field label="Period">
          <input
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            placeholder="2026-01"
            className="h-9 w-28 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        </Field>
        <Field label="Limit ₱">
          <input
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
            placeholder="0.00"
            className="h-9 w-28 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        </Field>
        <Button
          size="sm"
          disabled={
            !name.trim() ||
            !costCenter.trim() ||
            !period.trim() ||
            create.isPending
          }
          onClick={doCreate}
        >
          Create budget
        </Button>
      </div>

      {notice ? (
        <p className="rounded-md bg-emerald-500/10 px-3 py-2 text-emerald-600 text-xs">
          {notice}
        </p>
      ) : null}
      {error ? <InlineError message={error} /> : null}

      <ul className="flex flex-col gap-2">
        {rows.map((b) => {
          const used = b.committedMinor + b.spentMinor
          const pct =
            b.limitMinor > 0 ? Math.round((used / b.limitMinor) * 100) : 0
          return (
            <li
              key={b.id}
              className="flex items-center justify-between gap-2 rounded-lg border bg-card px-4 py-2 text-sm"
            >
              <div className="flex flex-col">
                <span className="font-medium">{b.name}</span>
                <span className="text-muted-foreground text-xs">
                  {b.costCenter} / {b.period}
                </span>
              </div>
              <div className="flex flex-col items-end text-xs">
                <span className="font-mono">
                  {minorToPhp(used)} / {minorToPhp(b.limitMinor)} ({pct}%)
                </span>
                <span className="text-muted-foreground">
                  committed {minorToPhp(b.committedMinor)} · spent{" "}
                  {minorToPhp(b.spentMinor)}
                </span>
              </div>
              <Button
                variant="outline"
                size="sm"
                aria-label={`Reconcile ${b.name}`}
                onClick={() => setReconcileId(b.id)}
              >
                Reconcile
              </Button>
            </li>
          )
        })}
      </ul>

      {reconcileId ? (
        <ReconciliationReport
          pending={reconciliation.isPending}
          error={reconciliation.isError ? reconciliation.error.message : null}
          report={reconciliation.data as Reconciliation | undefined}
          onClose={() => setReconcileId(null)}
        />
      ) : null}
    </section>
  )
}

/**
 * The derived commitment audit for one budget. The stored totals are
 * maintained incrementally; this shows what the POs and paid invoices say
 * they should be, and any drift between the two.
 */
function ReconciliationReport({
  pending,
  error,
  report,
  onClose,
}: {
  pending: boolean
  error: string | null
  report: Reconciliation | undefined
  onClose: () => void
}) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-sm">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="font-heading font-semibold text-base">
          Commitment reconciliation
        </h3>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>

      {pending ? <PendingCard label="Loading reconciliation" /> : null}
      {error ? <InlineError message={error} /> : null}
      {!pending && !error && !report ? (
        <EmptyState title="No reconciliation available" />
      ) : null}

      {!pending && !error && report ? (
        <>
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <Badge variant={report.ok ? "default" : "destructive"}>
              {report.ok ? "Balanced" : "Drift detected"}
            </Badge>
            <span className="font-mono">
              committed {minorToPhp(report.committedMinor)} / expected{" "}
              {minorToPhp(report.expectedCommittedMinor)}
            </span>
            <span className="font-mono">
              spent {minorToPhp(report.spentMinor)} / expected{" "}
              {minorToPhp(report.expectedSpentMinor)}
            </span>
          </div>
          {!report.ok ? (
            <p className="font-mono text-destructive text-xs">
              committed drift {minorToPhp(report.committedDriftMinor)} · spent
              drift {minorToPhp(report.spentDriftMinor)}
            </p>
          ) : null}
          {report.issues.length > 0 ? (
            <ul className="text-destructive text-xs">
              {report.issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          ) : null}
          {report.rows.length === 0 ? (
            <EmptyState
              title="No orders on this budget"
              description="No purchase orders are linked to this budget's requisitions."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">PO</TableHead>
                  <TableHead scope="col">Status</TableHead>
                  <TableHead scope="col" className="text-right">
                    Committed
                  </TableHead>
                  <TableHead scope="col" className="text-right">
                    Settled
                  </TableHead>
                  <TableHead scope="col" className="text-right">
                    Remaining
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.rows.map((row) => (
                  <TableRow key={row.poNumber}>
                    <TableCell className="font-mono">{row.poNumber}</TableCell>
                    <TableCell>{row.status}</TableCell>
                    <TableCell className="text-right font-mono">
                      {minorToPhp(row.committedMinor)}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {minorToPhp(row.settledMinor)}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {minorToPhp(row.remainingMinor)}
                      {!row.live ? " (released)" : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </>
      ) : null}
    </section>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  // The wrapped control is a composite (Select), not a native input — a
  // plain group keeps the a11y contract honest.
  return (
    <div className="flex flex-col gap-1 text-sm">
      <span className="text-muted-foreground text-xs">{label}</span>
      {children}
    </div>
  )
}
