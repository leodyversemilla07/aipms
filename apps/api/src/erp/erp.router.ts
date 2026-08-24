import { Inject } from '@nestjs/common'
import {
  Ctx,
  Input,
  Mutation,
  Query,
  Router,
  UseMiddlewares,
} from 'nestjs-trpc'
import { z } from 'zod'
import { AuditService } from '../shared/audit/audit.service'
import { requireRole } from '../trpc/authorize'
import type { AuthedTrpcContext } from '../trpc/context.types'
import { listInput } from '../trpc/list-input'
import { AuthMiddleware } from '../trpc/middlewares/auth.middleware'
import { ErpService } from './erp.service'
import { QboService } from './qbo.service'

const exportInput = z.object({ runId: z.string().min(1) })

const acknowledgeInput = z.object({
  exportId: z.string().min(1),
  status: z.enum(['posted', 'rejected']),
  externalRef: z.string().min(1).max(100).optional(),
  rejectedReason: z.string().min(1).max(500).optional(),
})

const vendorIngestInput = z.object({
  vendors: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        taxId: z.string().min(1).max(40).nullish(),
        email: z.string().email().nullish(),
        paymentTermsDays: z.number().int().min(0).max(365).nullish(),
      }),
    )
    .min(1)
    .max(1_000),
})

/**
 * §8.5 ERP bridge surface. Publishing and acknowledgement are finance-role
 * operations; reads stay authenticated. The ERP itself integrates through
 * this router with a scoped service identity in later phases.
 */
@Router({ alias: 'erp' })
@UseMiddlewares(AuthMiddleware)
export class ErpRouter {
  constructor(
    @Inject(ErpService) private readonly erp: ErpService,
    @Inject(QboService) private readonly qbo: QboService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Mutation({ input: exportInput })
  async exportRun(
    @Input() input: z.infer<typeof exportInput>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    requireRole(ctx.user, ctx.actorKind, ['finance'], 'erp.exportRun')
    const result = await this.erp.exportRun(input.runId, ctx.user.id)
    if (result.created) {
      await this.audit.record({
        actorId: ctx.user.id,
        actorKind: ctx.actorKind,
        action: 'erp.export',
        entity: 'PaymentRun',
        entityId: input.runId,
        after: { manifestHash: result.hash },
      })
    }
    return {
      export: result.export,
      created: result.created,
      manifestJson: result.json,
      manifestCsv: result.csv,
    }
  }

  @Query({ input: listInput })
  async list(@Input() input: z.infer<typeof listInput>) {
    return this.erp.list(input)
  }

  @Query({ input: z.object({ id: z.string().min(1) }) })
  async manifest(@Input() input: { id: string }) {
    return this.erp.manifest(input.id)
  }

  @Mutation({ input: acknowledgeInput })
  async acknowledge(
    @Input() input: z.infer<typeof acknowledgeInput>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    requireRole(ctx.user, ctx.actorKind, ['finance'], 'erp.acknowledge')
    const updated = await this.erp.acknowledge(input)
    await this.audit.record({
      actorId: ctx.user.id,
      actorKind: ctx.actorKind,
      action: 'erp.acknowledge',
      entity: 'ErpJournalExport',
      entityId: updated.id,
      input: { status: input.status, externalRef: input.externalRef ?? null },
      after: updated as object,
    })
    return updated
  }

  @Mutation({ input: vendorIngestInput })
  async ingestVendors(
    @Input() input: z.infer<typeof vendorIngestInput>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    requireRole(ctx.user, ctx.actorKind, ['finance'], 'erp.ingestVendors')
    const result = await this.erp.ingestVendors(input.vendors)
    await this.audit.record({
      actorId: ctx.user.id,
      actorKind: ctx.actorKind,
      action: 'erp.vendorIngest',
      entity: 'Vendor',
      entityId: null,
      input: result as unknown as Record<string, unknown>,
    })
    return result
  }

  @Query({ input: z.object({}) })
  async reconcileReport(@Input() _input: Record<string, never>) {
    return this.erp.reconcileReport()
  }

  // ── QuickBooks Online connector (§8.5 v1 anchor adapter) ─────────────

  @Query({ input: z.object({}) })
  async qboStatus(@Input() _input: Record<string, never>) {
    return this.qbo.status()
  }

  /** Mint the Intuit authorize URL; the browser follows it. */
  @Mutation({ input: z.object({}) })
  async qboAuthorize(
    @Input() _input: Record<string, never>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    requireRole(ctx.user, ctx.actorKind, ['finance'], 'erp.qboAuthorize')
    const url = this.qbo.authorizeUrl()
    await this.audit.record({
      actorId: ctx.user.id,
      actorKind: ctx.actorKind,
      action: 'erp.qbo.authorizeStart',
      entity: 'ErpConnection',
      entityId: null,
    })
    return { url }
  }

  @Mutation({ input: z.object({}) })
  async qboDisconnect(
    @Input() _input: Record<string, never>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    requireRole(ctx.user, ctx.actorKind, ['finance'], 'erp.qboDisconnect')
    await this.qbo.disconnect()
    await this.audit.record({
      actorId: ctx.user.id,
      actorKind: ctx.actorKind,
      action: 'erp.qbo.disconnect',
      entity: 'ErpConnection',
      entityId: null,
    })
    return { ok: true }
  }

  /** Pull the chart of accounts from QBO (master data ingest). */
  @Mutation({ input: z.object({}) })
  async qboSyncAccounts(
    @Input() _input: Record<string, never>,
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    requireRole(ctx.user, ctx.actorKind, ['finance'], 'erp.qboSyncAccounts')
    const accounts = await this.qbo.syncAccounts()
    await this.audit.record({
      actorId: ctx.user.id,
      actorKind: ctx.actorKind,
      action: 'erp.qbo.syncAccounts',
      entity: 'ErpConnection',
      entityId: null,
      after: { count: accounts.length },
    })
    return { accounts }
  }

  @Mutation({
    input: z.object({
      map: z.record(z.string().min(1), z.string().min(1)),
    }),
  })
  async qboSetAccountMap(
    @Input() input: { map: Record<string, string> },
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    requireRole(ctx.user, ctx.actorKind, ['finance'], 'erp.qboSetAccountMap')
    const map = await this.qbo.setAccountMap(input.map)
    await this.audit.record({
      actorId: ctx.user.id,
      actorKind: ctx.actorKind,
      action: 'erp.qbo.setAccountMap',
      entity: 'ErpConnection',
      entityId: null,
      after: map as unknown as Record<string, unknown>,
    })
    return { accountMap: map }
  }

  /**
   * Push a verified journal export to QBO and settle it on success.
   * Orchestrates the §8.5 loop end-to-end for one export.
   */
  @Mutation({ input: z.object({ exportId: z.string().min(1) }) })
  async qboPushExport(
    @Input() input: { exportId: string },
    @Ctx() ctx: AuthedTrpcContext,
  ) {
    requireRole(ctx.user, ctx.actorKind, ['finance'], 'erp.qboPushExport')
    const { json, export: row } = await this.erp.manifest(input.exportId)
    const { qboJournalEntryId } = await this.qbo.postJournal(json)
    const acknowledged = await this.erp.acknowledge({
      exportId: input.exportId,
      status: 'posted',
      externalRef: qboJournalEntryId,
    })
    await this.audit.record({
      actorId: ctx.user.id,
      actorKind: ctx.actorKind,
      action: 'erp.qbo.pushExport',
      entity: 'PaymentRun',
      entityId: row.runId,
      after: { qboJournalEntryId },
    })
    return acknowledged
  }
}
