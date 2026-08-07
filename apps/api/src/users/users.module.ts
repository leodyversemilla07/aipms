import { Module } from '@nestjs/common'
import { TrpcModule } from '../trpc/trpc.module'
import { UsersRouter } from './users.router'
import { UsersService } from './users.service'

@Module({
  imports: [TrpcModule],
  providers: [UsersService, UsersRouter],
  exports: [UsersService],
})
export class UsersModule {}
