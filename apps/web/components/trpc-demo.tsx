"use client"

import { useQuery } from "@tanstack/react-query"
import { useTRPC } from "@/lib/trpc/client"

export function TrpcDemo() {
  const trpc = useTRPC()
  const me = useQuery(trpc.users.me.queryOptions())

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-4 font-mono text-xs">
      <p className="font-medium font-sans">tRPC · users.me</p>
      {me.isPending ? (
        <p className="text-muted-foreground">calling {"/api/trpc"}…</p>
      ) : me.isError ? (
        <p className="text-destructive">
          {me.error.data?.code} — make sure the API is running and you&apos;re
          signed in.
        </p>
      ) : (
        <p className="text-emerald-600">
          {me.data
            ? `signed in as ${me.data.name} (${me.data.email})`
            : "signed out"}
        </p>
      )}
    </div>
  )
}
