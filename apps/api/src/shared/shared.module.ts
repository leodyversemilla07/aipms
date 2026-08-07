import { Module } from '@nestjs/common'
import { AuditService } from './audit/audit.service'
import { IdempotencyService } from './idempotency/idempotency.service'

@Module({
  providers: [IdempotencyService, AuditService],
  exports: [IdempotencyService, AuditService],
})
export class SharedModule {}
