import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { db } from '@workspace/db'
import request from 'supertest'
import type { App } from 'supertest/types'
import { afterAll, describe, expect, it } from 'vitest'
import { AppModule } from './../src/app.module'
import { withAuditMaintenance } from './audit-test-utils'

/**
 * @workspace agent M2M over tRPC — the eve runtime authenticates with
 * a bootstrap exchange and short-lived scoped bearer (no browser cookie).
 * The context resolves a synthetic agent principal, so agents can call every
 * AuthMiddleware-guarded procedure and their actions are audited with
 * actorKind 'agent'.
 */
describe('Agent tRPC M2M (short-lived bearer)', () => {
  const token = 'demo-service-token-for-trpc'
  const signingSecret = 'test-agent-signing-secret-at-least-32-bytes-long'
  let app: INestApplication<App>

  async function boot() {
    process.env.AIPMS_SERVICE_TOKEN = token
    process.env.AIPMS_AGENT_SIGNING_SECRET = signingSecret
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile()
    app = moduleFixture.createNestApplication()
    await app.init()
  }

  it('keeps direct bootstrap authentication available outside production', async () => {
    await boot()
    const input = encodeURIComponent(
      JSON.stringify({ types: ['requisition.approved'], limit: 1 }),
    )
    const res = await request(app.getHttpServer())
      .get(`/api/trpc/events.poll?input=${input}`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    const data = res.body.result?.data?.json ?? res.body.result?.data
    expect(Array.isArray(data)).toBe(true)
  })

  it('exchanges the bootstrap token for a scoped access token', async () => {
    await boot()
    const exchange = await request(app.getHttpServer())
      .post('/api/service/agent/token')
      .set('Authorization', `Bearer ${token}`)
      .send({ runId: 'run-auth-test' })
    expect(exchange.status).toBe(201)
    expect(exchange.body.accessToken).toEqual(expect.any(String))
    expect(exchange.body.accessToken).not.toBe(token)
    expect(exchange.body.expiresIn).toBe(300)

    const input = encodeURIComponent(
      JSON.stringify({ types: ['requisition.approved'], limit: 1 }),
    )
    const res = await request(app.getHttpServer())
      .get(`/api/trpc/events.poll?input=${input}`)
      .set('Authorization', `Bearer ${exchange.body.accessToken}`)
    expect(res.status).toBe(200)
  })

  it('rejects direct bootstrap authentication in production', async () => {
    await boot()
    const previous = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      const input = encodeURIComponent(
        JSON.stringify({ types: ['requisition.approved'], limit: 1 }),
      )
      const res = await request(app.getHttpServer())
        .get(`/api/trpc/events.poll?input=${input}`)
        .set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(401)
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = previous
    }
  })

  it('rejects a request without a token', async () => {
    await boot()
    const input = encodeURIComponent(
      JSON.stringify({ types: ['requisition.approved'], limit: 1 }),
    )
    const res = await request(app.getHttpServer()).get(
      `/api/trpc/events.poll?input=${input}`,
    )
    expect(res.status).toBe(401)
  })

  it('rejects a wrong token', async () => {
    await boot()
    const input = encodeURIComponent(
      JSON.stringify({ types: ['requisition.approved'], limit: 1 }),
    )
    const res = await request(app.getHttpServer())
      .get(`/api/trpc/events.poll?input=${input}`)
      .set('Authorization', 'Bearer wrong')
    expect(res.status).toBe(401)
  })

  it('audits agent-driven mutations with actorKind agent', async () => {
    await boot()
    const suffix = Math.random().toString(36).slice(2, 8)
    const res = await request(app.getHttpServer())
      .post('/api/trpc/intake.ingest')
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'application/json')
      .send({
        idempotencyKey: `trpc-agent-${suffix}`,
        channel: 'M2M-TEST',
        contentHash: `sha256-${suffix}`,
        raw: {
          docType: 'invoice',
          payload: {
            vendorId: `m2m-vendor-${suffix}`,
            number: `M2M-${suffix}`,
            lines: [{ amountMinor: 1000, class: 'goods' }],
          },
        },
      })
    expect(res.status).toBe(200)
    const doc = res.body.result?.data?.json ?? res.body.result?.data
    expect(doc.id).toBeTruthy()

    const audit = await db.auditEntry.findFirst({
      where: { action: 'intake.ingest', entityId: doc.id },
    })
    expect(audit).toBeTruthy()
    expect(audit?.actorKind).toBe('agent')
    expect(audit?.actorId).toBe('agent-operator')

    await db.intakeDocument.deleteMany({ where: { id: doc.id } })
    await withAuditMaintenance((tx) =>
      tx.auditEntry.deleteMany({ where: { entityId: doc.id } }),
    )
    await db.agentRun.deleteMany({
      where: { meta: { path: ['entityId'], equals: doc.id } },
    })
  })

  afterAll(async () => {
    delete process.env.AIPMS_SERVICE_TOKEN
    delete process.env.AIPMS_AGENT_SIGNING_SECRET
    await withAuditMaintenance((tx) =>
      tx.auditEntry.deleteMany({ where: { action: 'agent.token.issue' } }),
    )
    await app?.close()
  })
})
