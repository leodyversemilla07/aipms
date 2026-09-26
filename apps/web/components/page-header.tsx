import {
  Card,
  CardAction,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import type { ReactNode } from "react"

/** Desk-specific page heading; the sidebar inset contains only navigation. */
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
    <Card>
      <CardHeader>
        <CardTitle>
          <h1 className="font-heading font-semibold text-2xl tracking-tight">
            {title}
          </h1>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
        {action ? <CardAction>{action}</CardAction> : null}
      </CardHeader>
    </Card>
  )
}
