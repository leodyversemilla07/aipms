import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@workspace/ui/components/alert"
import { cn } from "@workspace/ui/lib/utils"
import type { ReactNode } from "react"

/**
 * The failure state: a block that could not be loaded.
 *
 * Built on the shadcn `alert` component, so a failed read looks the same on
 * every desk - a titled, readable statement of what failed and why.
 */
export interface ErrorStateProps {
  /** What failed, in the reader's terms. */
  title?: string
  /** The reason, as the server gave it. */
  message: string
  className?: string
}

export function ErrorState({
  title = "Could not load this",
  message,
  className,
}: ErrorStateProps) {
  return (
    <Alert variant="destructive" className={className}>
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  )
}

/**
 * The inline failure state: an action that did not go through.
 *
 * Kept compact because it sits inside a form or a panel that is otherwise
 * intact.
 */
export function InlineError({
  message,
  className,
}: {
  message: ReactNode
  className?: string
}) {
  return (
    <p
      role="alert"
      className={cn(
        "rounded-md bg-destructive/10 px-3 py-2 text-destructive text-xs",
        className
      )}
    >
      {message}
    </p>
  )
}
