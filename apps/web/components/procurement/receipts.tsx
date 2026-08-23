"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Button } from "@workspace/ui/components/button"
import {
  Field,
  FieldDescription,
  FieldGroup,
} from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { useState } from "react"
import { ConfirmButton } from "@/components/confirm-button"
import { fmtTime } from "@/lib/time"
import { useTRPC } from "@/lib/trpc/client"

type PoLine = {
  lineNo: number
  sku: string | null
  description: string
  quantity: number
  unit: string | null
}

type PoRow = {
  id: string
  poNumber: string
  status: string
  vendorId: string
  lines: PoLine[]
}

type ReceiptLine = {
  lineNo: number | null
  sku: string | null
  description: string
  quantity: number
  unit: string | null
}

type ReceiptRow = {
  id: string
  receiptNumber: string
  poId: string
  vendorId: string
  status: string
  note: string | null
  recordedAt: string
  lines: ReceiptLine[]
}

/**
 * §8.1 — goods receipts, the middle leg of the three-way match. Operators
 * record deliveries against issued/confirmed POs; the server refuses
 * over-receipts and re-matches any invoices waiting for those goods.
 */
export function Receipts() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()

  const [recording, setRecording] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const pos = useQuery(
    trpc.purchaseOrder.list.queryOptions({ q: "", page: 1, pageSize: 50 })
  )
  const receipts = useQuery(
    trpc.receipt.list.queryOptions({ q: "", page: 1, pageSize: 50 })
  )
  const rows = (receipts.data?.rows ?? []) as unknown as ReceiptRow[]
  const openPos = ((pos.data?.rows ?? []) as unknown as PoRow[]).filter(
    (po) => po.status === "issued" || po.status === "confirmed"
  )

  const cancel = useMutation(trpc.receipt.cancel.mutationOptions())

  function refresh() {
    queryClient.invalidateQueries(trpc.receipt.pathFilter())
    queryClient.invalidateQueries(trpc.invoice.pathFilter())
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h2 className="font-semibold text-muted-foreground text-sm uppercase tracking-wide">
          Goods receipts
        </h2>
        <span className="text-muted-foreground text-xs">{rows.length}</span>
      </div>

      {notice ? (
        <p className="rounded-lg bg-primary/10 px-3 py-2 text-primary text-xs">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="rounded-lg bg-destructive/10 px-3 py-2 text-destructive text-xs">
          {error}
        </p>
      ) : null}

      <RecordReceiptForm
        open={recording}
        onOpenChange={(open) => {
          setRecording(open)
          setNotice(null)
          setError(null)
        }}
        openPos={openPos}
        loading={pos.isPending}
        onRecorded={(msg) => {
          setRecording(false)
          setNotice(msg)
          refresh()
        }}
        onError={setError}
      />

      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-muted-foreground text-sm">
          No receipts yet — record a delivery against an issued or confirmed PO
          above.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((r) => (
            <li
              key={r.id}
              className="rounded-lg border bg-card px-4 py-2 text-sm"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex flex-col">
                  <span className="font-medium">{r.receiptNumber}</span>
                  <span className="text-muted-foreground text-xs">
                    {r.status === "cancelled" ? (
                      <span className="text-destructive">Cancelled</span>
                    ) : (
                      `${r.lines.length} line(s)`
                    )}{" "}
                    · PO {r.poId.slice(0, 8)} · vendor {r.vendorId.slice(0, 8)}{" "}
                    · {fmtTime(r.recordedAt)}
                  </span>
                </div>
                {r.status === "recorded" ? (
                  <ConfirmButton
                    size="sm"
                    message="Cancel receipt?"
                    disabled={cancel.isPending}
                    onConfirm={() =>
                      cancel
                        .mutateAsync({ id: r.id })
                        .then(refresh)
                        .catch((e: Error) => setError(e.message))
                    }
                  >
                    Cancel
                  </ConfirmButton>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function RecordReceiptForm({
  open,
  onOpenChange,
  openPos,
  loading,
  onRecorded,
  onError,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  openPos: PoRow[]
  loading: boolean
  onRecorded: (message: string) => void
  onError: (message: string) => void
}) {
  const trpc = useTRPC()
  const [poId, setPoId] = useState("")
  const [quantities, setQuantities] = useState<Record<number, string>>({})
  const [note, setNote] = useState("")
  const [pending, setPending] = useState(false)

  const record = useMutation(trpc.receipt.record.mutationOptions())
  const po = openPos.find((p) => p.id === poId)

  function pickPo(id: string) {
    setPoId(id)
    setQuantities({})
  }

  async function submit() {
    if (!po) return
    const lines = po.lines
      .map((l) => ({
        lineNo: l.lineNo,
        sku: l.sku ?? undefined,
        description: l.description,
        quantity: Number.parseInt(quantities[l.lineNo] ?? "", 10),
        unit: l.unit ?? undefined,
      }))
      .filter((l) => Number.isInteger(l.quantity) && l.quantity > 0)
    if (lines.length === 0) {
      onError("Enter a received quantity of at least 1 for one or more lines")
      return
    }
    setPending(true)
    try {
      const result = await record.mutateAsync({
        idempotencyKey: `web-receipt-${po.id}-${Date.now()}`,
        poId: po.id,
        lines,
        note: note.trim() || undefined,
      })
      const rm = result.rematch
      const rematchNote =
        rm.considered > 0 ? ` Re-matched ${rm.matched} waiting invoice(s).` : ""
      onRecorded(`Receipt recorded against ${po.poNumber}.${rematchNote}`)
      setPoId("")
      setQuantities({})
      setNote("")
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setPending(false)
    }
  }

  if (!open) {
    return (
      <Button
        variant="outline"
        className="self-start"
        onClick={() => onOpenChange(true)}
      >
        Record a delivery…
      </Button>
    )
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <FieldGroup>
        <Field>
          <Label>Purchase order</Label>
          <Select
            value={poId}
            onValueChange={(value) => pickPo(value ?? "")}
          >
            <SelectTrigger className="w-full">
              <SelectValue
                placeholder={
                  loading
                    ? "Loading POs…"
                    : openPos.length === 0
                      ? "No issued or confirmed POs"
                      : "Choose a PO…"
                }
              />
            </SelectTrigger>
            <SelectContent>
              {openPos.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.poNumber} ({p.status}) · {p.lines.length} line(s)
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldDescription>
            Cumulative received quantities can never exceed what was ordered —
            the server refuses over-receipts.
          </FieldDescription>
        </Field>

        {po ? (
          <div className="flex flex-col divide-y divide-border rounded-lg border">
            {po.lines.map((l) => (
              <label
                key={l.lineNo}
                className="grid grid-cols-[1fr_6rem_5rem] items-center gap-2 px-3 py-2 text-xs"
              >
                <span>
                  <span className="font-mono text-muted-foreground">
                    #{l.lineNo}
                  </span>{" "}
                  {l.sku ? `${l.sku} — ` : ""}
                  {l.description}
                </span>
                <span className="text-muted-foreground">
                  ordered {l.quantity} {l.unit ?? ""}
                </span>
                <Input
                  inputMode="numeric"
                  placeholder="received"
                  value={quantities[l.lineNo] ?? ""}
                  onChange={(e) =>
                    setQuantities((prev) => ({
                      ...prev,
                      [l.lineNo]: e.target.value.replace(/[^0-9]/g, ""),
                    }))
                  }
                />
              </label>
            ))}
          </div>
        ) : null}

        <Field>
          <Label htmlFor="receipt-note">Note (optional)</Label>
          <Input
            id="receipt-note"
            placeholder="Delivery reference, driver, condition…"
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
      </FieldGroup>

      <div className="flex items-center gap-2 self-end">
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button disabled={!po || pending} onClick={submit}>
          {pending ? "Recording…" : "Record receipt"}
        </Button>
      </div>
    </div>
  )
}
