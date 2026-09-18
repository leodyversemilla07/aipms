import { describe, expect, it } from 'vitest'
import { AppService } from '../src/app.service'

describe('operational health probes', () => {
  const service = new AppService()

  it('reports process liveness without dependency checks', () => {
    expect(service.liveness()).toMatchObject({
      ok: true,
      status: 'live',
    })
  })

  it('reports readiness only when PostgreSQL is reachable', async () => {
    await expect(service.readiness()).resolves.toEqual({
      ok: true,
      status: 'ready',
      checks: { database: 'ok' },
    })
  })
})
