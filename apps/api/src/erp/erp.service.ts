import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { db } from '@workspace/db'
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
@Injectable()
export class ErpService {
  constructor(private readonly events: EventEmitterService) {}

  /** Deterministic manifest for one executed run. */
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
    if (run.status !== 'executed') {
      throw new ConflictException(
        `Run ${run.runNumber} is ${run.status} — only executed runs export`,
      )
    }

    // PaymentRunLine carries a plain invoiceId FK (no Prisma relation) —
    // join invoices and vendor master data manually.
    const lines = await db.paymentRunLine.findMany({ where: { runId } })
    const invoiceIds = [...new Set(lines.map((l) => l.invoiceId))]
    const [invoices, vendors] = await Promise.all([
      db.invoice.findMany({ where: { id: { in: invoiceIds } } }),
      db.vendor.findMany({ select: { id: true, name: true, taxId: true } }),
    ])
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
  async exportRun(runId: string, exportedBy: string) {
    const built = await this.buildForRun(runId)
    const existing = await db.erpJournalExport.findUnique({
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

    const created = await db.erpJournalExport.create({
      data: {
        runId: built.run.id,
        runNumber: built.run.runNumber,
        manifestHash: built.hash,
        lineCount: built.manifest.entries.length,
        totalMinor: built.manifest.totalMinor,
        currencyCode: built.run.currencyCode,
        exportedBy,
      },
    })
    await this.events.emit({
      type: 'erp.exported',
      entityType: 'PaymentRun',
      entityId: built.run.id,
      payload: {
        runNumber: built.run.runNumber,
        manifestHash: built.hash,
        totalMinor: built.manifest.totalMinor,
      },
    })
    return { export: created, created: true, ...built }
  }

  list(
    input: Partial<ListInput> & { status?: string } = {},
  ): Promise<ListResult<object>> {
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

  /** Re-derive and verify a stored export's manifest (tamper check). */
  async manifest(exportId: string) {
    const row = await db.erpJournalExport.findUnique({
      where: { id: exportId },
    })
    if (!row) throw new NotFoundException(`Export ${exportId} not found`)
    const built = await this.buildForRun(row.runId)
    if (built.hash !== row.manifestHash) {
      throw new ConflictException(
        `Stored hash for ${row.runNumber} no longer matches the derived manifest`,
      )
    }
    return { export: row, json: built.json, csv: built.csv }
  }

  /**
   * ERP acknowledgement feed — the ERP returns posted/rejected for a
   * consumed journal. Line-level payment outcomes still flow through the
   * payment-run reconcile path; this settles the journal itself.
   */
  async acknowledge(input: {
    exportId: string
    status: 'posted' | 'rejected'
    externalRef?: string | null
    rejectedReason?: string | null
  }) {
    const row = await db.erpJournalExport.findUnique({
      where: { id: input.exportId },
    })
    if (!row) throw new NotFoundException(`Export ${input.exportId} not found`)
    if (row.status !== 'exported') {
      throw new ConflictException(
        `Export for ${row.runNumber} is already ${row.status}`,
      )
    }
    if (input.status === 'rejected' && !input.rejectedReason) {
      throw new ConflictException('A rejection reason is required')
    }

    const updated = await db.erpJournalExport.update({
      where: { id: row.id },
      data: {
        status: input.status,
        externalRef: input.externalRef ?? null,
        rejectedReason:
          input.status === 'rejected' ? (input.rejectedReason ?? null) : null,
        acknowledgedAt: new Date(),
      },
    })
    if (input.status === 'posted') {
      await this.events.emit({
        type: 'erp.posted',
        entityType: 'PaymentRun',
        entityId: row.runId,
        payload: {
          runNumber: row.runNumber,
          externalRef: input.externalRef ?? null,
        },
      })
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
  ) {
    let created = 0
    let updated = 0
    for (const v of vendors) {
      const existing = v.taxId
        ? await db.vendor.findFirst({ where: { taxId: v.taxId } })
        : await db.vendor.findFirst({ where: { name: v.name } })
      if (existing) {
        // Never clobber local lifecycle state (status/blacklist); only
        // refresh descriptive fields the ERP owns.
        await db.vendor.update({
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
        await db.vendor.create({
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

  /**
   * §8.5 reconciliation gate — amount-and-volume checks between aipms and
   * the ERP feed. Divergence here is what finance sees; nothing reconciles
   * silently.
   */
  async reconcileReport() {
    const [executedRuns, exports, unacked] = await Promise.all([
      db.paymentRun.findMany({
        where: { status: { in: ['executed', 'reconciled'] } },
        select: {
          id: true,
          runNumber: true,
          totalMinor: true,
          currencyCode: true,
        },
      }),
      db.erpJournalExport.findMany(),
      db.erpJournalExport.findMany({ where: { status: 'exported' } }),
    ])

    const exportedByRun = new Map(exports.map((e) => [e.runId, e] as const))
    const notExported = executedRuns.filter((r) => !exportedByRun.has(r.id))

    const postedTotal = exports
      .filter((e) => e.status === 'posted')
      .reduce((s, e) => s + e.totalMinor, 0)

    return {
      executedRuns: executedRuns.length,
      exports: exports.length,
      /** Executed runs with no journal export — publishing debt. */
      missingExports: notExported.map((r) => ({
        runId: r.id,
        runNumber: r.runNumber,
        totalMinor: r.totalMinor,
        currencyCode: r.currencyCode,
      })),
      /** Exports consumed but not yet acknowledged by the ERP. */
      awaitingAcknowledgement: unacked.map((e) => ({
        exportId: e.id,
        runNumber: e.runNumber,
        totalMinor: e.totalMinor,
      })),
      postedTotalMinor: postedTotal,
      clean:
        notExported.length === 0 &&
        unacked.every((e) => e.status === 'exported' && unacked.length === 0),
    }
  }
}
