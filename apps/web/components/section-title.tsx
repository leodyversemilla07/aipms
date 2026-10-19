import type { ReactNode } from "react"

/**
 * Page-level section heading.
 *
 * One language for every block on a page: the desk title (h1) belongs to
 * `PageHeader`, and the sections underneath it use this heading. Panels that
 * own their heading row accept it as a node, so the page keeps a single
 * hierarchy instead of mixing sizes.
 */
export function SectionTitle({
  title,
  description,
  id,
  action,
}: {
  title: string
  description?: string
  /** Anchor target for deep links into the section. */
  id?: string
  /** Slot for status badges and controls that belong beside the title. */
  action?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <h2
        id={id}
        className="scroll-mt-6 font-heading font-semibold text-xl tracking-tight"
      >
        {title}
      </h2>
      {action}
      {description ? (
        <span className="text-muted-foreground text-sm">{description}</span>
      ) : null}
    </div>
  )
}
