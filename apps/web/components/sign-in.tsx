"use client"

import { LoginForm } from "@/components/login-form"

/**
 * The signed-out view, following the shadcn `login-01` block: the form
 * centred on the muted background.
 *
 * Every desk renders this when there is no session, so the way in looks the
 * same wherever a reader lands.
 */
export function SignInCard() {
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
