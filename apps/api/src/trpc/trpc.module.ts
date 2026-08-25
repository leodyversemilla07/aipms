import { Module } from '@nestjs/common'
import { TRPCModule } from 'nestjs-trpc'
import { formatTrpcError } from './error-formatter'
import { AgentQuotaMiddleware } from './middlewares/agent-quota.middleware'
import { AuthMiddleware } from './middlewares/auth.middleware'
import { DomainErrorMiddleware } from './middlewares/domain-error.middleware'
import { LoggingMiddleware } from './middlewares/logging.middleware'
import { TrpcContext } from './trpc.context'
import { TrpcErrorHandler } from './trpc-error.handler'

@Module({
  imports: [
    TRPCModule.forRoot({
      basePath: '/api/trpc',
      context: TrpcContext,
      errorFormatter: formatTrpcError,
      onError: TrpcErrorHandler,
      globalMiddlewares: [
        LoggingMiddleware,
        DomainErrorMiddleware,
        // §7.4 — agent rate & concurrency guardrails (no-op for humans).
        AgentQuotaMiddleware,
      ],
    }),
  ],
  providers: [
    TrpcContext,
    TrpcErrorHandler,
    LoggingMiddleware,
    DomainErrorMiddleware,
    AuthMiddleware,
    AgentQuotaMiddleware,
  ],
  exports: [AuthMiddleware],
})
export class TrpcModule {}
