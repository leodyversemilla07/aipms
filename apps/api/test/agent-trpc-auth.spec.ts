import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { db } from '@workspace/db'
import request from 'supertest'
import type { App } from 'supertest/types'
import { afterAll, describe, expect, it } from 'vitest'
import { AppModule } from './../src/app.module'

/**
 * @workspace agent M2M over tRPC — the eve runtime authenticates with
 * `Authorization: Bearer <AIPMS_SERVICE_TOKEN>` (no browser cookie). The
 * context resolves a synthetic agent principal, so agents can call every
 * AuthMiddleware-guarded procedure and their actions are audited with
 * actorKind 'agent'.
 */
describe('Agent tRPC M2M (bearer service token)', () => {
  const token = 'demo-service-token-for-trpc'
  let app: INestApplication<App>

  async function boot() {
    process.env.AIPMS_SERVICE_TOKEN = token
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile()
    app = moduleFixture.createNestApplication()
    await app.init()
  }

  it('serves a guarded query with a valid service token', async () => {
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
    await db.auditEntry.deleteMany({ where: { entityId: doc.id } })
    await db.agentRun.deleteMany({
      where: { meta: { path: ['entityId'], equals: doc.id } },
    })
  })

  afterAll(async () => {
    delete process.env.AIPMS_SERVICE_TOKEN
    await app?.close()
  })
})
