import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@workspace/ui/components/empty"
import { cn } from "@workspace/ui/lib/utils"
import type { LucideIcon } from "lucide-react"
import type { ReactNode } from "react"

/**
 * The empty state: a panel that has nothing to show.
 *
 * One shape for every desk, built on the shadcn `empty` component so the
 * wording, the icon treatment and the spacing are the same wherever a list
 * comes back empty.
 */
export interface EmptyStateProps {
  /** What is missing, in the reader's terms. */
  title: string
  /** What to do next, or why it is empty. */
  description?: string
  /** An optional icon; the default treatment is a muted icon tile. */
  icon?: LucideIcon
  /** An action, such as a link to the desk that fills this. */
  action?: ReactNode
  className?: string
}

export function EmptyState({
  title,
  description,
  icon: Icon,
  action,
  className,
}: EmptyStateProps) {
  return (
    <Empty className={cn("border py-8", className)}>
      <EmptyHeader>
        {Icon ? (
          <EmptyMedia variant="icon">
            <Icon aria-hidden="true" />
          </EmptyMedia>
        ) : null}
        <EmptyTitle>{title}</EmptyTitle>
        {description ? (
          <EmptyDescription>{description}</EmptyDescription>
        ) : null}
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </Empty>
  )
}
