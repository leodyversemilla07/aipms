import type { ExecutionContext } from '@nestjs/common'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppService } from '../src/app.service'
import { OperationsMonitoringGuard } from '../src/operations-monitoring.guard'

describe('operational health probes', () => {
  const service = new AppService()

  afterEach(() => vi.unstubAllEnvs())

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

  it('reports low-cardinality operational exception gauges', async () => {
    await expect(service.operationalHealth()).resolves.toMatchObject({
      ok: true,
      status: 'observed',
      exceptions: {
        deadLetters: expect.any(Number),
        staleRelayClaims: expect.any(Number),
        staleAgentRuns: expect.any(Number),
        failedMessages: expect.any(Number),
        ambiguousErpDispatches: expect.any(Number),
      },
    })
  })

  it('requires a dedicated constant-time monitoring credential', () => {
    vi.stubEnv('OPERATIONS_MONITORING_TOKEN', 'monitoring-secret')
    const guard = new OperationsMonitoringGuard()
    const context = (authorization?: string) =>
      ({
        switchToHttp: () => ({
          getRequest: () => ({ headers: { authorization } }),
        }),
      }) as ExecutionContext

    expect(guard.canActivate(context('Bearer monitoring-secret'))).toBe(true)
    expect(() => guard.canActivate(context('Bearer wrong-secret'))).toThrow(
      /Invalid monitoring credential/,
    )
  })
})
})
