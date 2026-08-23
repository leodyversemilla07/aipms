import { Module } from '@nestjs/common'
import { TrpcModule } from '../trpc/trpc.module'
import { BirRouter } from './bir.router'
import { BirService } from './bir.service'

@Module({
  imports: [TrpcModule],
  providers: [BirService, BirRouter],
  exports: [BirService],
})
export class BirModule {}
