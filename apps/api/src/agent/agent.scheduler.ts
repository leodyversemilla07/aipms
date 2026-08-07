import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common'
import { AgentService } from './agent.service'

/**
 * §3 optional drain loop — periodically runs `agent.batch` so the intake
 * queue empties unattended. Disabled by default; enable with AGENT_AUTORUN=1
 * and tune AGENT_INTERVAL_MS (default 60s) / AGENT_BATCH_SIZE (default 25).
 * Re-entrancy-guarded so a slow pass never overlaps; per-doc failures are
 * isolated upstream.
 */
@Injectable()
export class AgentScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentScheduler.name)
  private timer?: NodeJS.Timeout
  private running = false
  private readonly batchSize = Number(process.env.AGENT_BATCH_SIZE ?? 25)
  private readonly intervalMs = Number(process.env.AGENT_INTERVAL_MS ?? 60_000)
  private readonly enabled = process.env.AGENT_AUTORUN === '1'

  constructor(private readonly agent: AgentService) {}

  onModuleInit() {
    if (!this.enabled) {
      this.logger.log('agent drain disabled (set AGENT_AUTORUN=1 to enable)')
      return
    }
    this.timer = setInterval(() => void this.tick(), this.intervalMs)
    this.logger.log(
      `agent drain enabled: every ${this.intervalMs}ms (batch ${this.batchSize})`,
    )
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** One drain pass — the repeatable unit a worker loop (or a test) drives. */
  async tick(batchSize: number = this.batchSize) {
    if (this.running) return
    this.running = true
    try {
      const result = await this.agent.processPending(batchSize)
      if (result.documents > 0) {
        this.logger.log(
          `agent drain: ${result.succeeded}/${result.documents} processed, ${result.failed.length} failed`,
        )
      }
    } catch (error) {
      this.logger.error(`agent drain failed: ${(error as Error).message}`)
    } finally {
      this.running = false
    }
  }
}
