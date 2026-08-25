import { db } from '@workspace/db'
import { afterAll, describe, expect, it } from 'vitest'
import { IntakeService } from '../src/intake/intake.service'
import {
  normalizeDate,
  parseBirEisObject,
  parseStructuredInvoice,
  parseUblInvoice,
  toMinor,
} from '../src/intake/structured-invoice'
import { EventEmitterService } from '../src/shared/events/event-emitter.service'

/**
 * §8.2 structured e-invoicing receive-side parsers (BIR EIS JSON, Peppol
 * UBL 2.1 XML) plus the intake integration path used by intake.ingestStructured.
 */

const suffix = Math.random().toString(36).slice(2, 8)
const docIds: string[] = []
const intakeService = new IntakeService(new EventEmitterService())

afterAll(async () => {
  await db.intakeDocument.deleteMany({ where: { id: { in: docIds } } })
  await db.$disconnect()
})

const eisDoc = {
  EisUniqueId: '20260825AB12345678901234',
  IssueDtm: '20260801',
  InvoiceNumber: `SI-2026-${suffix}`,
  Tin: '123456789',
  BranchCd: '00000',
  SellerName: 'Acme EIS Corp',
  SalesAmt: 1000,
  NetSales: 950,
  TaxTotal: 114, // 12% VAT on net of discounts
  Currency: 'PHP',
  ItemList: [
    {
      Description: 'A4 bond paper',
      Qty: 10,
      UnitPrice: 100,
      GrossAmount: 1000,
    },
    { Description: 'Stapler', Qty: 1, UnitPrice: 50, Amount: 50 },
  ],
}

describe('BIR EIS JSON parser (§8.2)', () => {
  it('maps core fields to the normalized classification', () => {
    const c = parseBirEisObject(eisDoc)
    expect(c.docType).toBe('invoice')
    expect(c.source).toBe('BIR_EIS')
    expect(c.invoiceNumber).toBe(`SI-2026-${suffix}`)
    expect(c.issueDate).toBe('2026-08-01')
    expect(c.supplierTin).toBe('123456789')
    expect(c.currencyCode).toBe('PHP')
    expect(c.netAmountMinor).toBe(95_000)
    expect(c.taxAmountMinor).toBe(11_400)
    expect(c.lines[0]).toMatchObject({
      description: 'A4 bond paper',
      quantity: 10,
      unitPriceMinor: 10_000,
    })
  })

  it('accepts batch-array wrappers and rejects documents without amounts', () => {
    expect(parseBirEisObject([eisDoc]).source).toBe('BIR_EIS')
    expect(() => parseBirEisObject({ EisUniqueId: 'x' })).toThrow(/NetSales/)
  })

  it('derives gross from net + tax when no explicit gross field exists', () => {
    const c = parseBirEisObject({ NetSales: 100, TaxTotal: 12, ItemList: [] })
    expect(c.grossAmountMinor).toBe(11_200)
  })
})

const ublXml = `<?xml version="1.0" encoding="UTF-8"?>
<ubl:Invoice xmlns:ubl="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
             xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
             xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:ID>UBL-${suffix}</cbc:ID>
  <cbc:IssueDate>2026-08-15</cbc:IssueDate>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>Globex Peppol Ltd</cbc:RegistrationName>
        <cbc:CompanyID>987654321</cbc:CompanyID>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty><cac:Party/></cac:AccountingCustomerParty>
  <cac:TaxTotal><cbc:TaxAmount currencyID="PHP">240.00</cbc:TaxAmount></cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:TaxExclusiveAmount currencyID="PHP">2000.00</cbc:TaxExclusiveAmount>
    <cbc:PayableAmount currencyID="PHP">2240.00</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  <cac:InvoiceLine>
    <cbc:InvoicedQuantity unitCode="EA">2</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="PHP">1500.00</cbc:LineExtensionAmount>
    <cac:Item><cbc:Name>Laptop stand</cbc:Name></cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="PHP">750.00</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>
  <cac:InvoiceLine>
    <cbc:LineExtensionAmount currencyID="PHP">500.00</cbc:LineExtensionAmount>
    <cac:Item><cbc:Description>Cable kit</cbc:Description></cac:Item>
  </cac:InvoiceLine>
</ubl:Invoice>`

describe('Peppol UBL XML parser (§8.2)', () => {
  it('maps UBL invoice structure with namespace prefixes stripped', () => {
    const c = parseUblInvoice(ublXml)
    expect(c.source).toBe('PEPPOL_UBL')
    expect(c.invoiceNumber).toBe(`UBL-${suffix}`)
    expect(c.supplierName).toBe('Globex Peppol Ltd')
    expect(c.supplierTin).toBe('987654321')
    expect(c.netAmountMinor).toBe(200_000)
    expect(c.grossAmountMinor).toBe(224_000)
    expect(c.lines).toHaveLength(2)
    expect(c.lines[0]).toEqual({
      description: 'Laptop stand',
      quantity: 2,
      unitPriceMinor: 75_000,
      amountMinor: 150_000,
    })
    expect(c.lines[1].description).toBe('Cable kit')
  })

  it('refuses non-UBL documents instead of guessing', () => {
    expect(() => parseUblInvoice('<html><body>x</body></html>')).toThrow(
      /Not a UBL/,
    )
    expect(() => parseUblInvoice('not xml at all')).toThrow(
      /Malformed|Not a UBL/,
    )
  })
})

describe('shared helpers', () => {
  it('converts decimal pesos to minor units safely', () => {
    expect(toMinor(2240)).toBe(224_000)
    expect(toMinor(0.05)).toBe(5)
    expect(toMinor(1.005)).toBe(101) // half-up on the centavo
    expect(() => toMinor(Number.NaN)).toThrow(/Non-numeric/)
    expect(() => toMinor(Number.MAX_VALUE)).toThrow(/out of range/)
  })

  it('normalizes EIS YYYYMMDD dates to ISO', () => {
    expect(normalizeDate('20260801')).toBe('2026-08-01')
    expect(normalizeDate('2026-08-01')).toBe('2026-08-01')
    expect(normalizeDate('garbage')).toBeNull()
    expect(normalizeDate(undefined)).toBeNull()
  })

  it('routes by channel with readable failures', () => {
    expect(
      parseStructuredInvoice('EINVOICE_EIS', JSON.stringify(eisDoc)).source,
    ).toBe('BIR_EIS')
    expect(() => parseStructuredInvoice('EINVOICE_EIS', '{broken')).toThrow(
      /Invalid BIR EIS JSON/,
    )
    expect(parseStructuredInvoice('PEPPOL_UBL', ublXml).source).toBe(
      'PEPPOL_UBL',
    )
  })
})

describe('structured ingest into the queue (integration)', () => {
  it('enters pre-extracted and dedupes on content hash', async () => {
    const content = JSON.stringify(eisDoc)
    const classified = parseStructuredInvoice('EINVOICE_EIS', content)
    const contentHash =
      Buffer.from(content).toString('base64url').slice(0, 32) + suffix

    const doc = await intakeService.ingest({
      channel: 'EINVOICE_EIS',
      contentHash,
    })
    docIds.push(doc.id)
    const extracted = await intakeService.classify({ id: doc.id, classified })
    expect(extracted.status).toBe('extracted')
    expect((extracted.classified as { source?: string }).source).toBe('BIR_EIS')

    // Same content re-transmitted → same [channel, hash] row.
    const again = await intakeService.ingest({
      channel: 'EINVOICE_EIS',
      contentHash,
    })
    expect(again.id).toBe(doc.id)
  })
})
