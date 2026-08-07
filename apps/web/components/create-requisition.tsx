"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Button } from "@workspace/ui/components/button"
import { useState } from "react"
import { useTRPC } from "@/lib/trpc/client"

type LineDraft = {
  id: string
  description: string
  quantity: string
  unitPrice: string
}

// Deterministic across server prerender and client hydration to avoid a
// hydration mismatch on the initial rendered row.
let lineSeq = 0

function emptyLine(): LineDraft {
  lineSeq += 1
  return {
    id: `line-${lineSeq}`,
    description: "",
    quantity: "1",
    unitPrice: "0",
  }
}

/**
 * A requisition form against the policy engine. Creates a draft then submits
 * it, which runs the gates — threshold / budget-override / vendor. Anything
 * requiring a human lands in the ExceptionQueue above.
 */
export function CreateRequisition() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()

  const budgets = useQuery(
    trpc.budget.list.queryOptions({ q: "", page: 1, pageSize: 50 })
  )
  const budgetRows = budgets.data?.rows ?? []

  const [show, setShow] = useState(false)
  const [costCenter, setCostCenter] = useState("IT-PROD")
  const [budgetId, setBudgetId] = useState("")
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()])
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const createReq = useMutation(trpc.requisition.create.mutationOptions())
  const submitReq = useMutation(trpc.requisition.submit.mutationOptions())

  function addLine() {
    setLines((prev) => [...prev, emptyLine()])
  }

  function setLine(i: number, patch: Partial<LineDraft>) {
    setLines((prev) =>
      prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l))
    )
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setResult(null)
    setError(null)
    setBusy(true)

    const parsedLines = lines.map((l) => ({
      description: l.description,
      quantity: Number.parseInt(l.quantity, 10),
      unitPriceMinor: Math.round(Number.parseFloat(l.unitPrice) * 100),
    }))
    if (parsedLines.some((l) => !l.description)) {
      setError("Every line needs a description.")
      setBusy(false)
      return
    }

    try {
      const created = await createReq.mutateAsync({
        idempotencyKey: `web-req-${crypto.randomUUID()}`,
        costCenter,
        budgetId: budgetId || null,
        lines: parsedLines,
      })

      await submitReq.mutateAsync({
        id: created.id,
        idempotencyKey: `web-req-submit-${created.id}`,
      })

      setResult(`Requisition ${created.id.slice(0, 8)} created and submitted.`)
      queryClient.invalidateQueries(trpc.requisition.pathFilter())
      queryClient.invalidateQueries(trpc.approval.pathFilter())
      setLines([emptyLine()])
    } catch (e) {
      setError(`Could not create/submit requisition: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h2 className="font-semibold text-muted-foreground text-sm uppercase tracking-wide">
          New requisition
        </h2>
        {!show ? (
          <button
            type="button"
            onClick={() => setShow(true)}
            className="text-muted-foreground text-sm underline hover:text-foreground"
          >
            Compose
          </button>
        ) : null}
      </div>

      {!show ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-muted-foreground text-sm">
          Cut a requisition from a budget; the policy engine gates it and routes
          exceptions to the queue above.
        </p>
      ) : (
        <form
          onSubmit={submit}
          className="flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-sm"
        >
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">Cost center</span>
              <input
                value={costCenter}
                onChange={(e) => setCostCenter(e.target.value)}
                required
                className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">Budget</span>
              <select
                value={budgetId}
                onChange={(e) => setBudgetId(e.target.value)}
                className="h-9 rounded-md border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="">Unassigned</option>
                {budgetRows.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="flex flex-col gap-2">
            {lines.map((line, i) => (
              <div
                key={line.id}
                className="grid grid-cols-[1fr_64px_96px] gap-2"
              >
                <input
                  value={line.description}
                  onChange={(e) => setLine(i, { description: e.target.value })}
                  placeholder={`Line ${i + 1} description`}
                  required
                  className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
                <input
                  value={line.quantity}
                  onChange={(e) => setLine(i, { quantity: e.target.value })}
                  type="number"
                  min={1}
                  step={1}
                  required
                  className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
                <input
                  value={line.unitPrice}
                  onChange={(e) => setLine(i, { unitPrice: e.target.value })}
                  type="number"
                  min={0}
                  step={0.01}
                  required
                  placeholder="₱ unit"
                  className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <Button type="button" size="sm" variant="outline" onClick={addLine}>
              + add line
            </Button>
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? "Submitting…" : "Create & submit"}
            </Button>
            <button
              type="button"
              onClick={() => setShow(false)}
              className="text-muted-foreground text-xs underline"
            >
              Cancel
            </button>
          </div>

          {result ? (
            <p className="rounded-md bg-emerald-500/10 px-3 py-2 text-emerald-600 text-xs">
              {result}
            </p>
          ) : null}
          {error ? (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-destructive text-xs">
              {error}
            </p>
          ) : null}
        </form>
      )}
    </section>
  )
}
