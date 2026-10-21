"use client"

import { authClient } from "@workspace/auth/client"
import { useRouter } from "next/navigation"
import { useEffect } from "react"
import { SignInCard } from "@/components/sign-in"

/**
 * The dedicated sign-in page, following the shadcn `login-01` block.
 *
 * The desks also render the same way in when there is no session; this route
 * gives it a URL of its own (for a bookmark, an email link, or an SSO
 * return) and hands over to the workspace once the session exists.
 */
export default function Page() {
  const { data: session } = authClient.useSession()
  const router = useRouter()

  useEffect(() => {
    if (session) router.replace("/")
  }, [session, router])

  return <SignInCard />
}
