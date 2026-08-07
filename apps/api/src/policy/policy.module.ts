import { Module } from '@nestjs/common'
import { SharedModule } from '../shared/shared.module'
import { TrpcModule } from '../trpc/trpc.module'
import { PolicyRouter } from './policy.router'
import { PolicyService } from './policy.service'

@Module({
  imports: [TrpcModule, SharedModule],
  providers: [PolicyService, PolicyRouter],
  exports: [PolicyService],
})
export class PolicyModule {}
