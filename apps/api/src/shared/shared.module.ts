import { Module } from '@nestjs/common'
import { AgentQuotaService } from './agent-quota/agent-quota.service'
import { AuditService } from './audit/audit.service'
import { AutomationLeaseService } from './automation/automation-lease.service'
import { DocumentNumberService } from './document-number/document-number.service'
import { IdempotencyService } from './idempotency/idempotency.service'
import { SigningService } from './signing/signing.service'

@Module({
  providers: [
    AgentQuotaService,
    IdempotencyService,
    AuditService,
    AutomationLeaseService,
    DocumentNumberService,
    SigningService,
  ],
  exports: [
    AgentQuotaService,
    IdempotencyService,
    AuditService,
    AutomationLeaseService,
    DocumentNumberService,
    SigningService,
  ],
})
export class SharedModule {}
