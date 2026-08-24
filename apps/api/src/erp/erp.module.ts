import { Module } from '@nestjs/common'
import { EventsModule } from '../shared/events/events.module'
import { SharedModule } from '../shared/shared.module'
import { TrpcModule } from '../trpc/trpc.module'
import { ErpRouter } from './erp.router'
import { ErpService } from './erp.service'
import { QboService } from './qbo.service'
import { QboCallbackController } from './qbo-callback.controller'

@Module({
  imports: [TrpcModule, SharedModule, EventsModule],
  controllers: [QboCallbackController],
  providers: [ErpRouter, ErpService, QboService],
  exports: [ErpService, QboService],
})
export class ErpModule {}
