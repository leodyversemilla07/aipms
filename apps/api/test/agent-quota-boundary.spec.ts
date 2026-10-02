import { randomUUID } from 'node:crypto'
import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { db } from '@workspace/db'
import request from 'supertest'
import type { App } from 'supertest/types'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { AgentScheduler } from '../src/agent/agent.scheduler'
import { AgentService } from '../src/agent/agent.service'
import { issueAgentAccessToken } from '../src/agent/agent-access-token'
import { AgentCommandService } from '../src/agent/agent-command.service'
import { AgentWakeService } from '../src/agent/agent-wake.service'
import { AppModule } from '../src/app.module'

const id = `boundary-${randomUUID()}`
const numberPrefix = `BQ-${randomUUID()}`
let app: INestApplication<App>
let vendorId: string
let documents: string[] = []
let serial = 0
const headers = (
  scopes = ['invoice.ingest', 'intake.ingest'],
  runId?: string,
) =>
  `Bearer ${issueAgentAccessToken({ subject: id, scopes, runId }).accessToken}`
const counter = () =>
  db.rateLimit.findFirstOrThrow({
    where: { key: { startsWith: `agent-mutation-rate:${id}:` } },
  })
const batch = (runId?: string) =>
  request(app.getHttpServer())
    .post('/api/service/agent/batch')
    .set('Authorization', headers(undefined, runId))
    .send({ limit: 3 })
async function cleanup() {
  await db.invoice.deleteMany({
    where: { number: { startsWith: numberPrefix } },
  })
  await db.intakeDocument.deleteMany({
    where: { contentHash: { startsWith: id } },
  })
  await db.agentRun.deleteMany({
    where: {
      OR: [
        { agentId: id },
        ...documents.map((entityId) => ({
          meta: { path: ['entityId'], equals: entityId },
        })),
      ],
    },
  })
  await db.rateLimit.deleteMany({
    where: { key: { startsWith: `agent-mutation-rate:${id}:` } },
  })
  await db.user.deleteMany({ where: { id } })
}
beforeAll(async () => {
  vi.stubEnv('AIPMS_AGENT_ID', id)
  vi.stubEnv(
    'AIPMS_AGENT_SIGNING_SECRET',
    'boundary-test-signing-secret-at-least-32-characters',
  )
  vi.stubEnv('AIPMS_AGENT_RATE_LIMIT', '2')
  vi.stubEnv('AIPMS_AGENT_CONCURRENCY', '1')
  vi.stubEnv('AIPMS_AGENT_SCOPES', 'invoice.ingest,intake.ingest')
  vi.stubEnv('AIPMS_AGENT_WAKE', '0')
  vi.stubEnv('AGENT_AUTORUN', '0')
  const module = await Test.createTestingModule({
    imports: [AppModule],
  }).compile()
  app = module.createNestApplication()
  await app.init()
  vendorId = (
    await db.vendor.create({ data: { name: id, taxId: '000-000-000' } })
  ).id
}, 30_000)
beforeEach(async () => {
  await cleanup()
  documents = []
  vi.spyOn(Date, 'now').mockReturnValue(1_900_000_000_000)
  for (let i = 0; i < 3; i++) {
    const doc = await db.intakeDocument.create({
      data: {
        channel: 'QUOTA-TEST',
        contentHash: `${id}-${serial++}`,
        receivedAt: new Date(Date.UTC(2000, 0, i + 1)),
        raw: {
          docType: 'invoice',
          payload: {
            vendorId,
            number: `${numberPrefix}-${serial}`,
            lines: [{ amountMinor: 1000, class: 'goods' }],
          },
        },
      },
    })
    documents.push(doc.id)
  }
})
afterEach(() => vi.restoreAllMocks())
afterAll(async () => {
  await app?.close()
  await cleanup()
  if (vendorId) await db.vendor.delete({ where: { id: vendorId } })
  vi.unstubAllEnvs()
})

describe('shared quotas at real HTTP/command boundaries', () => {
  it('REST bills envelope + each document, defers untouched work and retains run attribution', async () => {
    const runId = `signed-${randomUUID()}`
    const response = await batch(runId)
    expect(response.status).toBe(201)
    expect(response.body).toMatchObject({
      documents: 3,
      succeeded: 1,
      failed: [],
      deferred: 2,
      quotaLimited: true,
    })
    expect((await counter()).count).toBe(3)
    expect(
      await db.intakeDocument.count({
        where: { id: { in: documents }, status: 'new' },
      }),
    ).toBe(2)
    expect(
      await db.invoice.count({
        where: { number: { startsWith: numberPrefix } },
      }),
    ).toBe(1)
    const audits = await db.auditEntry.findMany({
      where: {
        actorId: id,
        runId,
        action: { in: ['agent.batch', 'agent.process'] },
      },
    })
    expect(audits.map((row) => row.action).sort()).toEqual([
      'agent.batch',
      'agent.process',
    ])
    expect(audits.every((row) => row.actorKind === 'agent')).toBe(true)
  })

  it('a partially throttled owned batch is not falsely marked succeeded', async () => {
    const response = await batch()
    expect(response.status).toBe(201)
    const run = await db.agentRun.findFirstOrThrow({
      where: { agentId: id },
    })
    expect(run.status).toBe('failed')
    expect(run.meta).toMatchObject({ deferred: 2, quotaLimited: true })
  })

  it('tRPC and REST share accounting without double-charging nested intake commands', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/trpc/intake.ingest')
      .set('Authorization', headers())
      .send({
        idempotencyKey: `${id}-http-${serial++}`,
        channel: 'QUOTA-TEST',
        contentHash: `${id}-http-${serial++}`,
        raw: {
          docType: 'invoice',
          payload: {
            vendorId,
            number: `${numberPrefix}-http`,
            lines: [{ amountMinor: 1, class: 'goods' }],
          },
        },
      })
    expect(response.status).toBe(200)
    expect((await counter()).count).toBe(1)
    const partial = await batch()
    expect(partial.status).toBe(201)
    expect(partial.body).toMatchObject({
      succeeded: 0,
      deferred: 3,
      quotaLimited: true,
    })
    const refused = await batch()
    expect(refused.status).toBe(429)
    expect(
      await db.invoice.count({
        where: { number: { startsWith: numberPrefix } },
      }),
    ).toBe(0)
  })

  it('authorization refusals spend no quota and cannot forge actor scopes in the body', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/service/agent/batch')
      .set('Authorization', headers(['vendor.read']))
      .send({
        limit: 3,
        scopes: ['invoice.ingest'],
        source: 'trpc',
        runId: 'forged',
      })
    expect(response.status).toBe(403)
    expect(
      await db.rateLimit.count({
        where: { key: { startsWith: `agent-mutation-rate:${id}:` } },
      }),
    ).toBe(0)
    expect(
      await db.intakeDocument.count({
        where: { id: { in: documents }, status: 'new' },
      }),
    ).toBe(3)
  })

  it('stored User quotas, not body overrides, control REST admissions', async () => {
    await db.user.create({
      data: {
        id,
        email: `${id}@example.test`,
        name: id,
        kind: 'agent',
        quotas: { mutationsPerMinute: 1 },
      },
    })
    const response = await request(app.getHttpServer())
      .post('/api/service/agent/batch')
      .set('Authorization', headers())
      .send({ limit: 3, quotas: { mutationsPerMinute: 999999 } })
    expect(response.status).toBe(201)
    expect(response.body).toMatchObject({
      succeeded: 0,
      deferred: 3,
      quotaLimited: true,
    })
    expect(
      await db.invoice.count({
        where: { number: { startsWith: numberPrefix } },
      }),
    ).toBe(0)
  })

  it('scheduler and actual event-wake handler cannot escape a spent REST budget', async () => {
    await batch()
    const before = (await counter()).count
    await app.get(AgentScheduler).tick(3)
    expect((await counter()).count).toBe(before + 1)
    const handlers = new Map<string, (event: unknown) => Promise<void>>()
    vi.stubEnv('AIPMS_AGENT_WAKE', '1')
    const wake = new AgentWakeService(
      {
        subscribe: (type: string, handler: (event: unknown) => Promise<void>) =>
          handlers.set(type, handler),
      } as never,
      app.get(AgentCommandService),
    )
    wake.onModuleInit()
    const event = {
      id: randomUUID(),
      type: 'intake.received',
      entityType: 'IntakeDocument',
      entityId: documents[1],
      payload: {},
      createdAt: new Date(),
    }
    const handler = handlers.get('intake.received')
    if (!handler) throw new Error('Expected intake wake subscription')
    await expect(handler(event)).rejects.toThrow(/quota exhausted/)
    expect((await counter()).count).toBe(before + 2)
    expect(
      await db.intakeDocument.count({
        where: { id: { in: documents }, status: 'new' },
      }),
    ).toBe(2)
    const run = await db.agentRun.findFirstOrThrow({
      where: { meta: { path: ['entityId'], equals: documents[1] } },
    })
    expect(run.status).toBe('failed')
    vi.stubEnv('AIPMS_AGENT_WAKE', '0')
  })

  it('one command slot blocks overlapping HTTP mutations and is released after completion', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const service = app.get(AgentService)
    const original = service.classifyAndRegister.bind(service)
    vi.spyOn(service, 'classifyAndRegister').mockImplementation(
      async (docId, tx) => {
        entered()
        await gate
        return original(docId, tx)
      },
    )
    const first = batch()
    const pending = first.then((response) => response)
    try {
      await started
      const refusal = await batch()
      expect(refusal.status).toBe(429)
      expect((await counter()).count).toBe(2)
    } finally {
      release()
    }
    expect((await pending).status).toBe(201)
    // Cap release is observable even though the minute's rate is spent.
    const later = await batch()
    expect(later.status).toBe(429)
    expect(later.body.message).toMatch(/quota exhausted/)
  })
})
