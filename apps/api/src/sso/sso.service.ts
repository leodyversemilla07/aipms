import { Injectable } from '@nestjs/common'
import { TRPCError } from '@trpc/server'
import { auth } from '@workspace/auth'
import { db } from '@workspace/db'
import { fromNodeHeaders } from 'better-auth/node'
import type { AuthedTrpcContext } from '../trpc/context.types'

/**
 * §16.2 enterprise identity — instance-level SSO configuration. The org's
 * IdP (OIDC/SAML) is registered here for sign-in; SCIM tokens let the IdP
 * provision users. Raw better-auth management paths are disabled at the HTTP
 * layer (see packages/auth), so this admin-gated tRPC surface is the only way
 * to mutate providers — every change lands in the audit trail.
 */

export interface SsoProviderView {
  providerId: string
  issuer: string
  domain: string
  type: 'oidc' | 'saml'
  createdBy: string
}

export interface ScimConnectionView {
  providerId: string
  maskedToken: string
}

@Injectable()
export class SsoService {
  async listProviders(): Promise<SsoProviderView[]> {
    const rows = await db.ssoProvider.findMany({
      orderBy: { providerId: 'asc' },
    })
    return rows.map((row) => ({
      providerId: row.providerId,
      issuer: row.issuer,
      domain: row.domain,
      type: row.samlConfig ? 'saml' : 'oidc',
      createdBy: row.userId,
    }))
  }

  /**
   * Delegates to better-auth's registerSSOProvider (validates/discovery-checks
   * the config, stamps the creator). Secrets never round-trip through the
   * client afterwards — list views are sanitized.
   */
  async registerProvider(
    ctx: AuthedTrpcContext,
    input: {
      providerId: string
      issuer: string
      domain: string
      oidcConfig?: {
        clientId: string
        clientSecret: string
        discoveryEndpoint?: string
        scopes?: string[]
        /** Air-gapped registrations: manual endpoints instead of discovery. */
        skipDiscovery?: boolean
        authorizationEndpoint?: string
        tokenEndpoint?: string
        jwksEndpoint?: string
      }
      samlConfig?: {
        idpMetadata?: string
        entryPoint?: string
        cert?: string
      }
    },
  ): Promise<SsoProviderView> {
    // better-auth's TS surface types samlConfig in its hydrated (post-plugin)
    // shape; registration accepts the partial form and fills defaults
    // (callbackUrl, spMetadata) itself.
    type RegisterBody = Parameters<
      typeof auth.api.registerSSOProvider
    >[0] extends infer Opts
      ? Opts extends { body: infer B }
        ? B
        : never
      : never

    const provider = await auth.api.registerSSOProvider({
      body: {
        providerId: input.providerId,
        issuer: input.issuer,
        domain: input.domain,
        ...(input.oidcConfig ? { oidcConfig: input.oidcConfig } : {}),
        ...(input.samlConfig
          ? { samlConfig: input.samlConfig as Record<string, unknown> }
          : {}),
      } as RegisterBody,
      headers: this.requestHeaders(ctx),
    })

    return {
      providerId: provider.providerId,
      issuer: provider.issuer,
      domain: provider.domain,
      type: input.samlConfig ? 'saml' : 'oidc',
      createdBy: ctx.user.id,
    }
  }

  /** Mirrors better-auth's deleteSSOProvider: drop linked accounts, then the provider. */
  async deleteProvider(providerId: string): Promise<void> {
    const provider = await db.ssoProvider.findUnique({ where: { providerId } })
    if (!provider) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: `Unknown SSO provider: ${providerId}`,
      })
    }
    await db.$transaction([
      db.account.deleteMany({ where: { providerId } }),
      db.ssoProvider.delete({ where: { providerId } }),
    ])
  }

  async listScimConnections(): Promise<ScimConnectionView[]> {
    const rows = await db.scimProvider.findMany({
      orderBy: { providerId: 'asc' },
    })
    return rows.map((row) => ({
      providerId: row.providerId,
      maskedToken: `${row.scimToken.slice(0, 6)}…${row.scimToken.slice(-4)}`,
    }))
  }

  /** Mints the bearer credential the org's IdP presents to /api/auth/scim/v2/*. */
  async generateScimToken(
    ctx: AuthedTrpcContext,
    providerId: string,
  ): Promise<{ providerId: string; scimToken: string }> {
    const result = await auth.api.generateSCIMToken({
      body: { providerId },
      headers: this.requestHeaders(ctx),
    })
    return { providerId, scimToken: result.scimToken }
  }

  /**
   * §10 — identity administration is human-admin-only by construction: agent
   * principals are scope-governed and must never hold the keys to identity.
   */
  static assertAdmin(ctx: AuthedTrpcContext, action: string): void {
    if (ctx.actorKind !== 'human' || ctx.user.role !== 'admin') {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: `${action} requires a human admin`,
      })
    }
  }

  private requestHeaders(ctx: AuthedTrpcContext) {
    if (!ctx.req) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'SSO management requires an authenticated browser session',
      })
    }
    return fromNodeHeaders(ctx.req.headers)
  }
}
