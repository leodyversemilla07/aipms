import { Module } from '@nestjs/common'
import { EventsModule } from '../shared/events/events.module'
import { SharedModule } from '../shared/shared.module'
import { SourcingRouter } from './sourcing.router'
import { SourcingService } from './sourcing.service'

@Module({
  imports: [SharedModule, EventsModule],
  providers: [SourcingService, SourcingRouter],
  exports: [SourcingService],
})
export class SourcingModule {}
