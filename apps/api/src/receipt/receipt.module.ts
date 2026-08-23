import { Module } from '@nestjs/common'
import { InvoiceModule } from '../invoice/invoice.module'
import { EventsModule } from '../shared/events/events.module'
import { SharedModule } from '../shared/shared.module'
import { TrpcModule } from '../trpc/trpc.module'
import { ReceiptRouter } from './receipt.router'
import { ReceiptService } from './receipt.service'

@Module({
  imports: [TrpcModule, SharedModule, InvoiceModule, EventsModule],
  providers: [ReceiptService, ReceiptRouter],
  exports: [ReceiptService],
})
export class ReceiptModule {}
