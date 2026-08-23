import { Module } from '@nestjs/common'
import { EventsModule } from '../shared/events/events.module'
import { SharedModule } from '../shared/shared.module'
import { TrpcModule } from '../trpc/trpc.module'
import { MessagingRouter } from './messaging.router'
import {
  LoggingTransport,
  MESSAGE_TRANSPORT,
  MessagingService,
} from './messaging.service'

@Module({
  imports: [TrpcModule, SharedModule, EventsModule],
  providers: [
    MessagingRouter,
    MessagingService,
    // §8.3 delivery seam: swap for org SMTP / transactional email provider.
    { provide: MESSAGE_TRANSPORT, useClass: LoggingTransport },
  ],
  exports: [MessagingService],
})
export class MessagingModule {}
