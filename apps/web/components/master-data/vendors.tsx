"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Button } from "@workspace/ui/components/button"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import { useState } from "react"
import { useTRPC } from "@/lib/trpc/client"

type VendorRow = {
  id: string
  name: string
  email: string | null
  taxId: string | null
  status: string
  bankAccountVerifiedAt: string | null
}

/**
 * Vendor master — onboard suppliers, flip status, and verify the beneficiary
 * bank account that §8.6 payment runs pay into.
 */
export function VendorsPanel() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()

  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [taxId, setTaxId] = useState("")
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const list = useQuery(
    trpc.vendor.list.queryOptions({ q: "", page: 1, pageSize: 50 })
  )
  const rows = (list.data?.rows ?? []) as unknown as VendorRow[]

  const create = useMutation(trpc.vendor.create.mutationOptions())
  const verify = useMutation(trpc.vendor.verifyBankAccount.mutationOptions())

  function refresh() {
    queryClient.invalidateQueries(trpc.vendor.pathFilter())
  }

  async function doCreate() {
    setNotice(null)
    setError(null)
    try {
      const vendor = await create.mutateAsync({
        idempotencyKey: `web-vendor-${crypto.randomUUID()}`,
        name,
        email: email || undefined,
        taxId: taxId || undefined,
      })
      setNotice(`Vendor ${(vendor as { name?: string }).name ?? ""} created`)
      setName("")
      setEmail("")
      setTaxId("")
      refresh()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h2 className="font-semibold text-muted-foreground text-sm uppercase tracking-wide">
          Vendors
        </h2>
        <span className="text-muted-foreground text-xs">{rows.length}</span>
      </div>

      <FieldGroup className="flex-row flex-wrap items-end gap-2 rounded-xl border bg-card p-4 shadow-sm">
        <Field>
          <FieldLabel htmlFor="vendor-name">Name</FieldLabel>
          <Input
            id="vendor-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Supplier Inc."
            className="h-9 w-56"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="vendor-email">Email</FieldLabel>
          <Input
            id="vendor-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="ap@supplier.example"
            className="h-9 w-56"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="vendor-taxid">Tax id</FieldLabel>
          <Input
            id="vendor-taxid"
            value={taxId}
            onChange={(e) => setTaxId(e.target.value)}
            placeholder="000-000-000-000"
            className="h-9 w-36"
          />
          <FieldDescription>BIR TIN format.</FieldDescription>
        </Field>
        <Button
          size="sm"
          disabled={!name.trim() || create.isPending}
          onClick={doCreate}
        >
          Add vendor
        </Button>
      </FieldGroup>

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
        {rows.map((v) => (
          <li
            key={v.id}
            className="flex items-center justify-between gap-2 rounded-lg border bg-card px-4 py-2 text-sm"
          >
            <div className="flex flex-col">
              <span className="font-medium">{v.name}</span>
              <span className="text-muted-foreground text-xs">
                {v.status} · {v.taxId ?? "no tax id"}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-xs">
                {v.bankAccountVerifiedAt ? "bank ✓" : "bank —"}
              </span>
              {!v.bankAccountVerifiedAt ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={verify.isPending}
                  onClick={() =>
                    verify
                      .mutateAsync({
                        id: v.id,
                        bankAccount: {
                          accountName: v.name,
                          accountNumber: `0000-${v.id.slice(0, 4)}`,
                          bank: "DEMO BANK",
                        },
                      })
                      .then(refresh)
                  }
                >
                  Verify bank
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
