import "@workspace/env/load"

import { db } from "@workspace/db"
import { type BetterAuthOptions, betterAuth } from "better-auth"
import { prismaAdapter } from "better-auth/adapters/prisma"
import { AUTH_COOKIE_PREFIX } from "./cookies"
import { env } from "./env"

const socialProviders: NonNullable<BetterAuthOptions["socialProviders"]> = {}

if (env.google) {
  socialProviders.google = { ...env.google }
}

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

  plugins: [],
})

export type Auth = typeof auth
export type Session = typeof auth.$Infer.Session
export type SessionUser = Session["user"]
