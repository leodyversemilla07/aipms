"use client"

import { useQueryClient } from "@tanstack/react-query"
import { authClient } from "@workspace/auth/client"
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
    <button
      type="button"
      disabled={pending}
      onClick={signOut}
      className="text-muted-foreground underline hover:text-foreground disabled:cursor-wait disabled:opacity-60"
    >
      {pending ? "Signing out…" : "Sign out"}
    </button>
  )
}
