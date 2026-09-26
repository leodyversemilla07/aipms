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
import { SmtpMessageTransport } from './smtp-message.transport'

export function configuredMessageTransport() {
  const requested = process.env.AIPMS_MESSAGING_TRANSPORT?.trim().toLowerCase()
  if (requested && !['smtp', 'log'].includes(requested)) {
    throw new Error('AIPMS_MESSAGING_TRANSPORT must be "smtp" or "log"')
  }
  if (requested === 'log' && process.env.NODE_ENV === 'production') {
    throw new Error('The logging message transport is forbidden in production')
  }
  if (requested === 'smtp' || process.env.NODE_ENV === 'production') {
    return new SmtpMessageTransport()
  }
  return new LoggingTransport()
}

@Module({
  imports: [TrpcModule, SharedModule, EventsModule],
  providers: [
    MessagingRouter,
    MessagingService,
    SmtpMessageTransport,
    LoggingTransport,
    {
      provide: MESSAGE_TRANSPORT,
      useFactory: configuredMessageTransport,
    },
  ],
  exports: [MessagingService],
})
export class MessagingModule {}
