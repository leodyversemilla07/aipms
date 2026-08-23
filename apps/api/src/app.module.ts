import '@workspace/env/load'
import { Module } from '@nestjs/common'
import { AgentModule } from './agent/agent.module'
import { AppController } from './app.controller'
import { AppService } from './app.service'
import { ApprovalModule } from './approval/approval.module'
import { AuditModule } from './audit/audit.module'
import { AuthModule } from './auth/auth.module'
import { BirModule } from './bir/bir.module'
import { BudgetModule } from './budget/budget.module'
import { CatalogModule } from './catalog/catalog.module'
import { IntakeModule } from './intake/intake.module'
import { InvoiceModule } from './invoice/invoice.module'
import { MessagingModule } from './messaging/messaging.module'
import { PaymentRunModule } from './payment-run/payment-run.module'
import { PolicyModule } from './policy/policy.module'
import { PurchaseOrderModule } from './purchase-order/purchase-order.module'
import { ReceiptModule } from './receipt/receipt.module'
import { RequisitionModule } from './requisition/requisition.module'
import { EventsModule } from './shared/events/events.module'
import { SsoModule } from './sso/sso.module'
import { TrpcModule } from './trpc/trpc.module'
import { UsersModule } from './users/users.module'
import { VendorModule } from './vendor/vendor.module'

@Module({
  imports: [
    TrpcModule,
    AuthModule,
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
    BirModule,
    IntakeModule,
    InvoiceModule,
    ReceiptModule,
    MessagingModule,
    PaymentRunModule,
    SsoModule,
    EventsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
