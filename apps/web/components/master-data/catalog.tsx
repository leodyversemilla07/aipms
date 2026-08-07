"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Button } from "@workspace/ui/components/button"
import { type ReactNode, useState } from "react"
import { ConfirmButton } from "@/components/confirm-button"
import { minorToPhp, phpToMinor } from "@/lib/money"
import { useTRPC } from "@/lib/trpc/client"

type ItemRow = {
  id: string
  sku: string
  name: string
  category: string
  unit: string
  defaultPriceMinor: number | null
  active: boolean
}

/** Catalog master — price list items the requisition form autocompletes. */
export function CatalogPanel() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()

  const [sku, setSku] = useState("")
  const [name, setName] = useState("")
  const [category, setCategory] = useState("general")
  const [unit, _setUnit] = useState("ea")
  const [price, setPrice] = useState("")
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const list = useQuery(
    trpc.catalog.list.queryOptions({ q: "", page: 1, pageSize: 50 })
  )
  const rows = (list.data?.rows ?? []) as unknown as ItemRow[]

  const create = useMutation(trpc.catalog.create.mutationOptions())
  const deactivate = useMutation(trpc.catalog.deactivate.mutationOptions())

  function refresh() {
    queryClient.invalidateQueries(trpc.catalog.pathFilter())
  }

  async function doCreate() {
    setNotice(null)
    setError(null)
    const priceMinor = phpToMinor(price)
    try {
      const item = await create.mutateAsync({
        idempotencyKey: `web-catalog-${crypto.randomUUID()}`,
        sku,
        name,
        ...(category ? { category } : {}),
        ...(unit ? { unit } : {}),
        ...(priceMinor != null ? { defaultPriceMinor: priceMinor } : {}),
      })
      setNotice(`Item ${(item as { sku?: string }).sku ?? ""} added`)
      setSku("")
      setName("")
      setPrice("")
      refresh()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h2 className="font-semibold text-muted-foreground text-sm uppercase tracking-wide">
          Catalog items
        </h2>
        <span className="text-muted-foreground text-xs">{rows.length}</span>
      </div>

      <div className="flex flex-wrap items-end gap-2 rounded-xl border bg-card p-4 shadow-sm">
        <Field label="SKU">
          <input
            value={sku}
            onChange={(e) => setSku(e.target.value)}
            className="h-9 w-32 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        </Field>
        <Field label="Name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        </Field>
        <Field label="Category">
          <input
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="h-9 w-28 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        </Field>
        <Field label="Price ₱">
          <input
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="0.00"
            className="h-9 w-24 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        </Field>
        <Button
          size="sm"
          disabled={!sku.trim() || !name.trim() || create.isPending}
          onClick={doCreate}
        >
          Add item
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
        {rows.map((item) => (
          <li
            key={item.id}
            className="flex items-center justify-between gap-2 rounded-lg border bg-card px-4 py-2 text-sm"
          >
            <div className="flex flex-col">
              <span className="font-medium">
                {item.sku} — {item.name}
              </span>
              <span className="text-muted-foreground text-xs">
                {item.category} / {item.unit} ·{" "}
                {item.defaultPriceMinor != null
                  ? minorToPhp(item.defaultPriceMinor)
                  : "no price"}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-xs">
                {item.active ? "active" : "inactive"}
              </span>
              {item.active ? (
                <ConfirmButton
                  message="Deactivate?"
                  disabled={deactivate.isPending}
                  onConfirm={() =>
                    deactivate
                      .mutateAsync({
                        id: item.id,
                        idempotencyKey: `web-${item.id}`,
                      })
                      .then(refresh)
                  }
                >
                  Deactivate
                </ConfirmButton>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-muted-foreground text-xs">{label}</span>
      {children}
    </label>
  )
}
