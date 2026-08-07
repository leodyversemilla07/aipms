import '@workspace/env/load'
import { Module } from '@nestjs/common'
import { AppController } from './app.controller'
import { AppService } from './app.service'
import { BudgetModule } from './budget/budget.module'
import { CatalogModule } from './catalog/catalog.module'
import { PolicyModule } from './policy/policy.module'
import { TrpcModule } from './trpc/trpc.module'
import { UsersModule } from './users/users.module'
import { VendorModule } from './vendor/vendor.module'

@Module({
  imports: [
    TrpcModule,
    UsersModule,
    CatalogModule,
    VendorModule,
    BudgetModule,
    PolicyModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
