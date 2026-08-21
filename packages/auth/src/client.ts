import { scimClient } from "@better-auth/scim/client"
import { ssoClient } from "@better-auth/sso/client"
import { createAuthClient } from "better-auth/react"

export const authClient = createAuthClient({
  baseURL: typeof window === "undefined" ? undefined : window.location.origin,
  plugins: [ssoClient(), scimClient()],
})

export const { getSession, signIn, signOut, signUp, useSession } = authClient

export type AuthClient = typeof authClient
