import { randomUUID } from 'node:crypto'
import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { auth } from '@workspace/auth'
import { db } from '@workspace/db'
import request from 'supertest'
import type { App } from 'supertest/types'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { issueAgentAccessToken } from '../src/agent/agent-access-token'
import { AuditRouter } from '../src/audit/audit.router'
import { IntakeRouter } from '../src/intake/intake.router'
import { IntakeService } from '../src/intake/intake.service'
import { IntakeCommandService } from '../src/intake/intake-command.service'
import { InvoiceService } from '../src/invoice/invoice.service'
import { AuditService } from '../src/shared/audit/audit.service'
import { EventEmitterService } from '../src/shared/events/event-emitter.service'
import { IdempotencyService } from '../src/shared/idempotency/idempotency.service'
import { TrpcModule } from '../src/trpc/trpc.module'

/** Real HTTP/context/authorization/storage; only invoice matching is unused. */
describe('agent-safe intake responses over HTTP', () => {
  const prefix = `intake-boundary-${randomUUID()}`
  const channel = 'INTAKE-BOUNDARY-TEST'
  const subject = `${prefix}-agent`
  const raw = {
    number: 'INV-42',
    bankAccount: 'sensitive-bank-account',
    attachments: [
      { filename: 'invoice.pdf', contentBase64: 'sensitive-binary-body' },
    ],
  }
  const classified = {
    number: 'INV-42',
    apiToken: 'sensitive-classified-token',
  }
  const documentIds: string[] = []
  let app: INestApplication<App>
  let token: string
  let cookie: string
  let userId: string | undefined
  let documentId: string

  beforeAll(async () => {
    vi.stubEnv('AIPMS_AGENT_SIGNING_SECRET', `${prefix}-signing-secret`)
    vi.stubEnv('AIPMS_AGENT_RATE_LIMIT', '100')
    token = issueAgentAccessToken({
      subject,
      scopes: ['intake.read', 'intake.ingest', 'audit.read'],
    }).accessToken
    const module = await Test.createTestingModule({
      imports: [TrpcModule],
      providers: [
        IntakeRouter,
        AuditRouter,
        IntakeService,
        IntakeCommandService,
        AuditService,
        IdempotencyService,
        EventEmitterService,
        { provide: InvoiceService, useValue: {} },
      ],
    }).compile()
    app = module.createNestApplication({ logger: false })
    await app.init()
    const document = await db.intakeDocument.create({
      data: {
        channel,
        contentHash: prefix,
        raw,
        classified,
        status: 'extracted',
      },
    })
    documentId = document.id
    documentIds.push(documentId)
    await app.get(AuditService).record({
      actorId: subject,
      actorKind: 'agent',
      action: `${prefix}.snapshot`,
      entity: 'IntakeDocument',
      entityId: documentId,
      before: { bankAccount: 'sensitive-bank-account' },
      after: { raw, classified },
    })
    const password = `${prefix}-password`
    const created = await auth.api.signUpEmail({
      body: { name: prefix, email: `${prefix}@test.aipms`, password },
    })
    userId = created.user.id
    await db.user.update({ where: { id: userId }, data: { role: 'finance' } })
    const signedIn = await auth.api.signInEmail({
      body: { email: `${prefix}@test.aipms`, password },
      asResponse: true,
    })
    expect(signedIn.status).toBe(200)
    cookie = signedIn.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ')
  }, 30_000)

  afterAll(async () => {
    await app?.close()
    if (documentIds.length > 0) {
      await db.idempotencyKey.deleteMany({
        where: {
          OR: documentIds.map((id) => ({
            resultJson: { path: ['result', 'id'], equals: id },
          })),
        },
      })
      await db.domainEvent.deleteMany({
        where: { entityId: { in: documentIds } },
      })
      await db.intakeDocument.deleteMany({ where: { id: { in: documentIds } } })
    }
    await db.rateLimit.deleteMany({
      where: { key: { startsWith: `agent-mutation-rate:${subject}:` } },
    })
    if (userId) await db.user.delete({ where: { id: userId } })
    vi.unstubAllEnvs()
    await db.$disconnect()
  })

  function data(response: request.Response) {
    return response.body.result?.data?.json ?? response.body.result?.data
  }

  function query(path: string, input: object) {
    return request(app.getHttpServer()).get(
      `/api/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`,
    )
  }

  function expectSafe(document: { raw: unknown; classified: unknown }) {
    expect(document.raw).toMatchObject({ bankAccount: '[REDACTED]' })
    const serialized = JSON.stringify(document)
    expect(serialized).not.toContain('sensitive-bank-account')
    expect(serialized).not.toContain('sensitive-binary-body')
    expect(serialized).not.toContain('sensitive-classified-token')
    expect(serialized).toContain('INV-42')
  }

  it('projects list responses using the authenticated agent context', async () => {
    const response = await query('intake.list', { page: 1, pageSize: 100 }).set(
      'Authorization',
      `Bearer ${token}`,
    )
    expect(response.status).toBe(200)
    expect(Array.isArray(data(response))).toBe(true)
    const document = data(response).find(
      (row: { id: string }) => row.id === documentId,
    )
    expect(document).toBeDefined()
    expectSafe(document)
    expect(document.classified.apiToken).toBe('[REDACTED]')
  })

  it('projects detail responses without changing persisted payloads', async () => {
    const response = await query('intake.detail', { id: documentId }).set(
      'Authorization',
      `Bearer ${token}`,
    )
    expect(response.status).toBe(200)
    expectSafe(data(response))
    const stored = await db.intakeDocument.findUniqueOrThrow({
      where: { id: documentId },
    })
    expect(stored.raw).toEqual(raw)
    expect(stored.classified).toEqual(classified)
  })

  it('preserves raw data for authorized human detail reads', async () => {
    const response = await query('intake.detail', { id: documentId }).set(
      'Cookie',
      cookie,
    )
    expect(response.status).toBe(200)
    expect(data(response).raw).toEqual(raw)
    expect(data(response).classified).toEqual(classified)
  })

  it('projects newly ingested agent responses after the transaction commits', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/trpc/intake.ingest')
      .set('Authorization', `Bearer ${token}`)
      .send({
        channel,
        contentHash: `${prefix}-fresh`,
        raw,
        idempotencyKey: 'fresh',
      })
    expect(response.status).toBe(200)
    const document = data(response)
    documentIds.push(document.id)
    expectSafe(document)
    expect(
      (
        await db.intakeDocument.findUniqueOrThrow({
          where: { id: document.id },
        })
      ).raw,
    ).toEqual(raw)
  })

  it('projects unredacted outcomes cached before the response hardening', async () => {
    const input = {
      channel,
      contentHash: prefix,
      raw,
      idempotencyKey: 'legacy-cache',
    }
    const legacy = await app.get(IdempotencyService).runAtomic(
      {
        actorId: subject,
        operation: 'intake.ingest',
        key: input.idempotencyKey,
        input,
      },
      (tx) =>
        app.get(IntakeCommandService).ingest(
          { channel, contentHash: prefix, raw },
          {
            id: subject,
            kind: 'agent',
            scopes: ['intake.ingest'],
            source: 'trpc',
          },
          tx,
        ),
    )
    expect(legacy.raw).toEqual(raw)
    const response = await request(app.getHttpServer())
      .post('/api/trpc/intake.ingest')
      .set('Authorization', `Bearer ${token}`)
      .send(input)
    expect(response.status).toBe(200)
    expect(data(response).id).toBe(documentId)
    expectSafe(data(response))
  })

  it('withholds audit snapshots from agents but preserves human evidence', async () => {
    const input = { action: `${prefix}.snapshot`, page: 1, pageSize: 25 }
    const agentResponse = await query('audit.list', input).set(
      'Authorization',
      `Bearer ${token}`,
    )
    expect(agentResponse.status).toBe(200)
    const projected = data(agentResponse)
    expect(projected.rows).toHaveLength(1)
    expect(projected.rows[0]).toMatchObject({
      entityId: documentId,
      before: null,
      after: null,
    })
    expect(JSON.stringify(projected)).not.toContain('sensitive-')
    const humanResponse = await query('audit.list', input).set('Cookie', cookie)
    expect(humanResponse.status).toBe(200)
    expect(data(humanResponse).rows[0].after).toEqual({ raw, classified })
  })

  it('continues to reject unauthenticated reads', async () => {
    expect((await query('intake.detail', { id: documentId })).status).toBe(401)
  })
})
