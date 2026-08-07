import '@workspace/env/load'
import { Module } from '@nestjs/common'
import { AppController } from './app.controller'
import { AppService } from './app.service'
import { ApprovalModule } from './approval/approval.module'
import { BudgetModule } from './budget/budget.module'
import { CatalogModule } from './catalog/catalog.module'
import { PolicyModule } from './policy/policy.module'
import { PurchaseOrderModule } from './purchase-order/purchase-order.module'
import { RequisitionModule } from './requisition/requisition.module'
import { TrpcModule } from './trpc/trpc.module'
import { UsersModule } from './users/users.module'
import { VendorModule } from './vendor/vendor.module'

@Module({
  imports: [
    TrpcModule,
    UsersModule,
    CatalogModule,
    VendorModule,
    BudgetModule,
    PolicyModule,
    RequisitionModule,
    PurchaseOrderModule,
    ApprovalModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
