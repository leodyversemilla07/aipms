import { Module } from '@nestjs/common'
import { AuditService } from './audit/audit.service'
import { DocumentNumberService } from './document-number/document-number.service'
import { IdempotencyService } from './idempotency/idempotency.service'

@Module({
  providers: [IdempotencyService, AuditService, DocumentNumberService],
  exports: [IdempotencyService, AuditService, DocumentNumberService],
})
export class SharedModule {}
