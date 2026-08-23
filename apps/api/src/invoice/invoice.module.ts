import { Module } from '@nestjs/common'
import { PolicyModule } from '../policy/policy.module'
import { EventsModule } from '../shared/events/events.module'
import { SharedModule } from '../shared/shared.module'
import { TrpcModule } from '../trpc/trpc.module'
import { InvoiceRouter } from './invoice.router'
import { InvoiceService } from './invoice.service'

@Module({
  imports: [TrpcModule, SharedModule, PolicyModule, EventsModule],
  providers: [InvoiceService, InvoiceRouter],
  exports: [InvoiceService],
})
export class InvoiceModule {}
