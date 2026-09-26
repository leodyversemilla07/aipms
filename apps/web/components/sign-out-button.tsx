"use client"

import { useQueryClient } from "@tanstack/react-query"
import { authClient } from "@workspace/auth/client"
import { Button } from "@workspace/ui/components/button"
import { LogOutIcon } from "lucide-react"
import { useRouter } from "next/navigation"
import { useState } from "react"

/**
 * End the browser session and remove all account-scoped query data before the
 * next user can render this client. The route refresh makes the server/client
 * session boundary re-evaluate immediately.
 */
export function SignOutButton() {
  const queryClient = useQueryClient()
  const router = useRouter()
  const [pending, setPending] = useState(false)

  async function signOut() {
    if (pending) return
    setPending(true)
    try {
      await authClient.signOut()
    } finally {
      queryClient.clear()
      router.replace("/")
      router.refresh()
      setPending(false)
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      title="Sign out"
      className="w-full justify-start group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:px-2"
      disabled={pending}
      onClick={signOut}
    >
      <LogOutIcon data-icon="inline-start" />
      <span className="group-data-[collapsible=icon]:sr-only">
        {pending ? "Signing out…" : "Sign out"}
      </span>
    </Button>
  )
}
