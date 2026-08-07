"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Button } from "@workspace/ui/components/button"
import { useState } from "react"
import { LINE_STATUS, netMinor, RUN_STATUS } from "@/lib/finance"
import { minorToPhp } from "@/lib/money"
import { useTRPC } from "@/lib/trpc/client"

/**
 * §8.6 payment run lifecycle. Maker/checker (§16.4) is enforced by the API:
 * the approver must differ from the creator — the desk surfaces the error
 * with a hint when a single user tries to self-approve.
 */
export function PaymentRuns() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()

  const runs = useQuery(trpc.paymentRun.list.queryOptions({}))
  const matched = useQuery(
    trpc.invoice.list.queryOptions({ status: "matched" })
  )
  // Prisma payload rows recurse deeply; narrow to the fields rendered here.
  const runRows = (runs.data ?? []) as unknown as Array<{
    id: string
    runNumber: string
    status: string
    totalMinor: number
    lines: Array<{
      id: string
      invoiceId: string
      netMinor: number
      status: string
    }>
  }>
  const matchedRows = (matched.data ?? []) as unknown as Array<{
    id: string
    number: string
    status: string
    amountMinor: number
    vatMinor: number
    ewtMinor: number
  }>

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const create = useMutation(trpc.paymentRun.create.mutationOptions())
  const approve = useMutation(trpc.paymentRun.approve.mutationOptions())
  const execute = useMutation(trpc.paymentRun.execute.mutationOptions())
  const reconcile = useMutation(trpc.paymentRun.reconcile.mutationOptions())

  function refresh() {
    queryClient.invalidateQueries(trpc.paymentRun.pathFilter())
    queryClient.invalidateQueries(trpc.invoice.pathFilter())
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function createRun() {
    setError(null)
    setNotice(null)
    try {
      await create.mutateAsync({
        idempotencyKey: `web-run-${crypto.randomUUID()}`,
        invoiceIds: [...selected],
      })
      setNotice(
        "Run created as draft. A different user must approve it (§16.4)."
      )
      setSelected(new Set())
      refresh()
    } catch (e) {
      setError(`Could not create run: ${(e as Error).message}`)
    }
  }

  async function act(action: () => Promise<unknown>, hint?: string) {
    setError(null)
    setNotice(null)
    try {
      await action()
      refresh()
      if (hint) setNotice(hint)
    } catch (e) {
      const message = (e as Error).message
      if (message.includes("Maker and checker")) {
        setError(
          "Maker and checker must differ (§16.4). Sign out and approve with another account."
        )
      } else {
        setError(`Action failed: ${message}`)
      }
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h2 className="font-semibold text-muted-foreground text-sm uppercase tracking-wide">
          Payment runs
        </h2>
        <span className="text-muted-foreground text-xs">
          {(runs.data ?? []).length} runs
        </span>
      </div>

      {error ? (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-destructive text-xs">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="rounded-md bg-emerald-500/10 px-3 py-2 text-emerald-600 text-xs">
          {notice}
        </p>
      ) : null}

      <div className="rounded-xl border bg-card p-4 shadow-sm">
        <p className="font-medium text-sm">New run</p>
        <p className="mb-2 text-muted-foreground text-xs">
          Only matched invoices are payable. Pick invoices to plan a run.
        </p>
        {matchedRows.length === 0 ? (
          <p className="text-muted-foreground text-xs">
            No matched invoices — register invoices against a PO and clear the
            three-way match first.
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            {matchedRows.map((inv) => (
              <label
                key={inv.id}
                className="flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-muted"
              >
                <input
                  type="checkbox"
                  checked={selected.has(inv.id)}
                  onChange={() => toggle(inv.id)}
                />
                <span className="flex-1">{inv.number}</span>
                <span className="font-mono text-muted-foreground text-xs">
                  {minorToPhp(netMinor(inv))}
                </span>
              </label>
            ))}
            <Button
              size="sm"
              className="mt-2 self-start"
              disabled={selected.size === 0 || create.isPending}
              onClick={createRun}
            >
              {create.isPending ? "Planning…" : "Create draft run"}
            </Button>
          </div>
        )}
      </div>

      <ul className="flex flex-col gap-3">
        {runRows.map((run) => (
          <li
            key={run.id}
            className="flex flex-col gap-2 rounded-xl border bg-card p-4 shadow-sm"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-sm">
                {run.runNumber}
                <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-muted-foreground text-xs">
                  {RUN_STATUS[run.status] ?? run.status}
                </span>
              </span>
              <span className="font-mono text-sm">
                {minorToPhp(run.totalMinor)}
              </span>
            </div>

            <ul className="flex flex-col gap-1">
              {run.lines.map((line) => (
                <li
                  key={line.id}
                  className="flex items-center justify-between rounded-md bg-muted/40 px-2 py-1 text-xs"
                >
                  <span className="text-muted-foreground">
                    {line.invoiceId.slice(0, 8)} ·{" "}
                    {LINE_STATUS[line.status] ?? line.status}
                  </span>
                  <span className="font-mono">{minorToPhp(line.netMinor)}</span>
                  {run.status === "executed" && line.status === "planned" ? (
                    <span className="flex gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          act(() =>
                            reconcile.mutateAsync({
                              runId: run.id,
                              lineId: line.id,
                              status: "paid",
                            })
                          )
                        }
                      >
                        Paid
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          act(() =>
                            reconcile.mutateAsync({
                              runId: run.id,
                              lineId: line.id,
                              status: "dishonored",
                            })
                          )
                        }
                      >
                        Dishonored
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          act(() =>
                            reconcile.mutateAsync({
                              runId: run.id,
                              lineId: line.id,
                              status: "rejected",
                            })
                          )
                        }
                      >
                        Rejected
                      </Button>
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>

            {run.status === "draft" ? (
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={approve.isPending}
                  onClick={() => act(() => approve.mutateAsync({ id: run.id }))}
                >
                  Approve
                </Button>
              </div>
            ) : null}
            {run.status === "approved" ? (
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={execute.isPending}
                  onClick={() => act(() => execute.mutateAsync({ id: run.id }))}
                >
                  Execute
                </Button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  )
}
