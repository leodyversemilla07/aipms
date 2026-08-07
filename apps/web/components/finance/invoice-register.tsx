"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Button } from "@workspace/ui/components/button"
import { useState } from "react"
import { netMinor } from "@/lib/finance"
import { minorToPhp } from "@/lib/money"
import { useTRPC } from "@/lib/trpc/client"

type LineDraft = {
  id: string
  description: string
  amount: string
  cls: "goods" | "services" | "professional" | "rental" | "other"
  vatExempt: boolean
}

let lineSeq = 0
function emptyLine(): LineDraft {
  lineSeq += 1
  return {
    id: `line-${lineSeq}`,
    description: "",
    amount: "",
    cls: "goods",
    vatExempt: false,
  }
}

/**
 * Register a supplier invoice. The engine derives VAT/EWT deterministically
 * (§8.4) and runs the §9 three-way match against the PO; the outcome
 * (matched | exception) is shown here.
 */
export function InvoiceRegister() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()

  const vendors = useQuery(
    trpc.vendor.list.queryOptions({ q: "", page: 1, pageSize: 50 })
  )
  // Prisma payload rows are deeply recursive; we only need the id + name.
  const vendorRows = (vendors.data?.rows ?? []) as unknown as Array<{
    id: string
    name: string
  }>

  const pos = useQuery(
    trpc.purchaseOrder.list.queryOptions({ q: "", page: 1, pageSize: 50 })
  )
  const poRows = (pos.data?.rows ?? []) as unknown as Array<{
    id: string
    poNumber: string
    vendorId: string
    status: string
  }>

  const [vendorId, setVendorId] = useState("")
  const [number, setNumber] = useState("")
  const [poId, setPoId] = useState("")

  const confirmedPos = poRows.filter((po) => po.status === "confirmed")
  const vendorPos =
    vendorId === ""
      ? confirmedPos
      : confirmedPos.filter((po) => po.vendorId === vendorId)
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()])
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const register = useMutation(trpc.invoice.register.mutationOptions())

  function setLine(i: number, patch: Partial<LineDraft>) {
    setLines((prev) =>
      prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l))
    )
  }

  function addLine() {
    setLines((prev) => [...prev, emptyLine()])
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setResult(null)
    setError(null)
    setBusy(true)

    const parsedLines = lines.map((l) => ({
      description: l.description || undefined,
      amountMinor: Math.round(Number.parseFloat(l.amount) * 100),
      class: l.cls,
      vatExempt: l.vatExempt || undefined,
    }))
    if (
      parsedLines.some((l) => Number.isNaN(l.amountMinor) || l.amountMinor < 0)
    ) {
      setError("Every line needs a valid ₱ amount.")
      setBusy(false)
      return
    }

    try {
      const res = await register.mutateAsync({
        idempotencyKey: `web-inv-${crypto.randomUUID()}`,
        vendorId,
        number,
        poId: poId || undefined,
        lines: parsedLines,
      })
      const inv = res.invoice as {
        status: string
        amountMinor: number
        vatMinor: number
        ewtMinor: number
      }
      const matchOutcome = res.match
        ? ` · 3-way: ${res.match.outcome}`
        : " · no PO to match"
      setResult(
        `Invoice ${number} → ${inv.status}${matchOutcome} — gross ${minorToPhp(
          inv.amountMinor
        )}, VAT ${minorToPhp(inv.vatMinor)}, EWT ${minorToPhp(inv.ewtMinor)}, net ${minorToPhp(
          netMinor(inv)
        )}.`
      )
      queryClient.invalidateQueries(trpc.invoice.pathFilter())
      setLines([emptyLine()])
      setNumber("")
    } catch (e) {
      setError(`Could not register invoice: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h2 className="font-semibold text-muted-foreground text-sm uppercase tracking-wide">
          Register invoice
        </h2>
      </div>

      <form
        onSubmit={submit}
        className="flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-sm"
      >
        <div className="grid grid-cols-3 gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">Vendor</span>
            <select
              value={vendorId}
              onChange={(e) => setVendorId(e.target.value)}
              required
              className="h-9 rounded-md border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">Select vendor…</option>
              {vendorRows.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">Invoice no.</span>
            <input
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              required
              placeholder="INV-2026-0001"
              className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">PO (optional)</span>
            <select
              value={poId}
              onChange={(e) => setPoId(e.target.value)}
              className="h-9 rounded-md border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">No PO</option>
              {vendorPos.map((po) => (
                <option key={po.id} value={po.id}>
                  {po.poNumber}
                </option>
              ))}
            </select>
            {vendorId !== "" && vendorPos.length === 0 ? (
              <span className="text-muted-foreground text-xs">
                No confirmed PO for this vendor
              </span>
            ) : null}
          </label>
        </div>

        <div className="flex flex-col gap-2">
          {lines.map((line, i) => (
            <div
              key={line.id}
              className="grid grid-cols-[1fr_96px_120px_64px] gap-2"
            >
              <input
                value={line.description}
                onChange={(e) => setLine(i, { description: e.target.value })}
                placeholder={`Line ${i + 1} description`}
                className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
              <input
                value={line.amount}
                onChange={(e) => setLine(i, { amount: e.target.value })}
                type="number"
                min={0}
                step={0.01}
                required
                placeholder="₱ amount"
                className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
              <select
                value={line.cls}
                onChange={(e) =>
                  setLine(i, { cls: e.target.value as LineDraft["cls"] })
                }
                className="h-9 rounded-md border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="goods">goods</option>
                <option value="services">services</option>
                <option value="professional">professional</option>
                <option value="rental">rental</option>
                <option value="other">other</option>
              </select>
              <label className="flex items-center gap-1 text-muted-foreground text-xs">
                <input
                  type="checkbox"
                  checked={line.vatExempt}
                  onChange={(e) => setLine(i, { vatExempt: e.target.checked })}
                />
                VAT-free
              </label>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <Button type="button" size="sm" variant="outline" onClick={addLine}>
            + add line
          </Button>
          <Button type="submit" size="sm" disabled={busy}>
            {busy ? "Registering…" : "Register invoice"}
          </Button>
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
    </section>
  )
}
