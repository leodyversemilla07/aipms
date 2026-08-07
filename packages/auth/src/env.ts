import "@workspace/env/load"

const DEFAULT_PARENT_URL = "http://localhost:3000"

/** The public origin of the app (Next.js web). */
const parentUrl = optional("APP_URL") ?? DEFAULT_PARENT_URL
/** The origin that serves `/api/auth/*` (the web app or a dedicated API). */
const apiUrl = optional("BETTER_AUTH_URL") ?? optional("API_URL") ?? parentUrl

const trustedOrigins = new Set([
  parentUrl,
  apiUrl,
  ...(optional("AUTH_TRUSTED_ORIGINS") ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
])

export const env = {
  apiUrl,
  appUrl: parentUrl,
  trustedOrigins: [...trustedOrigins],
  isProduction: process.env.NODE_ENV === "production",
  cookieDomain: optional("AUTH_COOKIE_DOMAIN"),
  google: googleCredentials(),
} as const

export function isGoogleConfigured(): boolean {
  return env.google !== undefined
}

function googleCredentials():
  | { clientId: string; clientSecret: string }
  | undefined {
  const clientId = optional("GOOGLE_CLIENT_ID")
  const clientSecret = optional("GOOGLE_CLIENT_SECRET")

  if (!clientId || !clientSecret) {
    if (clientId || clientSecret) {
      throw new Error(
        "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together."
      )
    }
    return undefined
  }

  return { clientId, clientSecret }
}

function optional(key: string): string | undefined {
  const value = process.env[key]
  return value && value.length > 0 ? value : undefined
}
