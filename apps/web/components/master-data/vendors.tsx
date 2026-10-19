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
import { useEffect, useState } from "react"
import { PageControls } from "@/components/page-controls"
import { useTRPC } from "@/lib/trpc/client"

type VendorRow = {
  id: string
  name: string
  email: string | null
  taxId: string | null
  status: string
  contactChannels: unknown
  bankAccountVerifiedAt: string | Date | null
  bankAccountChangedAt: string | Date | null
}

function getVerifiedEmails(channels: unknown): string[] {
  if (!channels || typeof channels !== "object") return []
  const obj = channels as { verifiedEmails?: unknown }
  if (!Array.isArray(obj.verifiedEmails)) return []
  return obj.verifiedEmails.filter((e): e is string => typeof e === "string")
}

/**
 * Vendor master — onboard suppliers, flip status, manage verified contacts,
 * and verify the beneficiary bank account that §8.6 payment runs pay into.
 */
export function VendorsPanel() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()

  const [page, setPage] = useState(1)
  const PAGE_SIZE = 25
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [taxId, setTaxId] = useState("")
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [bankVendorId, setBankVendorId] = useState<string | null>(null)
  const [bank, setBank] = useState("")
  const [accountNumber, setAccountNumber] = useState("")
  const [holder, setHolder] = useState("")

  const [contactVendorId, setContactVendorId] = useState<string | null>(null)
  const [contactEmail, setContactEmail] = useState("")
  const [contactEvidence, setContactEvidence] = useState("")

  const list = useQuery(
    trpc.vendor.list.queryOptions({ q: "", page, pageSize: PAGE_SIZE })
  )
  const rows = (list.data?.rows ?? []) as VendorRow[]
  const total = list.data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  useEffect(() => {
    if (list.data && page > totalPages) setPage(totalPages)
  }, [list.data, page, totalPages])

  const create = useMutation(trpc.vendor.create.mutationOptions())
  const verify = useMutation(trpc.vendor.verifyBankAccount.mutationOptions())
  const verifyContact = useMutation(trpc.vendor.verifyContact.mutationOptions())
  const revokeContact = useMutation(trpc.vendor.revokeContact.mutationOptions())

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

  async function verifyBank(vendorId: string) {
    setNotice(null)
    setError(null)
    try {
      const result = await verify.mutateAsync({
        id: vendorId,
        bankAccount: { bank, accountNumber, holder },
      })
      setNotice(
        result.bankAccountChangedAt
          ? "Beneficiary account submitted; a different finance user must verify the same details"
          : "Beneficiary bank account verified by the second finance user"
      )
      setBankVendorId(null)
      setBank("")
      setAccountNumber("")
      setHolder("")
      refresh()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function doVerifyContact(vendorId: string) {
    setNotice(null)
    setError(null)
    try {
      await verifyContact.mutateAsync({
        idempotencyKey: `web-contact-${crypto.randomUUID()}`,
        vendorId,
        email: contactEmail,
        evidence: contactEvidence,
      })
      setNotice(`Contact ${contactEmail} verified successfully`)
      setContactVendorId(null)
      setContactEmail("")
      setContactEvidence("")
      refresh()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function doRevokeContact(vendorId: string, email: string) {
    setNotice(null)
    setError(null)
    try {
      await revokeContact.mutateAsync({
        idempotencyKey: `web-revoke-${crypto.randomUUID()}`,
        vendorId,
        email,
        reason: "Revoked from vendor master cockpit",
      })
      setNotice(`Contact ${email} revoked`)
      refresh()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h2 className="scroll-mt-6 font-heading font-semibold text-xl tracking-tight">
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

      <div className="flex items-baseline justify-between">
        <h3 className="font-heading font-medium text-muted-foreground text-sm">
          Suppliers
        </h3>
        <span className="text-muted-foreground text-xs">
          {total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1}–
          {Math.min(page * PAGE_SIZE, total)} of {total}
        </span>
      </div>

      <ul className="flex flex-col gap-2">
        {rows.map((v) => {
          const needsBankVerification =
            !v.bankAccountVerifiedAt || Boolean(v.bankAccountChangedAt)
          const editingBank = bankVendorId === v.id
          const verifiedContacts = getVerifiedEmails(v.contactChannels)
          const editingContact = contactVendorId === v.id
          return (
            <li
              key={v.id}
              className="flex flex-col gap-3 rounded-lg border bg-card px-4 py-2 text-sm"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex flex-col">
                  <span className="font-medium">{v.name}</span>
                  <span className="text-muted-foreground text-xs">
                    {v.status} · {v.taxId ?? "no tax id"}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground text-xs">
                    {v.bankAccountChangedAt
                      ? "bank pending checker"
                      : needsBankVerification
                        ? "bank —"
                        : "bank ✓"}
                  </span>
                  {needsBankVerification ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={verify.isPending}
                      onClick={() => {
                        setBankVendorId(editingBank ? null : v.id)
                        setHolder(v.name)
                      }}
                    >
                      {editingBank
                        ? "Cancel"
                        : v.bankAccountChangedAt
                          ? "Check bank"
                          : "Add bank"}
                    </Button>
                  ) : null}
                </div>
              </div>

              <div className="flex flex-col gap-1.5 border-t pt-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium text-muted-foreground">
                    Verified messaging contacts ({verifiedContacts.length}):
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-xs"
                    disabled={
                      v.status === "blacklisted" || verifyContact.isPending
                    }
                    onClick={() => {
                      setContactVendorId(editingContact ? null : v.id)
                      setContactEmail(v.email ?? "")
                      setContactEvidence("")
                    }}
                  >
                    {editingContact ? "Cancel" : "+ Add contact"}
                  </Button>
                </div>
                {verifiedContacts.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {verifiedContacts.map((cEmail) => (
                      <span
                        key={cEmail}
                        className="inline-flex items-center gap-1 rounded bg-secondary px-2 py-0.5 font-mono text-xs"
                      >
                        {cEmail}
                        <button
                          type="button"
                          className="ml-1 text-muted-foreground hover:text-destructive"
                          title={`Revoke ${cEmail}`}
                          disabled={revokeContact.isPending}
                          onClick={() => doRevokeContact(v.id, cEmail)}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-muted-foreground text-xs italic">
                    No verified contacts (outbound messaging blocked)
                  </p>
                )}
              </div>

              {editingContact ? (
                <FieldGroup className="flex-row flex-wrap items-end gap-2 rounded-md border border-dashed p-3">
                  <Field>
                    <FieldLabel htmlFor={`contact-email-${v.id}`}>
                      Email
                    </FieldLabel>
                    <Input
                      id={`contact-email-${v.id}`}
                      type="email"
                      value={contactEmail}
                      onChange={(e) => setContactEmail(e.target.value)}
                      placeholder="ap@vendor.example"
                      className="h-9 w-52"
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor={`contact-evidence-${v.id}`}>
                      Verification evidence
                    </FieldLabel>
                    <Input
                      id={`contact-evidence-${v.id}`}
                      value={contactEvidence}
                      onChange={(e) => setContactEvidence(e.target.value)}
                      placeholder="Signed vendor master form"
                      className="h-9 w-64"
                    />
                    <FieldDescription>
                      At least 5 characters required.
                    </FieldDescription>
                  </Field>
                  <Button
                    size="sm"
                    disabled={
                      verifyContact.isPending ||
                      !contactEmail.trim() ||
                      contactEvidence.trim().length < 5
                    }
                    onClick={() => doVerifyContact(v.id)}
                  >
                    Verify contact
                  </Button>
                </FieldGroup>
              ) : null}

              {editingBank ? (
                <FieldGroup className="flex-row flex-wrap items-end gap-2 rounded-md border border-dashed p-3">
                  <Field>
                    <FieldLabel htmlFor={`bank-${v.id}`}>Bank</FieldLabel>
                    <Input
                      id={`bank-${v.id}`}
                      value={bank}
                      onChange={(e) => setBank(e.target.value)}
                      placeholder="BDO"
                      className="h-9 w-36"
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor={`account-${v.id}`}>
                      Account number
                    </FieldLabel>
                    <Input
                      id={`account-${v.id}`}
                      value={accountNumber}
                      onChange={(e) => setAccountNumber(e.target.value)}
                      placeholder="001234567890"
                      className="h-9 w-44"
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor={`holder-${v.id}`}>Holder</FieldLabel>
                    <Input
                      id={`holder-${v.id}`}
                      value={holder}
                      onChange={(e) => setHolder(e.target.value)}
                      placeholder={v.name}
                      className="h-9 w-56"
                    />
                  </Field>
                  <FieldDescription className="basis-full">
                    Enter the details independently. Submission and verification
                    must be performed by different finance users.
                  </FieldDescription>
                  <Button
                    size="sm"
                    disabled={
                      verify.isPending ||
                      !bank.trim() ||
                      !accountNumber.trim() ||
                      !holder.trim()
                    }
                    onClick={() => verifyBank(v.id)}
                  >
                    {v.bankAccountChangedAt
                      ? "Verify matching account"
                      : "Submit account"}
                  </Button>
                </FieldGroup>
              ) : null}
            </li>
          )
        })}
      </ul>

      {totalPages > 1 ? (
        <div className="mt-2 flex justify-start">
          <PageControls
            page={page}
            totalPages={totalPages}
            onPageChange={setPage}
          />
        </div>
      ) : null}
    </section>
  )
}
