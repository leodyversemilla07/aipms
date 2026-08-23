"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Button } from "@workspace/ui/components/button"
import { type ReactNode, useState } from "react"
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

/** Budget master — cost-center + period spend envelopes (§9 invariants). */
export function BudgetsPanel() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()

  const [name, setName] = useState("")
  const [costCenter, setCostCenter] = useState("")
  const [period, setPeriod] = useState("")
  const [limit, setLimit] = useState("")
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const list = useQuery(
    trpc.budget.list.queryOptions({ q: "", page: 1, pageSize: 50 })
  )
  const rows = (list.data?.rows ?? []) as unknown as BudgetRow[]

  const create = useMutation(trpc.budget.create.mutationOptions())
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
        <h2 className="font-semibold text-muted-foreground text-sm uppercase tracking-wide">
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
      {error ? (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-destructive text-xs">
          {error}
        </p>
      ) : null}

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
            </li>
          )
        })}
      </ul>
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
