import { Module } from '@nestjs/common'
import { EventsModule } from '../shared/events/events.module'
import { SharedModule } from '../shared/shared.module'
import { TrpcModule } from '../trpc/trpc.module'
import { ErpRouter } from './erp.router'
import { ErpService } from './erp.service'

@Module({
  imports: [TrpcModule, SharedModule, EventsModule],
  providers: [ErpRouter, ErpService],
  exports: [ErpService],
})
export class ErpModule {}
