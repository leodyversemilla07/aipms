import { Module } from '@nestjs/common'
import { InvoiceModule } from '../invoice/invoice.module'
import { EventsModule } from '../shared/events/events.module'
import { SharedModule } from '../shared/shared.module'
import { TrpcModule } from '../trpc/trpc.module'
import { IntakeRouter } from './intake.router'
import { IntakeService } from './intake.service'

@Module({
  imports: [TrpcModule, SharedModule, InvoiceModule, EventsModule],
  providers: [IntakeService, IntakeRouter],
  exports: [IntakeService],
})
export class IntakeModule {}
