import { Module } from '@nestjs/common'
import { SharedModule } from '../shared/shared.module'
import { TrpcModule } from '../trpc/trpc.module'
import { SsoRouter } from './sso.router'
import { SsoService } from './sso.service'

@Module({
  imports: [TrpcModule, SharedModule],
  providers: [SsoService, SsoRouter],
  exports: [SsoService],
})
export class SsoModule {}
