import { Module } from '@nestjs/common'
import { SharedModule } from '../shared/shared.module'
import { TrpcModule } from '../trpc/trpc.module'
import { AnalyticsRouter } from './analytics.router'
import { AnalyticsService } from './analytics.service'

@Module({
  imports: [TrpcModule, SharedModule],
  providers: [AnalyticsRouter, AnalyticsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
