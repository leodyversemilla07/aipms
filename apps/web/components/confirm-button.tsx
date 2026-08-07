"use client"

import { Button } from "@workspace/ui/components/button"
import { type ComponentProps, useState } from "react"

type Props = Omit<ComponentProps<typeof Button>, "onClick"> & {
  message: string
  onConfirm: () => void
}

/**
 * Two-step destructive button: first click arms ("<message>"), a second click
 * within 3s runs onConfirm, otherwise it resets. Prevents accidental drops,
 * cancels, deactivations, and voids.
 */
export function ConfirmButton({
  message,
  onConfirm,
  children,
  ...rest
}: Props) {
  const [armed, setArmed] = useState(false)

  function fire() {
    if (armed) {
      setArmed(false)
      onConfirm()
    } else {
      setArmed(true)
      window.setTimeout(() => setArmed(false), 3000)
    }
  }

  return (
    <Button
      {...rest}
      variant={armed ? "destructive" : "outline"}
      onClick={fire}
    >
      {armed ? message : children}
    </Button>
  )
}
