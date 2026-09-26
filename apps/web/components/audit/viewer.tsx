"use client"

import { useQuery } from "@tanstack/react-query"
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@workspace/ui/components/alert"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@workspace/ui/components/empty"
import { Input } from "@workspace/ui/components/input"
import {
  NativeSelect,
  NativeSelectOption,
} from "@workspace/ui/components/native-select"
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
} from "@workspace/ui/components/pagination"
import { Skeleton } from "@workspace/ui/components/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"
import { Fragment, useEffect, useState } from "react"
import { fmtTime } from "@/lib/time"
import { useTRPC } from "@/lib/trpc/client"

const PAGE_SIZE = 25

type AudRow = {
  id: string
  actorId: string
  actorKind: string
  action: string
  entity: string
  entityId: string | null
  inputHash: string | null
  at: string | Date
}

function PageControls({
  page,
  totalPages,
  onPageChange,
}: {
  page: number
  totalPages: number
  onPageChange: (page: number) => void
}) {
  const pages = [...new Set([1, page - 1, page, page + 1, totalPages])]
    .filter((value) => value >= 1 && value <= totalPages)
    .sort((a, b) => a - b)

  return (
    <Pagination className="mx-0 w-auto justify-start">
      <PaginationContent>
        <PaginationItem>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={page === 1}
            onClick={() => onPageChange(page - 1)}
          >
            Previous
          </Button>
        </PaginationItem>
        {pages.map((number, index) => (
          <Fragment key={number}>
            {index > 0 && number - (pages[index - 1] ?? 0) > 1 ? (
              <PaginationItem>
                <PaginationEllipsis />
              </PaginationItem>
            ) : null}
            <PaginationItem>
              <Button
                type="button"
                variant={number === page ? "outline" : "ghost"}
                size="icon-sm"
                aria-label={`Go to page ${number}`}
                aria-current={number === page ? "page" : undefined}
                onClick={() => onPageChange(number)}
              >
                {number}
              </Button>
            </PaginationItem>
          </Fragment>
        ))}
        <PaginationItem>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={page === totalPages}
            onClick={() => onPageChange(page + 1)}
          >
            Next
          </Button>
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  )
}

/** Read-only, server-paginated view of the immutable audit trail. */
export function AuditViewer() {
  const trpc = useTRPC()
  const [q, setQ] = useState("")
  const [entity, setEntity] = useState("")
  const [action, setAction] = useState("")
  const [page, setPage] = useState(1)

  const meta = useQuery(trpc.audit.meta.queryOptions())
  const chain = useQuery(trpc.audit.chain.queryOptions())
  const feed = useQuery(
    trpc.audit.list.queryOptions({
      q,
      page,
      pageSize: PAGE_SIZE,
      entity: entity || undefined,
      action: action || undefined,
    })
  )
  const rows = (feed.data?.rows ?? []) as AudRow[]
  const total = feed.data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  // An external writer can remove results from a filtered page between reads.
  useEffect(() => {
    if (feed.data && page > totalPages) setPage(totalPages)
  }, [feed.data, page, totalPages])

  return (
    <section aria-label="Audit entries" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={q}
          onChange={(event) => {
            setQ(event.target.value)
            setPage(1)
          }}
          aria-label="Search audit entries"
          placeholder="Search action, entity or actor…"
          className="min-w-52 flex-1"
        />
        <NativeSelect
          aria-label="Filter by entity"
          value={entity}
          onChange={(event) => {
            setEntity(event.target.value)
            setPage(1)
          }}
        >
          <NativeSelectOption value="">All entities</NativeSelectOption>
          {(meta.data?.entities ?? []).map((value) => (
            <NativeSelectOption key={value} value={value}>
              {value}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <NativeSelect
          aria-label="Filter by action"
          value={action}
          onChange={(event) => {
            setAction(event.target.value)
            setPage(1)
          }}
        >
          <NativeSelectOption value="">All actions</NativeSelectOption>
          {(meta.data?.actions ?? []).map((value) => (
            <NativeSelectOption key={value} value={value}>
              {value}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>

      {meta.isError ? (
        <Alert variant="destructive">
          <AlertTitle>Filters unavailable</AlertTitle>
          <AlertDescription>{meta.error.message}</AlertDescription>
        </Alert>
      ) : null}

      {chain.isError ? (
        <Alert variant="destructive">
          <AlertTitle>Could not verify audit chain</AlertTitle>
          <AlertDescription>{chain.error.message}</AlertDescription>
        </Alert>
      ) : chain.data ? (
        <Alert variant={chain.data.ok ? "default" : "destructive"}>
          <AlertTitle>
            {chain.data.ok ? "Chain intact" : "Chain integrity warning"}
          </AlertTitle>
          <AlertDescription>
            {chain.data.ok
              ? `${chain.data.checked} hashed entries verified${chain.data.legacy > 0 ? ` · ${chain.data.legacy} legacy entries predate the chain` : ""}`
              : `Broken at seq ${chain.data.brokenAtSeq}: ${chain.data.reason}`}
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Entries</CardTitle>
          <CardDescription>
            {feed.data
              ? `${total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, total)} of ${total} entries · newest first`
              : "Newest entries first"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {feed.isPending ? (
            <div
              role="status"
              aria-label="Loading audit entries"
              className="flex flex-col gap-2"
            >
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : feed.isError ? (
            <Alert variant="destructive">
              <AlertTitle>Could not load audit entries</AlertTitle>
              <AlertDescription>{feed.error.message}</AlertDescription>
            </Alert>
          ) : rows.length === 0 ? (
            <Empty className="border py-8">
              <EmptyHeader>
                <EmptyTitle>No matching entries</EmptyTitle>
                <EmptyDescription>
                  Try another filter, or perform an action on a desk to record
                  one.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>Input hash</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="text-muted-foreground text-xs">
                      {fmtTime(row.at)}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Badge variant="outline">{row.actorKind}</Badge>
                        <span className="font-mono text-xs" title={row.actorId}>
                          {row.actorId.slice(0, 8)}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {row.action}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {row.entity}
                      {row.entityId ? `:${row.entityId.slice(0, 8)}` : ""}
                    </TableCell>
                    <TableCell
                      className="font-mono text-muted-foreground text-xs"
                      title={row.inputHash ?? undefined}
                    >
                      {row.inputHash
                        ? `sha256 ${row.inputHash.slice(0, 16)}…`
                        : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
        {feed.data && total > PAGE_SIZE ? (
          <CardFooter className="flex flex-wrap justify-between gap-3 border-t">
            <span className="text-muted-foreground text-sm" role="status">
              Page {page} of {totalPages}
            </span>
            <PageControls
              page={page}
              totalPages={totalPages}
              onPageChange={setPage}
            />
          </CardFooter>
        ) : null}
      </Card>
    </section>
  )
}
