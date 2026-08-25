import { Module } from '@nestjs/common'
import { TrpcModule } from '../trpc/trpc.module'
import { AnalyticsRouter } from './analytics.router'
import { AnalyticsService } from './analytics.service'

@Module({
  imports: [TrpcModule],
  providers: [AnalyticsRouter, AnalyticsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
