import { Module } from '@nestjs/common'
import { SharedModule } from '../shared/shared.module'
import { TrpcModule } from '../trpc/trpc.module'
import { AuditRouter } from './audit.router'

@Module({
  imports: [TrpcModule, SharedModule],
  providers: [AuditRouter],
})
export class AuditModule {}
