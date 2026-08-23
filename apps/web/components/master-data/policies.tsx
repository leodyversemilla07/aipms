"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Button } from "@workspace/ui/components/button"
import { type ReactNode, useState } from "react"
import { useTRPC } from "@/lib/trpc/client"

type PolicyRow = {
  id: string
  name: string
  kind: string
  enabled: boolean
  version: number
  config: unknown
}

const KINDS = [
  "threshold",
  "preferredVendor",
  "approvalChain",
  "budgetControl",
  "evaluationCriterion",
  "taxRule",
] as const

type PolicyKind = (typeof KINDS)[number]

/** Policy master — config-over-void; each kind's config is policy data. */
export function PoliciesPanel() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()

  const [kind, setKind] = useState<PolicyKind>("threshold")
  const [name, setName] = useState("")
  const [enabled, setEnabled] = useState(true)
  const [config, setConfig] = useState(
    JSON.stringify(
      { autoApproveUpTo: 100_000_00, budgetRequired: false },
      null,
      2
    )
  )
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const list = useQuery(trpc.policy.list.queryOptions({}))
  const rows = (list.data ?? []) as unknown as PolicyRow[]

  const create = useMutation(trpc.policy.create.mutationOptions())

  function refresh() {
    queryClient.invalidateQueries(trpc.policy.pathFilter())
  }

  async function doCreate() {
    setNotice(null)
    setError(null)
    let parsedConfig: Record<string, unknown>
    try {
      const parsed = JSON.parse(config)
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setError("Config must be a JSON object.")
        return
      }
      parsedConfig = parsed
    } catch {
      setError("Config is not valid JSON.")
      return
    }
    try {
      const policy = await create.mutateAsync({
        idempotencyKey: `web-policy-${crypto.randomUUID()}`,
        name,
        kind,
        enabled,
        config: parsedConfig,
      })
      setNotice(`Policy ${(policy as { name?: string }).name ?? ""} created`)
      setName("")
      refresh()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h2 className="font-semibold text-muted-foreground text-sm uppercase tracking-wide">
          Policies
        </h2>
        <span className="text-muted-foreground text-xs">{rows.length}</span>
      </div>

      <div className="flex flex-col gap-2 rounded-xl border bg-card p-4 shadow-sm">
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Kind">
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as PolicyKind)}
              className="h-9 rounded-md border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </Field>
          <label className="flex h-9 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="size-4"
            />
            enabled
          </label>
        </div>
        <textarea
          value={config}
          onChange={(e) => setConfig(e.target.value)}
          rows={4}
          spellCheck={false}
          className="w-full rounded-md border bg-background px-3 py-1 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
        />
        <div className="flex items-center gap-2">
          <p className="text-muted-foreground text-xs">
            config JSON — e.g. threshold:{" "}
            <code>{"{ autoApproveUpTo: <¢>, budgetRequired: false }"}</code>
          </p>
          <Button
            size="sm"
            className="ml-auto"
            disabled={!name.trim() || create.isPending}
            onClick={doCreate}
          >
            Create policy
          </Button>
        </div>
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
        {rows.map((p) => (
          <li
            key={p.id}
            className="flex items-center justify-between gap-2 rounded-lg border bg-card px-4 py-2 text-sm"
          >
            <div className="flex flex-col">
              <span className="font-medium">
                {p.kind} · {p.name}
              </span>
              <span className="font-mono text-muted-foreground text-xs">
                {JSON.stringify(p.config)}
              </span>
            </div>
            <span className="text-muted-foreground text-xs">
              v{p.version} {p.enabled ? "enabled" : "disabled"}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  // The wrapped control is a composite (Select), not a native input — a
  // plain group keeps the a11y contract honest.
  return (
    <div className="flex flex-col gap-1 text-sm">
      <span className="text-muted-foreground text-xs">{label}</span>
      {children}
    </div>
  )
}
