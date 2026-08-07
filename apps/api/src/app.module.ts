import '@workspace/env/load'
import { Module } from '@nestjs/common'
import { AgentModule } from './agent/agent.module'
import { AppController } from './app.controller'
import { AppService } from './app.service'
import { ApprovalModule } from './approval/approval.module'
import { AuditModule } from './audit/audit.module'
import { BudgetModule } from './budget/budget.module'
import { CatalogModule } from './catalog/catalog.module'
import { IntakeModule } from './intake/intake.module'
import { InvoiceModule } from './invoice/invoice.module'
import { PaymentRunModule } from './payment-run/payment-run.module'
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
    AgentModule,
    AuditModule,
    IntakeModule,
    InvoiceModule,
    PaymentRunModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
