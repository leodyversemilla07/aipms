import { Module } from '@nestjs/common'
import { InvoiceModule } from '../invoice/invoice.module'
import { EventsModule } from '../shared/events/events.module'
import { SharedModule } from '../shared/shared.module'
import { TrpcModule } from '../trpc/trpc.module'
import { IntakeCommandService } from './intake-command.service'
import { IntakeRouter } from './intake.router'
import { IntakeService } from './intake.service'
import { IntakeImapService } from './intake-imap.service'

@Module({
  imports: [TrpcModule, SharedModule, InvoiceModule, EventsModule],
  providers: [
    IntakeService,
    IntakeCommandService,
    IntakeRouter,
    IntakeImapService,
  ],
  exports: [IntakeService, IntakeCommandService],
})
export class IntakeModule {}
