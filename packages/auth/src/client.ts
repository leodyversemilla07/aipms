import { createAuthClient } from "better-auth/react"

export const authClient = createAuthClient({
  baseURL: typeof window === "undefined" ? undefined : window.location.origin,
  plugins: [],
})

export const { getSession, signIn, signOut, signUp, useSession } = authClient

export type AuthClient = typeof authClient
