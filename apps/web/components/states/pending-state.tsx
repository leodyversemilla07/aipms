import { Skeleton } from "@workspace/ui/components/skeleton"
import { Spinner } from "@workspace/ui/components/spinner"
import { cn } from "@workspace/ui/lib/utils"

/**
 * The pending state: content that is still loading.
 *
 * A block that is loading shows placeholder rows, so the page keeps its
 * shape instead of collapsing and jumping when the data arrives.
 */
export interface PendingStateProps {
  /** What is loading, announced to assistive technology. */
  label?: string
  /** How many placeholder rows to draw. */
  rows?: number
  className?: string
}

export function PendingState({
  label = "Loading",
  rows = 3,
  className,
}: PendingStateProps) {
  return (
    <div
      role="status"
      aria-label={label}
      className={cn("flex flex-col gap-2", className)}
    >
      {Array.from({ length: rows }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the rows are placeholders.
        <Skeleton key={index} className="h-10 w-full" />
      ))}
    </div>
  )
}

/**
 * A card that is still loading: a heading and two lines of placeholder.
 *
 * Used where a whole card is fetched before anything can be drawn.
 */
export function PendingCard({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="flex flex-col gap-2">
      <Skeleton className="h-5 w-32" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-full" />
    </div>
  )
}

/**
 * The inline pending state: a single value that is still being computed.
 *
 * Used where a number or a label is expected and the rest of the panel is
 * already on screen.
 */
export function PendingLabel({
  label,
  className,
}: {
  label: string
  className?: string
}) {
  return (
    <span
      role="status"
      aria-label={label}
      className={cn(
        "inline-flex items-center gap-2 text-muted-foreground text-sm",
        className
      )}
    >
      <Spinner className="size-3.5" aria-hidden="true" />
      {label}
    </span>
  )
}
