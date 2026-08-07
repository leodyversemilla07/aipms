import { Module } from '@nestjs/common'
import { SharedModule } from '../shared/shared.module'
import { TrpcModule } from '../trpc/trpc.module'
import { CatalogRouter } from './catalog.router'
import { CatalogService } from './catalog.service'

@Module({
  imports: [TrpcModule, SharedModule],
  providers: [CatalogService, CatalogRouter],
  exports: [CatalogService],
})
export class CatalogModule {}
