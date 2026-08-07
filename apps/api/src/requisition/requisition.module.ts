import { Module } from '@nestjs/common'
import { PolicyModule } from '../policy/policy.module'
import { SharedModule } from '../shared/shared.module'
import { TrpcModule } from '../trpc/trpc.module'
import { RequisitionRouter } from './requisition.router'
import { RequisitionService } from './requisition.service'

@Module({
  imports: [TrpcModule, SharedModule, PolicyModule],
  providers: [RequisitionService, RequisitionRouter],
  exports: [RequisitionService],
})
export class RequisitionModule {}
