import { Controller, Get, UseGuards } from '@nestjs/common'
import { AppService } from './app.service'
import { OperationsMonitoringGuard } from './operations-monitoring.guard'

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello()
  }

  /** Process-only probe. It deliberately does not touch dependencies. */
  @Get('health/live')
  liveness() {
    return this.appService.liveness()
  }

  /** Load-balancer readiness probe: refuse traffic while PostgreSQL is down. */
  @Get('health/ready')
  readiness() {
    return this.appService.readiness()
  }

  /** Authenticated low-cardinality exception gauges for alerting systems. */
  @Get('health/operations')
  @UseGuards(OperationsMonitoringGuard)
  operationalHealth() {
    return this.appService.operationalHealth()
  }

  /** Backward-compatible readiness alias used by existing deployments. */
  @Get('health')
  health() {
    return this.appService.readiness()
  }
}
