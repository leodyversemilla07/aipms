import { Module } from '@nestjs/common'
import { SharedModule } from '../shared/shared.module'
import { TrpcModule } from '../trpc/trpc.module'
import { PurchaseOrderRouter } from './purchase-order.router'
import { PurchaseOrderService } from './purchase-order.service'

@Module({
  imports: [TrpcModule, SharedModule],
  providers: [PurchaseOrderService, PurchaseOrderRouter],
  exports: [PurchaseOrderService],
})
export class PurchaseOrderModule {}
