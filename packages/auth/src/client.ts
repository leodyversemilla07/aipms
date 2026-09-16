import { ssoClient } from "@better-auth/sso/client"
import { createAuthClient } from "better-auth/react"

export const authClient = createAuthClient({
  baseURL: typeof window === "undefined" ? undefined : window.location.origin,
  // SCIM is an inbound server protocol; browser clients only need SSO.
  plugins: [ssoClient()],
})

export const { getSession, signIn, signOut, signUp, useSession } = authClient

export type AuthClient = typeof authClient
