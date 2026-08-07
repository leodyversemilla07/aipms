import { Module } from '@nestjs/common'
import { PolicyModule } from '../policy/policy.module'
import { SharedModule } from '../shared/shared.module'
import { TrpcModule } from '../trpc/trpc.module'
import { InvoiceRouter } from './invoice.router'
import { InvoiceService } from './invoice.service'

@Module({
  imports: [TrpcModule, SharedModule, PolicyModule],
  providers: [InvoiceService, InvoiceRouter],
  exports: [InvoiceService],
})
export class InvoiceModule {}
