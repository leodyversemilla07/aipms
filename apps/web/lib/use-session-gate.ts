"use client"

import { authClient } from "@workspace/auth/client"
import { useEffect, useState } from "react"

/**
 * The session query, with a "checking" flag that covers only the first answer.
 *
 * better-auth re-checks the session whenever the window becomes visible again
 * (its client refetches on `visibilitychange`). A signed-out session has no
 * data, so that background check reports `isPending` again even though the
 * answer is still "signed out" - and a view that trusts `isPending` swaps the
 * way in for the pending card, unmounting the form and throwing away the
 * email the reader had typed (switching to the terminal and back was enough).
 *
 * `isChecking` stays true only until the first answer lands. Later checks
 * leave the mounted view alone; a session that resolves still hands over to
 * the workspace through the caller's redirect.
 */
export function useSessionGate() {
  const { data: session, isPending } = authClient.useSession()
  const [settled, setSettled] = useState(false)

  useEffect(() => {
    if (!isPending) setSettled(true)
  }, [isPending])

  return { session, isChecking: isPending && !settled }
}
