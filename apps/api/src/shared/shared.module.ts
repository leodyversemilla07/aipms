import { Module } from '@nestjs/common'
import { AuditService } from './audit/audit.service'
import { DocumentNumberService } from './document-number/document-number.service'
import { IdempotencyService } from './idempotency/idempotency.service'
import { SigningService } from './signing/signing.service'

@Module({
  providers: [
    IdempotencyService,
    AuditService,
    DocumentNumberService,
    SigningService,
  ],
  exports: [
    IdempotencyService,
    AuditService,
    DocumentNumberService,
    SigningService,
  ],
})
export class SharedModule {}
