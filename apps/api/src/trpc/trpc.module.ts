import { Module } from '@nestjs/common'
import { TRPCModule } from 'nestjs-trpc'
import { SharedModule } from '../shared/shared.module'
import { formatTrpcError } from './error-formatter'
import { AgentQuotaMiddleware } from './middlewares/agent-quota.middleware'
import { AgentRunContextMiddleware } from './middlewares/agent-run-context.middleware'
import { AuthMiddleware } from './middlewares/auth.middleware'
import { DomainErrorMiddleware } from './middlewares/domain-error.middleware'
import { LoggingMiddleware } from './middlewares/logging.middleware'
import { TrpcContext } from './trpc.context'
import { TrpcErrorHandler } from './trpc-error.handler'

@Module({
  imports: [
    SharedModule,
    TRPCModule.forRoot({
      basePath: '/api/trpc',
      context: TrpcContext,
      errorFormatter: formatTrpcError,
      onError: TrpcErrorHandler,
      globalMiddlewares: [
        LoggingMiddleware,
        DomainErrorMiddleware,
        AgentRunContextMiddleware,
      ],
    }),
  ],
  providers: [
    TrpcContext,
    TrpcErrorHandler,
    LoggingMiddleware,
    DomainErrorMiddleware,
    AgentRunContextMiddleware,
    AuthMiddleware,
    AgentQuotaMiddleware,
  ],
  exports: [AuthMiddleware],
})
export class TrpcModule {}
