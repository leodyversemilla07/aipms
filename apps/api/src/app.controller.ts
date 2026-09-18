import { Controller, Get } from '@nestjs/common'
import { AppService } from './app.service'

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

  /** Backward-compatible readiness alias used by existing deployments. */
  @Get('health')
  health() {
    return this.appService.readiness()
  }
}
