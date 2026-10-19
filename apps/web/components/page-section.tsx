import type { ReactNode } from "react"
import { SectionTitle } from "@/components/section-title"

/**
 * A page section: heading plus content.
 *
 * Used by the pages for the blocks they own. Panels that render their own
 * heading row take the heading as a node instead (see `SectionTitle`), so a
 * page reads as one flat sequence of titled sections.
 */
export function PageSection({
  title,
  description,
  titleId,
  action,
  children,
}: {
  title: string
  description?: string
  /** Id of the heading element; also labels the section region. */
  titleId?: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-4">
      <SectionTitle
        id={titleId}
        title={title}
        description={description}
        action={action}
      />
      {children}
    </section>
  )
}
