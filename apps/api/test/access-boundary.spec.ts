import { randomUUID } from 'node:crypto'
import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { auth, env as authEnv } from '@workspace/auth'
import { db, type UserRole } from '@workspace/db'
import { toNodeHandler } from 'better-auth/node'
import request from 'supertest'
import type { App } from 'supertest/types'
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { AuditService } from '../src/shared/audit/audit.service'
import { IdempotencyService } from '../src/shared/idempotency/idempotency.service'
import { AGENT_PRINCIPAL_ID } from '../src/trpc/trpc.context'
import { TrpcModule } from '../src/trpc/trpc.module'
import { VendorRouter } from '../src/vendor/vendor.router'
import { VendorService } from '../src/vendor/vendor.service'

// Real HTTP handlers, middleware, sessions, and database. No background
// workers: this suite tests the access boundary, not event delivery.
describe('Enrollment, vendor authority, and agent quotas over HTTP', () => {
  const prefix = `access-${randomUUID()}`
  const token = `${prefix}-service-token`
  const password = 'test-access-boundary-password'
  const cookies = new Map<UserRole, string>()
  const userIds: string[] = []
  let app: INestApplication<App>
  let vendorService: VendorService
  let vendorId: string

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [TrpcModule],
      providers: [
        VendorRouter,
        VendorService,
        AuditService,
        IdempotencyService,
      ],
    }).compile()
    app = module.createNestApplication({ logger: false })
    app.use('/api/auth', toNodeHandler(auth))
    await app.init()
    vendorService = app.get(VendorService)

    for (const role of ['user', 'finance', 'procurement', 'admin'] as const) {
      const email = `${prefix}-${role}@test.aipms`
      // Trusted provisioning remains usable when public enrollment is closed.
      const created = await auth.api.signUpEmail({
        body: { name: `${prefix} ${role}`, email, password },
      })
      userIds.push(created.user.id)
      await db.user.update({ where: { id: created.user.id }, data: { role } })
      // Provision fixture sessions in-process so four setup logins do not
      // exhaust the real HTTP sign-in rate limit for the test runner's IP.
      const signedIn = await auth.api.signInEmail({
        body: { email, password },
        asResponse: true,
      })
      expect(signedIn.status).toBe(200)
      const headers = signedIn.headers.getSetCookie()
      cookies.set(role, headers.map((value) => value.split(';')[0]).join('; '))
    }
    const vendor = await db.vendor.create({
      data: { name: `${prefix}-vendor`, status: 'blacklisted' },
    })
    vendorId = vendor.id
  }, 30_000)

  beforeEach(async () => {
    vi.stubEnv('AIPMS_SERVICE_TOKEN', token)
    vi.stubEnv('AIPMS_AGENT_SCOPES', 'vendor.read,vendor.write')
    vi.stubEnv('AIPMS_AGENT_RATE_LIMIT', '100')
    vi.stubEnv('AIPMS_AGENT_CONCURRENCY', '4')
    await db.rateLimit.deleteMany({
      where: {
        key: { startsWith: `agent-mutation-rate:${AGENT_PRINCIPAL_ID}:` },
      },
    })
    await db.vendor.update({
      where: { id: vendorId },
      data: { status: 'blacklisted', blacklistReason: 'Requires review' },
    })
  })

  afterAll(async () => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    await app?.close()
    await db.vendor.deleteMany({ where: { name: { startsWith: prefix } } })
    await db.user.deleteMany({ where: { id: { in: userIds } } })
    await db.$disconnect()
  })

  function mutation(path: string, input: object, role?: UserRole) {
    const req = request(app.getHttpServer()).post(`/api/trpc/${path}`)
    if (role) req.set('Cookie', cookies.get(role) ?? '')
    else req.set('Authorization', `Bearer ${token}`)
    return req.send(input)
  }

  function createInput(status?: string) {
    return {
      idempotencyKey: randomUUID(),
      name: `${prefix}-${randomUUID()}`,
      ...(status ? { status } : {}),
    }
  }

  it('keeps HTTP sign-in available for provisioned accounts', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/auth/sign-in/email')
      .set('Origin', authEnv.appUrl)
      .send({ email: `${prefix}-user@test.aipms`, password })
    expect(response.status).toBe(200)
    expect(response.headers['set-cookie']).toBeDefined()
  })

  it.each(['/api/auth/sign-up/email', '/api/auth/sign-up/email/'])(
    'refuses public signup at %s without creating a user',
    async (path) => {
      const email = `${prefix}-${randomUUID()}@test.aipms`
      const response = await request(app.getHttpServer())
        .post(path)
        .set('Origin', authEnv.appUrl)
        .send({ name: 'Uninvited', email, password })
      expect(response.status).toBe(404)
      expect(await db.user.findUnique({ where: { email } })).toBeNull()
    },
  )

  it('rejects unauthenticated vendor writes', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/trpc/vendor.create')
      .send(createInput('active'))
    expect(response.status).toBe(401)
  })

  it.each(['user', 'finance'] as const)(
    'prevents %s from creating or qualifying vendors',
    async (role) => {
      const input = createInput('active')
      expect((await mutation('vendor.create', input, role)).status).toBe(403)
      expect(
        await db.vendor.findFirst({ where: { name: input.name } }),
      ).toBeNull()
      const response = await mutation(
        'vendor.update',
        { id: vendorId, idempotencyKey: randomUUID(), status: 'active' },
        role,
      )
      expect(response.status).toBe(403)
      expect(
        (await db.vendor.findUniqueOrThrow({ where: { id: vendorId } })).status,
      ).toBe('blacklisted')
    },
  )

  it.each(['procurement', 'admin'] as const)(
    'allows %s to create, activate, and blacklist vendors with an audit record',
    async (role) => {
      expect(
        (await mutation('vendor.create', createInput('active'), role)).status,
      ).toBe(200)
      for (const status of ['active', 'blacklisted']) {
        const response = await mutation(
          'vendor.update',
          { id: vendorId, idempotencyKey: randomUUID(), status },
          role,
        )
        expect(response.status).toBe(200)
        const saved = await db.vendor.findUniqueOrThrow({
          where: { id: vendorId },
        })
        expect(saved.status).toBe(status)
        const audit = await db.auditEntry.findFirst({
          where: { entityId: vendorId, action: 'vendor.update' },
          orderBy: { seq: 'desc' },
        })
        expect(audit?.actorKind).toBe('human')
        expect(audit?.after).toMatchObject({ status })
      }
    },
  )

  it('uses the current database role after a role is revoked', async () => {
    const email = `${prefix}-procurement@test.aipms`
    await db.user.update({ where: { email }, data: { role: 'user' } })
    try {
      expect(
        (await mutation('vendor.create', createInput(), 'procurement')).status,
      ).toBe(403)
    } finally {
      await db.user.update({ where: { email }, data: { role: 'procurement' } })
    }
  })

  it('allows scoped agents to create prospective vendors, but never qualify them', async () => {
    expect((await mutation('vendor.create', createInput())).status).toBe(200)
    expect(
      (await mutation('vendor.create', createInput('active'))).status,
    ).toBe(403)
    for (const changes of [
      { status: 'active' },
      { status: 'prospective' },
      { blacklistReason: null },
    ]) {
      const response = await mutation('vendor.update', {
        id: vendorId,
        idempotencyKey: randomUUID(),
        ...changes,
      })
      expect(response.status).toBe(403)
    }
    const response = await mutation('vendor.update', {
      id: vendorId,
      idempotencyKey: randomUUID(),
      email: 'updated@test.aipms',
    })
    expect(response.status).toBe(200)
    expect(
      await db.vendor.findUniqueOrThrow({ where: { id: vendorId } }),
    ).toMatchObject({
      status: 'blacklisted',
      blacklistReason: 'Requires review',
    })
  })

  it('enforces the mutation quota through the real middleware chain', async () => {
    vi.stubEnv('AIPMS_AGENT_RATE_LIMIT', '1')
    expect((await mutation('vendor.create', createInput())).status).toBe(200)
    const input = createInput()
    expect((await mutation('vendor.create', input)).status).toBe(429)
    expect(
      await db.vendor.findFirst({ where: { name: input.name } }),
    ).toBeNull()
    const query = await request(app.getHttpServer())
      .get(
        `/api/trpc/vendor.detail?input=${encodeURIComponent(JSON.stringify({ id: vendorId }))}`,
      )
      .set('Authorization', `Bearer ${token}`)
    expect(query.status).toBe(200)
    expect(
      (await mutation('vendor.create', createInput(), 'procurement')).status,
    ).toBe(200)
  })

  it('checks scopes before consuming mutation quota', async () => {
    vi.stubEnv('AIPMS_AGENT_RATE_LIMIT', '1')
    vi.stubEnv('AIPMS_AGENT_SCOPES', 'vendor.read')
    expect((await mutation('vendor.create', createInput())).status).toBe(403)
    vi.stubEnv('AIPMS_AGENT_SCOPES', 'vendor.write')
    expect((await mutation('vendor.create', createInput())).status).toBe(200)
  })

  it('enforces the concurrency cap and releases the slot after completion', async () => {
    vi.stubEnv('AIPMS_AGENT_CONCURRENCY', '1')
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const original = vendorService.create.bind(vendorService)
    const spy = vi
      .spyOn(vendorService, 'create')
      .mockImplementationOnce(async (...args) => {
        entered.resolve()
        await release.promise
        return original(...args)
      })
    const first = mutation('vendor.create', createInput()).then((res) => res)
    try {
      await Promise.race([
        entered.promise,
        first.then(() => {
          throw new Error('First request did not reach the service')
        }),
      ])
      expect((await mutation('vendor.create', createInput())).status).toBe(429)
    } finally {
      release.resolve()
      await first
      spy.mockRestore()
    }
    expect((await first).status).toBe(200)
    expect((await mutation('vendor.create', createInput())).status).toBe(200)
  })
})
