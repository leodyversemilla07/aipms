import { Module } from '@nestjs/common'
import { SharedModule } from '../shared/shared.module'
import { TrpcModule } from '../trpc/trpc.module'
import { IntakeRouter } from './intake.router'
import { IntakeService } from './intake.service'

@Module({
  imports: [TrpcModule, SharedModule],
  providers: [IntakeService, IntakeRouter],
  exports: [IntakeService],
})
export class IntakeModule {}
