import { Inject } from '@nestjs/common'
import { Ctx, Query, Router, UseMiddlewares } from 'nestjs-trpc'
import type { AuthedTrpcContext } from '../trpc/context.types'
import { AuthMiddleware } from '../trpc/middlewares/auth.middleware'
import { UsersService } from './users.service'

@Router({ alias: 'users' })
@UseMiddlewares(AuthMiddleware)
export class UsersRouter {
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  @Query()
  async me(@Ctx() ctx: AuthedTrpcContext) {
    return ctx.user
  }

  @Query()
  async list() {
    return this.users.list()
  }
}
