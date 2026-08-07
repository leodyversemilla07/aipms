import '@workspace/env/load'
import { Module } from '@nestjs/common'
import { AppController } from './app.controller'
import { AppService } from './app.service'
import { TrpcModule } from './trpc/trpc.module'
import { UsersModule } from './users/users.module'

@Module({
  imports: [TrpcModule, UsersModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
