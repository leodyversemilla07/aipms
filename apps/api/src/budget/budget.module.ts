import { Module } from '@nestjs/common'
import { SharedModule } from '../shared/shared.module'
import { TrpcModule } from '../trpc/trpc.module'
import { BudgetRouter } from './budget.router'
import { BudgetService } from './budget.service'

@Module({
  imports: [TrpcModule, SharedModule],
  providers: [BudgetService, BudgetRouter],
  exports: [BudgetService],
})
export class BudgetModule {}
