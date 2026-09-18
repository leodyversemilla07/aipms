import { Module } from '@nestjs/common'
import { TrpcModule } from '../../trpc/trpc.module'
import { SharedModule } from '../shared.module'
import { EventEmitterService } from './event-emitter.service'
import { EventRelayService } from './event-relay.service'
import { EventSubscriptionRouter } from './event-subscription.router'

@Module({
  imports: [TrpcModule, SharedModule],
  providers: [EventEmitterService, EventRelayService, EventSubscriptionRouter],
  exports: [EventEmitterService, EventRelayService],
})
export class EventsModule {}
