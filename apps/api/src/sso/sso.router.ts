import { Inject } from '@nestjs/common'
import {
  Ctx,
  Input,
  Mutation,
  Query,
  Router,
  UseMiddlewares,
} from 'nestjs-trpc'
import { z } from 'zod'
import { AuditService } from '../shared/audit/audit.service'
import type { AuthedTrpcContext } from '../trpc/context.types'
import { AuthMiddleware } from '../trpc/middlewares/auth.middleware'
import { SsoService } from './sso.service'

const oidcConfigInput = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  discoveryEndpoint: z.string().url().optional(),
  scopes: z.array(z.string().min(1)).optional(),
  // Air-gapped registrations: manual endpoints instead of discovery fetch.
  skipDiscovery: z.boolean().optional(),
  authorizationEndpoint: z.string().url().optional(),
  tokenEndpoint: z.string().url().optional(),
  jwksEndpoint: z.string().url().optional(),
})

const samlConfigInput = z.object({
  idpMetadata: z.string().min(1).optional(),
  entryPoint: z.string().url().optional(),
  cert: z.string().min(1).optional(),
})

const registerProviderInput = z
  .object({
    providerId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase slug'),
    issuer: z.string().url(),
    domain: z.string().min(3).max(253),
    oidcConfig: oidcConfigInput.optional(),
    samlConfig: samlConfigInput.optional(),
  })
  .refine((v) => v.oidcConfig || v.samlConfig, {
    message: 'oidcConfig or samlConfig is required',
  })

const deleteProviderInput = z.object({ providerId: z.string().min(1) })

const generateScimTokenInput = z.object({
  providerId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase slug'),
})

@Router({ alias: 'sso' })
@UseMiddlewares(AuthMiddleware)
export class SsoRouter {
  constructor(
    @Inject(SsoService) private readonly sso: SsoService,
    @Inject(AuditService) private readonly auditService: AuditService,
  ) {}

  @Query()
  listProviders() {
    return this.sso.listProviders()
  }

  @Query()
  listScimConnections() {
    return this.sso.listScimConnections()
  }

  @Mutation({ input: registerProviderInput })
  async registerProvider(
    @Input() input: z.infer<typeof registerProviderInput>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    SsoService.assertAdmin(ctx, 'sso.registerProvider')
    const provider = await this.sso.registerProvider(ctx, input)
    await this.auditService.record({
      actorId: ctx.user.id,
      actorKind: ctx.actorKind,
      action: 'sso.provider.register',
      entity: 'SsoProvider',
      entityId: provider.providerId,
      input: {
        issuer: input.issuer,
        domain: input.domain,
        type: input.samlConfig ? 'saml' : 'oidc',
      },
    })
    return provider
  }

  @Mutation({ input: deleteProviderInput })
  async deleteProvider(
    @Input() input: z.infer<typeof deleteProviderInput>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    SsoService.assertAdmin(ctx, 'sso.deleteProvider')
    await this.sso.deleteProvider(input.providerId)
    await this.auditService.record({
      actorId: ctx.user.id,
      actorKind: ctx.actorKind,
      action: 'sso.provider.delete',
      entity: 'SsoProvider',
      entityId: input.providerId,
    })
    return { ok: true as const }
  }

  @Mutation({ input: generateScimTokenInput })
  async generateScimToken(
    @Input() input: z.infer<typeof generateScimTokenInput>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    SsoService.assertAdmin(ctx, 'sso.generateScimToken')
    const result = await this.sso.generateScimToken(ctx, input.providerId)
    await this.auditService.record({
      actorId: ctx.user.id,
      actorKind: ctx.actorKind,
      action: 'sso.scim.token.generate',
      entity: 'ScimProvider',
      entityId: result.providerId,
    })
    return result
  }
}
