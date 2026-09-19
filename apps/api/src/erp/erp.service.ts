import { randomUUID } from 'node:crypto'
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { db, Prisma } from '@workspace/db'
import { EventEmitterService } from '../shared/events/event-emitter.service'
import type { ListInput, ListResult } from '../trpc/list-input'
import { paginate } from '../trpc/list-input'
import {
  buildJournalManifest,
  canonicalManifestJson,
  type JournalManifest,
  manifestHash,
  manifestToCsv,
  verifyBalanced,
} from './journal'

/**
 * §8.5 ERP bridge — publish what you own, ingest what you use.
 *
 * Publish: an executed payment run is exported once as a governed journal
 * manifest (idempotent via the content hash; re-export of unchanged data
 * returns the same export). The ERP consumes the JSON/CSV file and returns
 * status through `acknowledge`.
 *
 * Ingest: vendor master registrations arrive from the ERP (the author of
 * record for master data) and are upserted into the local cache by taxId.
 */
type ErpExportListRow = Prisma.ErpJournalExportGetPayload<object>

@Injectable()
export class ErpService {
  constructor(private readonly events: EventEmitterService) {}

  /** Deterministic manifest for one exported or exportable run. */
  private async buildForRun(runId: string): Promise<{
    run: {
      id: string
      runNumber: string
      status: string
      currencyCode: string
      totalMinor: number
      executedAt: Date
    }
    manifest: JournalManifest
    json: string
    csv: string
    hash: string
  }> {
    const run = await db.paymentRun.findUnique({ where: { id: runId } })
    if (!run) throw new NotFoundException(`Payment run ${runId} not found`)
    // Reconciliation closes the run but must not revoke its export: finance
    // exports after the bank feed settles, and settled exports stay readable.
    if (run.status !== 'executed' && run.status !== 'reconciled') {
      throw new ConflictException(
        `Run ${run.runNumber} is ${run.status} — only executed or reconciled runs export`,
      )
    }

    // PaymentRunLine carries a plain invoiceId FK (no Prisma relation) —
    // join invoices and vendor master data manually.
    const lines = await db.paymentRunLine.findMany({ where: { runId } })
    const invoiceIds = [...new Set(lines.map((l) => l.invoiceId))]
    const invoices = await db.invoice.findMany({
      where: { id: { in: invoiceIds } },
    })
    const vendorIds = [...new Set(invoices.map((invoice) => invoice.vendorId))]
    const vendors = await db.vendor.findMany({
      where: { id: { in: vendorIds } },
      select: { id: true, name: true, taxId: true },
    })
    const invoiceById = new Map(invoices.map((i) => [i.id, i] as const))
    const vendorById = new Map(vendors.map((v) => [v.id, v] as const))

    const manifest = buildJournalManifest({
      runNumber: run.runNumber,
      executedAt: run.executedAt ?? run.updatedAt,
      currencyCode: run.currencyCode,
      invoices: lines.map((l) => {
        const inv = invoiceById.get(l.invoiceId)
        if (!inv) {
          throw new NotFoundException(
            `Invoice ${l.invoiceId} on ${run.runNumber} not found`,
          )
        }
        return {
          invoiceId: inv.id,
          invoiceNumber: inv.number,
          vendorName: vendorById.get(inv.vendorId)?.name ?? '(unknown vendor)',
          vendorTaxId: vendorById.get(inv.vendorId)?.taxId ?? null,
          amountMinor: inv.amountMinor,
          vatMinor: inv.vatMinor,
          ewtMinor: inv.ewtMinor,
        }
      }),
    })

    const check = verifyBalanced(manifest)
    if (!check.balanced) {
      throw new ConflictException(
        `Journal does not balance for ${run.runNumber}: debits ${check.debitsMinor} ≠ credits ${check.creditsMinor}`,
      )
    }
    const json = canonicalManifestJson(manifest)
    return {
      run: {
        id: run.id,
        runNumber: run.runNumber,
        status: run.status,
        currencyCode: run.currencyCode,
        totalMinor: run.totalMinor,
        executedAt: run.executedAt ?? run.updatedAt,
      },
      manifest,
      json,
      csv: manifestToCsv(manifest),
      hash: manifestHash(json),
    }
  }

  /**
   * Export (idempotent). Re-exporting an unchanged run returns the existing
   * row; a changed run (should be impossible post-execution) conflicts so
   * divergence surfaces instead of silently drifting (§13).
   */
  async exportRun(
    runId: string,
    exportedBy: string,
    tx: Prisma.TransactionClient = db,
  ) {
    const built = await this.buildForRun(runId)
    // Pre-check first: runId is unique, and a violation would abort an
    // outer transaction. A concurrent create racing the pre-check surfaces
    // as P2002; the caller retries and the pre-check returns the winner.
    const existing = await tx.erpJournalExport.findUnique({
      where: { runId },
    })
    if (existing) {
      if (existing.manifestHash !== built.hash) {
        throw new ConflictException(
          `Export for ${built.run.runNumber} already exists with a different manifest — investigate before re-exporting`,
        )
      }
      return { export: existing, created: false, ...built }
    }

    const created = await tx.erpJournalExport.create({
      data: {
        runId: built.run.id,
        runNumber: built.run.runNumber,
        manifestHash: built.hash,
        // Freeze the exact artifact: later reads serve this, never a
        // rebuild from mutable vendor master data.
        manifestJson: built.json,
        lineCount: built.manifest.entries.length,
        totalMinor: built.manifest.totalMinor,
        currencyCode: built.run.currencyCode,
        exportedBy,
      },
    })
    await this.events.emit(
      {
        type: 'erp.exported',
        entityType: 'PaymentRun',
        entityId: built.run.id,
        payload: {
          runNumber: built.run.runNumber,
          manifestHash: built.hash,
          totalMinor: built.manifest.totalMinor,
        },
      },
      tx,
    )
    return { export: created, created: true, ...built }
  }

  list(
    input: Partial<ListInput> & { status?: string } = {},
  ): Promise<ListResult<ErpExportListRow>> {
    const { skip, take } = paginate({
      page: input.page ?? 1,
      pageSize: input.pageSize ?? 25,
    })
    const where = input.status ? { status: input.status } : {}
    return Promise.all([
      db.erpJournalExport.findMany({
        where,
        skip,
        take,
        orderBy: { exportedAt: 'desc' },
      }),
      db.erpJournalExport.count({ where }),
    ]).then(([rows, total]) => ({ rows, total, facetCounts: {} }))
  }

  /**
   * Re-derive and verify a stored export's manifest (tamper check). Exports
   * created with a frozen artifact serve it directly, so later master-data
   * edits cannot break verification; legacy rows rebuild and verify.
   */
  async manifest(exportId: string) {
    const row = await db.erpJournalExport.findUnique({
      where: { id: exportId },
    })
    if (!row) throw new NotFoundException(`Export ${exportId} not found`)
    if (row.manifestJson != null) {
      if (manifestHash(row.manifestJson) !== row.manifestHash) {
        throw new ConflictException(
          `Stored artifact for ${row.runNumber} no longer matches its hash`,
        )
      }
      const manifest = JSON.parse(row.manifestJson) as JournalManifest
      return {
        export: row,
        json: row.manifestJson,
        csv: manifestToCsv(manifest),
      }
    }
    const built = await this.buildForRun(row.runId)
    if (built.hash !== row.manifestHash) {
      throw new ConflictException(
        `Stored hash for ${row.runNumber} no longer matches the derived manifest`,
      )
    }
    return { export: row, json: built.json, csv: built.csv }
  }

  /**
   * Durably claim an export before the non-transactional QuickBooks POST.
   * Claims are never automatically reclaimed: a crash or transport error may
   * mean QBO accepted the journal, so finance must review and acknowledge the
   * outcome instead of risking a duplicate.
   */
  async prepareQboPush(
    exportId: string,
    claimedBy: string,
    outerTx?: Prisma.TransactionClient,
  ) {
    // Verify the frozen artifact before taking a claim. Once claimed, every
    // failure is treated as potentially externally visible.
    const { json } = await this.manifest(exportId)
    const claimId = randomUUID()
    const run = async (tx: Prisma.TransactionClient) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`qbo-push:${exportId}`}))`
      const row = await tx.erpJournalExport.findUnique({
        where: { id: exportId },
      })
      if (!row) throw new NotFoundException(`Export ${exportId} not found`)
      if (row.status !== 'exported') {
        throw new ConflictException(
          `Export for ${row.runNumber} is already ${row.status} — refusing a second push`,
        )
      }
      if (row.dispatchClaimId) {
        throw new ConflictException(
          row.dispatchFailure
            ? `Export for ${row.runNumber} has an ambiguous QBO dispatch — review it before acknowledging`
            : `Export for ${row.runNumber} is already being pushed to QBO`,
        )
      }
      return tx.erpJournalExport.update({
        where: { id: exportId },
        data: {
          dispatchClaimId: claimId,
          dispatchClaimedBy: claimedBy,
          dispatchStartedAt: new Date(),
          dispatchFailure: null,
        },
      })
    }
    const row = outerTx ? await run(outerTx) : await db.$transaction(run)
    return { export: row, json, claimId }
  }

  /** Retain the claim and mark an external outcome as ambiguous. */
  async markQboPushFailed(
    exportId: string,
    claimId: string,
    reason: string,
    tx: Prisma.TransactionClient = db,
  ) {
    const changed = await tx.erpJournalExport.updateMany({
      where: { id: exportId, status: 'exported', dispatchClaimId: claimId },
      data: { dispatchFailure: reason.slice(0, 500) },
    })
    if (changed.count !== 1) {
      throw new ConflictException('QBO dispatch claim is no longer current')
    }
    return tx.erpJournalExport.findUniqueOrThrow({ where: { id: exportId } })
  }

  /** Settle exactly the claim that performed the successful external POST. */
  async completeQboPush(
    exportId: string,
    claimId: string,
    externalRef: string,
    tx: Prisma.TransactionClient = db,
  ) {
    const row = await tx.erpJournalExport.findUnique({
      where: { id: exportId },
    })
    if (!row) throw new NotFoundException(`Export ${exportId} not found`)
    const changed = await tx.erpJournalExport.updateMany({
      where: { id: exportId, status: 'exported', dispatchClaimId: claimId },
      data: {
        status: 'posted',
        externalRef,
        rejectedReason: null,
        acknowledgedAt: new Date(),
        dispatchFailure: null,
      },
    })
    if (changed.count !== 1) {
      throw new ConflictException('QBO dispatch claim is no longer current')
    }
    await this.events.emit(
      {
        type: 'erp.posted',
        entityType: 'PaymentRun',
        entityId: row.runId,
        payload: { runNumber: row.runNumber, externalRef },
      },
      tx,
    )
    return tx.erpJournalExport.findUniqueOrThrow({ where: { id: exportId } })
  }

  /**
   * ERP acknowledgement feed — the ERP returns posted/rejected for a
   * consumed journal. Line-level payment outcomes still flow through the
   * payment-run reconcile path; this settles the journal itself.
   */
  async acknowledge(
    input: {
      exportId: string
      status: 'posted' | 'rejected'
      externalRef?: string | null
      rejectedReason?: string | null
      resolveDispatchClaim?: boolean
    },
    acknowledgedBy: string,
    tx: Prisma.TransactionClient = db,
  ) {
    const row = await tx.erpJournalExport.findUnique({
      where: { id: input.exportId },
    })
    if (!row) throw new NotFoundException(`Export ${input.exportId} not found`)
    if (row.status !== 'exported') {
      throw new ConflictException(
        `Export for ${row.runNumber} is already ${row.status}`,
      )
    }
    if (row.dispatchClaimId && !input.resolveDispatchClaim) {
      throw new ConflictException(
        `Export for ${row.runNumber} has a QBO dispatch claim; explicit manual resolution is required`,
      )
    }
    if (
      row.dispatchClaimId &&
      input.resolveDispatchClaim &&
      row.dispatchClaimedBy === acknowledgedBy
    ) {
      throw new ConflictException(
        'QBO dispatch maker and manual-resolution checker must differ',
      )
    }
    if (
      row.dispatchClaimId &&
      input.resolveDispatchClaim &&
      input.status === 'posted' &&
      !input.externalRef
    ) {
      throw new ConflictException(
        'Manual QBO posted resolution requires the reviewed external reference',
      )
    }
    if (input.status === 'rejected' && !input.rejectedReason) {
      throw new ConflictException('A rejection reason is required')
    }
    // Conditional transition: concurrent ack attempts serialize — only the
    // first moves exported → posted/rejected.
    const changed = await tx.erpJournalExport.updateMany({
      where: { id: row.id, status: 'exported' },
      data: {
        status: input.status,
        externalRef: input.externalRef ?? null,
        rejectedReason:
          input.status === 'rejected' ? (input.rejectedReason ?? null) : null,
        acknowledgedAt: new Date(),
        ...(row.dispatchClaimId && input.resolveDispatchClaim
          ? {
              dispatchResolvedBy: acknowledgedBy,
              dispatchResolvedAt: new Date(),
            }
          : {}),
      },
    })
    if (changed.count !== 1) {
      throw new ConflictException(
        `Export for ${row.runNumber} is no longer exported — reload before acknowledging`,
      )
    }
    const updated = await tx.erpJournalExport.findUniqueOrThrow({
      where: { id: row.id },
    })
    if (input.status === 'posted') {
      await this.events.emit(
        {
          type: 'erp.posted',
          entityType: 'PaymentRun',
          entityId: row.runId,
          payload: {
            runNumber: row.runNumber,
            externalRef: input.externalRef ?? null,
          },
        },
        tx,
      )
    }
    return updated
  }

  /**
   * Ingest vendor master registrations from the ERP (author of record for
   * master data). Matched by taxId when present, else by exact name.
   */
  async ingestVendors(
    vendors: {
      name: string
      taxId?: string | null
      email?: string | null
      paymentTermsDays?: number | null
    }[],
    outerTx?: Prisma.TransactionClient,
  ) {
    // Bulk sync commits all-or-nothing. Serialized on an advisory lock so
    // concurrent syncs cannot create duplicate master rows.
    const run = async (tx: Prisma.TransactionClient) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('erp_vendor_ingest'))`
      let created = 0
      let updated = 0
      for (const v of vendors) {
        const existing = v.taxId
          ? await tx.vendor.findFirst({ where: { taxId: v.taxId } })
          : await tx.vendor.findFirst({ where: { name: v.name } })
        if (existing) {
          // Never clobber local lifecycle state (status/blacklist); only
          // refresh descriptive fields the ERP owns.
          await tx.vendor.update({
            where: { id: existing.id },
            data: {
              name: v.name,
              email: v.email ?? existing.email,
              paymentTermsDays: v.paymentTermsDays ?? existing.paymentTermsDays,
              ...(existing.taxId ? {} : { taxId: v.taxId ?? null }),
            },
          })
          updated += 1
        } else {
          await tx.vendor.create({
            data: {
              name: v.name,
              status: 'prospective',
              email: v.email ?? null,
              taxId: v.taxId ?? null,
              paymentTermsDays: v.paymentTermsDays ?? null,
            },
          })
          created += 1
        }
      }
      return { received: vendors.length, created, updated }
    }
    if (outerTx) return run(outerTx)
    return db.$transaction(run)
  }

  /**
   * §8.5 reconciliation gate — amount-and-volume checks between aipms and
   * the ERP feed. Divergence here is what finance sees; nothing reconciles
   * silently.
   */
  async reconcileReport() {
    type MissingExportRow = {
      runId: string
      runNumber: string
      totalMinor: number
      currencyCode: string
      totalCount: bigint
    }
    const [
      executedRuns,
      exportCount,
      postedAggregate,
      missingExports,
      unacked,
    ] = await Promise.all([
      db.paymentRun.count({
        where: { status: { in: ['executed', 'reconciled'] } },
      }),
      db.erpJournalExport.count(),
      db.erpJournalExport.aggregate({
        _sum: { totalMinor: true },
        where: { status: 'posted' },
      }),
      db.$queryRaw<MissingExportRow[]>(Prisma.sql`
          select pr.id as "runId", pr."runNumber", pr."totalMinor",
                 pr."currencyCode", count(*) over()::bigint as "totalCount"
          from "paymentRun" pr
          left join "erpJournalExport" e on e."runId" = pr.id
          where pr.status in ('executed', 'reconciled') and e.id is null
          order by pr."executedAt" desc nulls last, pr.id
          limit 500
        `),
      db.erpJournalExport.findMany({
        where: { status: 'exported' },
        orderBy: [
          { dispatchClaimId: { sort: 'asc', nulls: 'last' } },
          { exportedAt: 'desc' },
        ],
        take: 500,
      }),
    ])

    const [unackedCount, ambiguousDispatchCount] = await Promise.all([
      db.erpJournalExport.count({ where: { status: 'exported' } }),
      db.erpJournalExport.count({
        where: { status: 'exported', dispatchClaimId: { not: null } },
      }),
    ])
    const missingExportCount = Number(missingExports[0]?.totalCount ?? 0)

    return {
      executedRuns,
      exports: exportCount,
      missingExportCount,
      /** Executed runs with no journal export — capped review sample. */
      missingExports: missingExports.map((row) => ({
        runId: row.runId,
        runNumber: row.runNumber,
        totalMinor: row.totalMinor,
        currencyCode: row.currencyCode,
      })),
      awaitingAcknowledgementCount: unackedCount,
      /** Exports consumed but not yet acknowledged — capped review sample. */
      awaitingAcknowledgement: unacked.map((row) => ({
        exportId: row.id,
        runNumber: row.runNumber,
        totalMinor: row.totalMinor,
        dispatchClaimId: row.dispatchClaimId,
        dispatchStartedAt: row.dispatchStartedAt,
        dispatchFailure: row.dispatchFailure,
      })),
      ambiguousDispatchCount,
      /** Claimed QBO posts need completion or explicit human resolution. */
      ambiguousDispatches: unacked
        .filter((row) => row.dispatchClaimId != null)
        .map((row) => ({
          exportId: row.id,
          runNumber: row.runNumber,
          dispatchStartedAt: row.dispatchStartedAt,
          dispatchFailure: row.dispatchFailure,
        })),
      postedTotalMinor: postedAggregate._sum.totalMinor ?? 0,
      clean: missingExportCount === 0 && unackedCount === 0,
    }
  }
}
