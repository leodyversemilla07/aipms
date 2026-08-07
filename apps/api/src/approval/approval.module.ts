import { Module } from '@nestjs/common'
import { SharedModule } from '../shared/shared.module'
import { TrpcModule } from '../trpc/trpc.module'
import { ApprovalRouter } from './approval.router'
import { ApprovalService } from './approval.service'

@Module({
  imports: [TrpcModule, SharedModule],
  providers: [ApprovalService, ApprovalRouter],
  exports: [ApprovalService],
})
export class ApprovalModule {}
