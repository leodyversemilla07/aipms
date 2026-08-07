import { Module } from '@nestjs/common'
import { IntakeModule } from '../intake/intake.module'
import { InvoiceModule } from '../invoice/invoice.module'
import { SharedModule } from '../shared/shared.module'
import { TrpcModule } from '../trpc/trpc.module'
import { AgentController } from './agent.controller'
import { AgentRouter } from './agent.router'
import { AgentScheduler } from './agent.scheduler'
import { AGENT_EXTRACTOR, AgentService } from './agent.service'
import { extractStructuredInvoice } from './extract'
import { ServiceTokenGuard } from './service-token.guard'

@Module({
  imports: [TrpcModule, SharedModule, IntakeModule, InvoiceModule],
  controllers: [AgentController],
  providers: [
    AgentService,
    AgentRouter,
    AgentScheduler,
    ServiceTokenGuard,
    // Default extractor seam; swapped for an LLM-backed extractor without
    // changing the pipeline.
    { provide: AGENT_EXTRACTOR, useValue: extractStructuredInvoice },
  ],
  exports: [AgentService],
})
export class AgentModule {}
