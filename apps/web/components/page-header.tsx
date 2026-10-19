import type { ReactNode } from "react"

/**
 * Page heading: a flat title block on the content edge.
 *
 * The sidebar inset contains only navigation, and every page uses the same
 * title treatment - so the title, its description and the page sections below
 * share one left edge and one vertical rhythm.
 */
export function PageHeader({
  title,
  description,
  action,
}: {
  title: string
  description: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex flex-col gap-1">
        <h1 className="font-heading font-semibold text-2xl tracking-tight">
          {title}
        </h1>
        <p className="text-muted-foreground text-sm">{description}</p>
      </div>
      {action}
    </div>
  )
}
