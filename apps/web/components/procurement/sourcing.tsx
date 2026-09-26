"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import { Checkbox } from "@workspace/ui/components/checkbox"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@workspace/ui/components/empty"
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import {
  NativeSelect,
  NativeSelectOption,
} from "@workspace/ui/components/native-select"
import { useEffect, useMemo, useState } from "react"
import { phpToMinor } from "@/lib/money"
import { useTRPC } from "@/lib/trpc/client"

type RequisitionRow = {
  id: string
  requestNumber: string
  status: string
}

type VendorRow = {
  id: string
  name: string
  status: string
}

type QuoteRow = {
  id: string
  vendorId: string
  status: "requested" | "received" | "accepted" | "rejected"
  totalMinor: number | null
  currencyCode: string
  leadTimeDays: number | null
  rejectedReason: string | null
}

function formatMoney(minor: number, currencyCode: string) {
  return new Intl.NumberFormat("en-PH", {
    style: "currency",
    currency: currencyCode,
  }).format(minor / 100)
}

export function Sourcing() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [requisitionId, setRequisitionId] = useState("")
  const [vendorIds, setVendorIds] = useState<Set<string>>(new Set())
  const [amounts, setAmounts] = useState<Record<string, string>>({})
  const [leadTimes, setLeadTimes] = useState<Record<string, string>>({})
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const requisitions = useQuery(
    trpc.requisition.list.queryOptions({ q: "", page: 1, pageSize: 100 })
  )
  const vendors = useQuery(
    trpc.vendor.list.queryOptions({ q: "", page: 1, pageSize: 100 })
  )
  const quotes = useQuery({
    ...trpc.sourcing.list.queryOptions({
      requisitionId: requisitionId || "disabled",
    }),
    enabled: Boolean(requisitionId),
  })
  const quoteRows = (quotes.data ?? []) as QuoteRow[]
  const hasReceived = quoteRows.some((quote) => quote.status === "received")
  const comparison = useQuery({
    ...trpc.sourcing.compare.queryOptions({
      requisitionId: requisitionId || "disabled",
    }),
    enabled: Boolean(requisitionId) && hasReceived,
  })

  const requestQuotes = useMutation(trpc.sourcing.request.mutationOptions())
  const receiveQuote = useMutation(trpc.sourcing.receive.mutationOptions())
  const awardQuote = useMutation(trpc.sourcing.award.mutationOptions())

  const approved = ((requisitions.data?.rows ?? []) as RequisitionRow[]).filter(
    (requisition) => requisition.status === "approved"
  )
  const activeVendors = ((vendors.data?.rows ?? []) as VendorRow[]).filter(
    (vendor) => vendor.status === "active"
  )
  const vendorNames = useMemo(
    () => new Map(activeVendors.map((vendor) => [vendor.id, vendor.name])),
    [activeVendors]
  )

  useEffect(() => {
    if (!approved.some((requisition) => requisition.id === requisitionId)) {
      setRequisitionId(approved[0]?.id ?? "")
    }
  }, [approved, requisitionId])

  function refresh() {
    queryClient.invalidateQueries(trpc.sourcing.pathFilter())
    queryClient.invalidateQueries(trpc.requisition.pathFilter())
  }

  function clearFeedback() {
    setNotice(null)
    setError(null)
  }

  async function openRequests() {
    clearFeedback()
    try {
      await requestQuotes.mutateAsync({
        requisitionId,
        vendorIds: [...vendorIds],
        idempotencyKey: `web-sourcing-request-${crypto.randomUUID()}`,
      })
      setNotice(
        "RFQ records opened. Use the approved messaging relay to send vendor invitations."
      )
      refresh()
    } catch (cause) {
      setError((cause as Error).message)
    }
  }

  async function recordOffer(quote: QuoteRow) {
    clearFeedback()
    const totalMinor = phpToMinor(amounts[quote.id] ?? "")
    if (!totalMinor || totalMinor <= 0) {
      setError("Enter a positive offer amount.")
      return
    }
    const leadTimeText = leadTimes[quote.id]?.trim()
    const leadTimeDays = leadTimeText ? Number(leadTimeText) : undefined
    if (
      leadTimeDays !== undefined &&
      (!Number.isInteger(leadTimeDays) || leadTimeDays <= 0)
    ) {
      setError("Lead time must be a positive whole number of days.")
      return
    }
    try {
      await receiveQuote.mutateAsync({
        id: quote.id,
        totalMinor,
        currencyCode: quote.currencyCode,
        leadTimeDays,
        idempotencyKey: `web-sourcing-receive-${crypto.randomUUID()}`,
      })
      setNotice("Structured vendor offer recorded.")
      refresh()
    } catch (cause) {
      setError((cause as Error).message)
    }
  }

  async function award(id: string) {
    clearFeedback()
    try {
      await awardQuote.mutateAsync({
        id,
        idempotencyKey: `web-sourcing-award-${crypto.randomUUID()}`,
      })
      setNotice(
        "Quote awarded; competing received offers were rejected atomically."
      )
      refresh()
    } catch (cause) {
      setError((cause as Error).message)
    }
  }

  const recommendedQuoteId = comparison.data?.recommendedQuoteId ?? null

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h2 className="font-semibold text-muted-foreground text-sm uppercase tracking-wide">
          Structured sourcing
        </h2>
        <span className="text-muted-foreground text-xs">
          {quoteRows.length} quote(s)
        </span>
      </div>

      {notice ? (
        <Alert>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Open requests for quote</CardTitle>
          <CardDescription>
            Select an approved requisition and one or more eligible vendors.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="sourcing-requisition">
                Requisition
              </FieldLabel>
              <NativeSelect
                id="sourcing-requisition"
                value={requisitionId}
                onChange={(event) => {
                  setRequisitionId(event.target.value)
                  setVendorIds(new Set())
                  clearFeedback()
                }}
              >
                <NativeSelectOption value="">
                  Select an approved requisition
                </NativeSelectOption>
                {approved.map((requisition) => (
                  <NativeSelectOption
                    key={requisition.id}
                    value={requisition.id}
                  >
                    {requisition.requestNumber}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <FieldSet>
              <FieldLegend variant="label">Vendors</FieldLegend>
              <FieldGroup data-slot="checkbox-group">
                {activeVendors.map((vendor) => (
                  <Field key={vendor.id} orientation="horizontal">
                    <Checkbox
                      id={`source-vendor-${vendor.id}`}
                      checked={vendorIds.has(vendor.id)}
                      onCheckedChange={(checked) =>
                        setVendorIds((current) => {
                          const next = new Set(current)
                          if (checked) next.add(vendor.id)
                          else next.delete(vendor.id)
                          return next
                        })
                      }
                    />
                    <FieldLabel htmlFor={`source-vendor-${vendor.id}`}>
                      {vendor.name}
                    </FieldLabel>
                  </Field>
                ))}
              </FieldGroup>
            </FieldSet>
          </FieldGroup>
        </CardContent>
        <CardFooter>
          <Button
            disabled={
              !requisitionId || vendorIds.size === 0 || requestQuotes.isPending
            }
            onClick={() => void openRequests()}
          >
            Open RFQs
          </Button>
        </CardFooter>
      </Card>

      {requisitionId && quoteRows.length === 0 && !quotes.isPending ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>No quote requests</EmptyTitle>
            <EmptyDescription>
              Select eligible vendors above to open structured RFQs.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}

      {quoteRows.map((quote) => {
        const recommended = quote.id === recommendedQuoteId
        return (
          <Card key={quote.id} size="sm">
            <CardHeader>
              <CardTitle>
                {vendorNames.get(quote.vendorId) ?? quote.vendorId.slice(-8)}
              </CardTitle>
              <CardDescription>
                {quote.status} · {quote.currencyCode}
                {quote.leadTimeDays
                  ? ` · ${quote.leadTimeDays} day lead time`
                  : ""}
              </CardDescription>
              {recommended ? (
                <CardAction>
                  <Badge>Recommended</Badge>
                </CardAction>
              ) : null}
            </CardHeader>
            <CardContent>
              {quote.totalMinor != null ? (
                <p className="font-mono text-sm">
                  {formatMoney(quote.totalMinor, quote.currencyCode)}
                </p>
              ) : (
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor={`quote-amount-${quote.id}`}>
                      Offer amount ({quote.currencyCode})
                    </FieldLabel>
                    <Input
                      id={`quote-amount-${quote.id}`}
                      inputMode="decimal"
                      placeholder="0.00"
                      value={amounts[quote.id] ?? ""}
                      onChange={(event) =>
                        setAmounts((current) => ({
                          ...current,
                          [quote.id]: event.target.value,
                        }))
                      }
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor={`quote-lead-${quote.id}`}>
                      Lead time (days, optional)
                    </FieldLabel>
                    <Input
                      id={`quote-lead-${quote.id}`}
                      inputMode="numeric"
                      value={leadTimes[quote.id] ?? ""}
                      onChange={(event) =>
                        setLeadTimes((current) => ({
                          ...current,
                          [quote.id]: event.target.value,
                        }))
                      }
                    />
                  </Field>
                </FieldGroup>
              )}
            </CardContent>
            <CardFooter className="flex gap-2">
              {quote.status === "requested" ? (
                <Button
                  size="sm"
                  disabled={receiveQuote.isPending}
                  onClick={() => void recordOffer(quote)}
                >
                  Record offer
                </Button>
              ) : null}
              {quote.status === "received" ? (
                <Button
                  size="sm"
                  disabled={awardQuote.isPending}
                  onClick={() => void award(quote.id)}
                >
                  Award quote
                </Button>
              ) : null}
              {quote.rejectedReason ? (
                <span className="text-muted-foreground text-xs">
                  {quote.rejectedReason}
                </span>
              ) : null}
            </CardFooter>
          </Card>
        )
      })}
    </section>
  )
}
