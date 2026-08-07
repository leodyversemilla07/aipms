import { Module } from '@nestjs/common'
import { SharedModule } from '../shared/shared.module'
import { TrpcModule } from '../trpc/trpc.module'
import { VendorRouter } from './vendor.router'
import { VendorService } from './vendor.service'

@Module({
  imports: [TrpcModule, SharedModule],
  providers: [VendorService, VendorRouter],
  exports: [VendorService],
})
export class VendorModule {}
