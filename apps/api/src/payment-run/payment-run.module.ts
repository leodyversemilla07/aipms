import { Module } from '@nestjs/common'
import { SharedModule } from '../shared/shared.module'
import { TrpcModule } from '../trpc/trpc.module'
import { PaymentRunRouter } from './payment-run.router'
import { PaymentRunService } from './payment-run.service'

@Module({
  imports: [TrpcModule, SharedModule],
  providers: [PaymentRunService, PaymentRunRouter],
  exports: [PaymentRunService],
})
export class PaymentRunModule {}
