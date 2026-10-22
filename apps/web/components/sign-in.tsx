"use client"

import { authClient } from "@workspace/auth/client"
import { useRouter } from "next/navigation"
import { useEffect } from "react"
import { LoginForm } from "@/components/login-form"
import { PendingCard } from "@/components/states/pending-state"

/**
 * The session check, drawn with the shared pending vocabulary.
 *
 * The way in and every desk wait on the same session query before they can
 * decide what to draw; showing the same shape keeps the first paint stable
 * while the answer is unknown.
 */
export function SessionPending() {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center bg-muted p-6 md:p-10">
      <div className="w-full max-w-sm">
        <PendingCard label="Checking your session" />
      </div>
    </div>
  )
}

/**
 * The way in, following the shadcn `login-01` block: the form centred on the
 * muted background.
 *
 * The session decides what the reader sees. A pending check draws the shared
 * loading state, a signed-in reader hands over to the workspace, and a signed
 * out reader gets the form. The desks render this same view when there is no
 * session, so the way in looks the same wherever a reader lands - and the
 * `/login` route renders it as the page's own way in.
 */
export function SignInCard() {
  const { data: session, isPending } = authClient.useSession()
  const router = useRouter()

  // Background session refetches must not unmount a partially filled sign-in
  // form; a resolved session hands over instead of leaving the reader on the
  // way in.
  useEffect(() => {
    if (session) router.replace("/")
  }, [session, router])

  if (isPending) {
    return <SessionPending />
  }

  return (
    <div className="flex min-h-svh flex-col items-center justify-center bg-muted p-6 md:p-10">
      {/* The block widens to max-w-4xl so the form can sit beside an image;
          this variant is the form alone, so the card keeps its own width. */}
      <div className="w-full max-w-sm">
        <LoginForm />
      </div>
    </div>
  )
}
