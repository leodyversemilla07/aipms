import { auth } from '@workspace/auth'
import { db } from '@workspace/db'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { SsoService } from '../src/sso/sso.service'
import type { AuthedTrpcContext } from '../src/trpc/context.types'

/**
 * §16.2 enterprise identity. The raw better-auth management paths must stay
 * disabled at the HTTP layer (any session could otherwise mint SCIM tokens);
 * the tRPC surface is human-admin-only and audited.
 */

const ADMIN_PATHS = [
  '/sso/register',
  '/sso/update-provider',
  '/sso/delete-provider',
  '/scim/generate-token',
  '/scim/delete-provider-connection',
]

function ctx(partial: {
  id?: string
  kind?: 'human' | 'agent'
  role?: 'admin' | 'user' | 'finance' | 'procurement'
  req?: AuthedTrpcContext['req']
}): AuthedTrpcContext {
  const id = partial.id ?? 'user-1'
  return {
    req: partial.req,
    session: null,
    user: {
      id,
      name: 'Test User',
      email: `${id}@test.local`,
      emailVerified: true,
      image: null,
      kind: partial.kind ?? 'human',
      role: partial.role ?? 'user',
    },
    actorKind: partial.kind ?? 'human',
  }
}

describe('SSO management surface', () => {
  beforeEach(async () => {
    await db.scimProvider.deleteMany({})
    await db.ssoProvider.deleteMany({})
    await db.account.deleteMany({
      where: { providerId: { notIn: ['credential'] } },
    })
  })

  afterAll(async () => {
    await db.$disconnect()
  })

  it('disables raw better-auth management paths at the HTTP layer', () => {
    const disabled = (
      auth as unknown as { options: { disabledPaths?: string[] } }
    ).options.disabledPaths
    for (const path of ADMIN_PATHS) {
      expect(disabled).toContain(path)
    }
  })

  it('is human-admin-only', async () => {
    expect(() =>
      SsoService.assertAdmin(ctx({ role: 'user' }), 'sso.x'),
    ).toThrow(/human admin/)
    expect(() =>
      SsoService.assertAdmin(ctx({ role: 'finance' }), 'sso.x'),
    ).toThrow(/human admin/)
    // §10 — agent principals are scope-governed and never hold identity keys.
    expect(() =>
      SsoService.assertAdmin(ctx({ kind: 'agent', role: 'admin' }), 'sso.x'),
    ).toThrow(/human admin/)
    expect(() =>
      SsoService.assertAdmin(ctx({ role: 'admin' }), 'sso.x'),
    ).not.toThrow()
  })

  it('lists providers without exposing secrets', async () => {
    await db.ssoProvider.create({
      data: {
        id: 'sp-1',
        issuer: 'https://idp.company.ph',
        domain: 'company.ph',
        userId: 'user-1',
        providerId: 'company-okta',
        oidcConfig: JSON.stringify({
          clientId: 'cid',
          clientSecret: 'super-secret',
        }),
      },
    })

    const service = new SsoService()
    const rows = await service.listProviders()

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      providerId: 'company-okta',
      issuer: 'https://idp.company.ph',
      domain: 'company.ph',
      type: 'oidc',
    })
    expect(JSON.stringify(rows)).not.toContain('super-secret')
  })

  it('deletes a provider together with its linked accounts', async () => {
    await db.user.create({
      data: { id: 'sso-user', name: 'IdP User', email: 'sso-user@company.ph' },
    })
    await db.account.create({
      data: {
        id: 'acc-1',
        accountId: 'idp-sub-1',
        providerId: 'company-okta',
        userId: 'sso-user',
      },
    })
    await db.ssoProvider.create({
      data: {
        id: 'sp-2',
        issuer: 'https://idp.company.ph',
        domain: 'company.ph',
        userId: 'user-1',
        providerId: 'company-okta',
      },
    })

    const service = new SsoService()
    await service.deleteProvider('company-okta')

    expect(
      await db.ssoProvider.findUnique({
        where: { providerId: 'company-okta' },
      }),
    ).toBeNull()
    expect(await db.account.findUnique({ where: { id: 'acc-1' } })).toBeNull()

    await db.user.delete({ where: { id: 'sso-user' } })
  })

  it('rejects unknown providers on delete', async () => {
    const service = new SsoService()
    await expect(service.deleteProvider('nope')).rejects.toThrow(
      /Unknown SSO provider/,
    )
  })

  it('requires a browser session for auth.api-backed mutations', async () => {
    const service = new SsoService()
    await expect(
      service.generateScimToken(
        ctx({ role: 'admin', req: undefined }),
        'scim-conn',
      ),
    ).rejects.toThrow(/authenticated browser session/)
  })
})
