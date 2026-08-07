import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import type { App } from 'supertest/types'
import { afterAll, describe, it } from 'vitest'
import { AppModule } from './../src/app.module'

/**
 * @workspace agent M2M — the token-guarded REST batch endpoint that the eve
 * runtime calls to drain the queue as an `agent` (audited) principal.
 */
describe('AgentController M2M (/api/service/agent/batch)', () => {
  const token = 'demo-service-token-for-tests'
  let app: INestApplication<App>

  async function boot() {
    process.env.AIPMS_SERVICE_TOKEN = token
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile()
    app = moduleFixture.createNestApplication()
    await app.init()
  }

  it('runs a batch with a valid service token', async () => {
    await boot()
    const res = await request(app.getHttpServer())
      .post('/api/service/agent/batch')
      .set('Authorization', `Bearer ${token}`)
      .send({ limit: 5 })
    expect(res.status).toBe(201)
    expect(typeof res.body.documents).toBe('number')
    expect(typeof res.body.succeeded).toBe('number')
    expect(Array.isArray(res.body.failed)).toBe(true)
  })

  it('rejects a request without a token', async () => {
    await boot()
    const res = await request(app.getHttpServer())
      .post('/api/service/agent/batch')
      .send({ limit: 5 })
    expect(res.status).toBe(401)
  })

  it('rejects a wrong token', async () => {
    await boot()
    const res = await request(app.getHttpServer())
      .post('/api/service/agent/batch')
      .set('Authorization', 'Bearer wrong')
      .send({ limit: 5 })
    expect(res.status).toBe(401)
  })

  afterAll(async () => {
    delete process.env.AIPMS_SERVICE_TOKEN
    await app?.close()
  })
})
