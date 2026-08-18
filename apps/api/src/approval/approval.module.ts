import { Module } from '@nestjs/common'
import { EventsModule } from '../shared/events/events.module'
import { SharedModule } from '../shared/shared.module'
import { TrpcModule } from '../trpc/trpc.module'
import { ApprovalRouter } from './approval.router'
import { ApprovalService } from './approval.service'

@Module({
  imports: [TrpcModule, SharedModule, EventsModule],
  providers: [ApprovalService, ApprovalRouter],
  exports: [ApprovalService],
})
export class ApprovalModule {}
