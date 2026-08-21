import { Module } from '@nestjs/common'
import { EventsModule } from '../shared/events/events.module'
import { SharedModule } from '../shared/shared.module'
import { TrpcModule } from '../trpc/trpc.module'
import { PoSigningService } from './po-signing.service'
import { PurchaseOrderRouter } from './purchase-order.router'
import { PurchaseOrderService } from './purchase-order.service'

@Module({
  imports: [TrpcModule, SharedModule, EventsModule],
  providers: [PurchaseOrderService, PoSigningService, PurchaseOrderRouter],
  exports: [PurchaseOrderService],
})
export class PurchaseOrderModule {}
