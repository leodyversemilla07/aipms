import { Injectable, ServiceUnavailableException } from '@nestjs/common'
import { db } from '@workspace/db'
import { getRecoverySummary } from './shared/operations/recovery-summary'

@Injectable()
export class AppService {
  private readonly startedAt = new Date()

  getHello(): string {
    return 'Hello World!'
  }

  liveness() {
    return {
      ok: true as const,
      status: 'live' as const,
      startedAt: this.startedAt.toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
    }
  }

  async operationalHealth() {
    try {
      return {
        ok: true as const,
        status: 'observed' as const,
        exceptions: await getRecoverySummary(),
      }
    } catch {
      throw new ServiceUnavailableException({
        ok: false,
        status: 'unavailable',
      })
    }
  }

  async readiness() {
    try {
      await db.$queryRaw`SELECT 1`
      return {
        ok: true as const,
        status: 'ready' as const,
        checks: { database: 'ok' as const },
      }
    } catch {
      // Do not leak connection strings, hosts, or driver errors through a
      // public load-balancer probe. The process remains live but must leave
      // service rotation until PostgreSQL is reachable again.
      throw new ServiceUnavailableException({
        ok: false,
        status: 'not_ready',
        checks: { database: 'unavailable' },
      })
    }
  }
}
