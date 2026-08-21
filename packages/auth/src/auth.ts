import "@workspace/env/load"

import { scim } from "@better-auth/scim"
import { sso } from "@better-auth/sso"
import { db } from "@workspace/db"
import { type BetterAuthOptions, betterAuth } from "better-auth"
import { prismaAdapter } from "better-auth/adapters/prisma"
import { AUTH_COOKIE_PREFIX } from "./cookies"
import { env } from "./env"

const socialProviders: NonNullable<BetterAuthOptions["socialProviders"]> = {}

if (env.google) {
  socialProviders.google = { ...env.google }
}

/**
 * §16.2 enterprise identity — IdP connections are instance configuration, so
 * their management surface is the api's admin-gated tRPC router (which calls
 * `auth.api` server-side). The raw better-auth HTTP paths are disabled: any
 * authenticated session could otherwise register a provider or mint SCIM
 * tokens (the plugin only enforces session, not role). Sign-in flows
 * (/sign-in/sso, /sso/callback/*) stay public.
 */
const SSO_MANAGEMENT_PATHS = [
  "/sso/register",
  "/sso/update-provider",
  "/sso/delete-provider",
  "/scim/generate-token",
  "/scim/delete-provider-connection",
]

export const auth = betterAuth({
  appName: "aipms",

  baseURL: env.apiUrl,

  database: prismaAdapter(db, {
    provider: "postgresql",
  }),

  emailAndPassword: {
    enabled: true,
  },

  socialProviders,

  account: {
    accountLinking: {
      enabled: true,
      trustedProviders: ["google"],
    },
  },

  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60,
    },
  },

  rateLimit: {
    enabled: true,
    storage: "database",
  },

  advanced: {
    cookiePrefix: AUTH_COOKIE_PREFIX,

    useSecureCookies: env.isProduction,
    ...(env.cookieDomain && {
      crossSubDomainCookies: {
        enabled: true,
        domain: env.cookieDomain,
      },
    }),
  },

  trustedOrigins: [...env.trustedOrigins],

  disabledPaths: SSO_MANAGEMENT_PATHS,

  plugins: [
    sso({
      // §16.2 — SSO-provisioned humans land with the schema defaults
      // (kind=human, role=user); admins promote roles in-app.
      disableImplicitSignUp: false,
    }),
    scim(),
  ],
})

export type Auth = typeof auth
export type Session = typeof auth.$Infer.Session
export type SessionUser = Session["user"]
