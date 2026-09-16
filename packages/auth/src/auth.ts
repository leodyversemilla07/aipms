import "@workspace/env/load"

import { createHash } from "node:crypto"
import { scim } from "@better-auth/scim"
import { sso } from "@better-auth/sso"
import { db } from "@workspace/db"
import { type BetterAuthOptions, betterAuth } from "better-auth"
import { prismaAdapter } from "better-auth/adapters/prisma"
import { AUTH_COOKIE_PREFIX } from "./cookies"
import { env } from "./env"

const socialProviders: NonNullable<BetterAuthOptions["socialProviders"]> = {}

if (env.google) {
  socialProviders.google = { ...env.google, disableSignUp: true }
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
    // SCIM resource reconciliation must be atomic across identity records.
    transaction: true,
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

  // Enrollment belongs to organization SSO/SCIM or trusted server-side
  // provisioning. HTTP signup is closed; auth.api.signUpEmail remains
  // available to the non-production demo seeder and provisioning scripts.
  disabledPaths: [...SSO_MANAGEMENT_PATHS, "/sign-up/email"],

  plugins: [
    sso({
      // §16.2 — SSO-provisioned humans land with the schema defaults
      // (kind=human, role=user); admins promote roles in-app.
      disableImplicitSignUp: false,
    }),
    scim({
      connections: [],
      // Keep connection administration in AIPMS while letting the hardened
      // SCIM 1.7 engine own resource isolation and provisioning semantics.
      authentication: {
        async verifyBearerToken({ token }) {
          const digest = createHash("sha256").update(token).digest("base64url")
          const storedToken = `sha256:${digest}:${token.slice(-4)}`
          const connection = await db.scimProvider.findFirst({
            // Accept a legacy clear-text credential once, then replace it with
            // its digest so database disclosure cannot reveal bearer tokens.
            // A stored digest can never itself be replayed as a bearer token.
            where: {
              scimToken: {
                in: token.startsWith("sha256:")
                  ? [storedToken]
                  : [storedToken, token],
              },
            },
          })
          if (!connection) return null
          if (connection.scimToken !== storedToken) {
            await db.scimProvider.update({
              where: { id: connection.id },
              data: { scimToken: storedToken },
            })
          }
          return {
            connection: {
              id: connection.providerId,
              provisioningDomainId:
                connection.organizationId ?? connection.providerId,
            },
            credentialId: connection.id,
            scopes: [
              "scim.users.read",
              "scim.users.write",
              "scim.groups.read",
              "scim.groups.write",
            ],
          }
        },
      },
    }),
  ],
})

export type Auth = typeof auth
export type Session = typeof auth.$Infer.Session
export type SessionUser = Session["user"]
