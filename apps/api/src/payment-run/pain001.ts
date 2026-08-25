import { createHash } from 'node:crypto'
import type { BatchManifest } from './batch'

/**
 * §8.6 bank rail emitter — ISO 20022 pain.001.08 (customer credit transfer)
 * derived deterministically from the §8.6 batch manifest. This is the
 * standards-shaped sibling of the flat CSV: same frozen data, same credits,
 * rendered in the message format most bank portals and payment hubs accept
 * for PESONet-style batch credit transfers.
 *
 * Like every money artifact here: amounts are integer minor units upstream
 * and are formatted (÷100, two decimals) only at render time; nothing is
 * recomputed. The emitter never invents data — beneficiary details come from
 * the verified vendor master via the manifest.
 */

export const PAIN_001_NS = 'urn:iso:std:iso:20022:tech:xsd:pain.001.001.08'

/** Instance debtor (the paying org). Unset ⇒ pain.001 is not emitted. */
export interface DebtorConfig {
  name: string
  accountNumber: string
}

export function resolveDebtor(
  env: NodeJS.ProcessEnv = process.env,
): DebtorConfig | null {
  const name = env.AIPMS_PAYMENT_DEBTOR_NAME?.trim()
  const accountNumber = env.AIPMS_PAYMENT_DEBTOR_ACCOUNT?.trim()
  if (!name || !accountNumber) return null
  return { name, accountNumber }
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

/** Minor units → decimal string with exactly two places ("123456" → "1234.56"). */
export function formatAmount(minor: number): string {
  if (!Number.isSafeInteger(minor)) {
    throw new Error(`Amount ${minor} is not a safe integer`)
  }
  const sign = minor < 0 ? '-' : ''
  const abs = Math.abs(minor)
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

function element(name: string, text: string, indent: string): string {
  return `${indent}<${name}>${escapeXml(text)}</${name}>`
}

/**
 * Render one run's credits as pain.001.08 XML. Returns null when no debtor
 * is configured — the CSV hand-off remains fully functional without it, and
 * an unconfigured payer must not produce a transfer message with placeholder
 * debtor details.
 */
export function buildPain001(
  manifest: BatchManifest,
  debtor: DebtorConfig,
): { xml: string; sha256: string } {
  const txs = manifest.credits.map((credit) => {
    return [
      '      <CdtTrfTxInf>',
      '        <PmtId>',
      element(
        'EndToEndId',
        `${manifest.runNumber}-${credit.invoiceNumber}`,
        '          ',
      ),
      '        </PmtId>',
      '        <Amt>',
      `          <InstdAmt Ccy="${escapeXml(credit.currencyCode)}">${formatAmount(credit.amountMinor)}</InstdAmt>`,
      '        </Amt>',
      '        <CdtrAgt>',
      '          <FinInstnId>',
      element('Nm', credit.beneficiary.bank, '            '),
      '          </FinInstnId>',
      '        </CdtrAgt>',
      '        <Cdtr>',
      element('Nm', credit.beneficiary.holder, '          '),
      '        </Cdtr>',
      '        <CdtrAcct>',
      '          <Id>',
      '            <Othr>',
      element('Id', credit.beneficiary.accountNumber, '              '),
      '            </Othr>',
      '          </Id>',
      '        </CdtrAcct>',
      '        <RmtInf>',
      element('Ustrd', credit.memo, '          '),
      '        </RmtInf>',
      '      </CdtTrfTxInf>',
    ].join('\n')
  })

  // Group header count/checksum cover all transactions (§8.6 totals are the
  // frozen compose-time sums — CtrlSum must equal Σ InstdAmt).
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<Document xmlns="${PAIN_001_NS}">`,
    '  <CstmrCdtTrfInitn>',
    '    <GrpHdr>',
    element('MsgId', manifest.runNumber, '      '),
    element('CreDtTm', manifest.executedAt, '      '),
    element('NbOfTxs', String(manifest.lineCount), '      '),
    element('CtrlSum', formatAmount(manifest.totalMinor), '      '),
    '      <InitgPty>',
    element('Nm', debtor.name, '        '),
    '      </InitgPty>',
    '    </GrpHdr>',
    '    <PmtInf>',
    element('PmtInfId', `${manifest.runNumber}-1`, '      '),
    '      <PmtMtd>TRF</PmtMtd>',
    '      <BtchBookg>false</BtchBookg>',
    element('NbOfTxs', String(manifest.lineCount), '      '),
    element('CtrlSum', formatAmount(manifest.totalMinor), '      '),
    '      <Dbtr>',
    element('Nm', debtor.name, '        '),
    '      </Dbtr>',
    '      <DbtrAcct>',
    '        <Id>',
    '          <Othr>',
    element('Id', debtor.accountNumber, '            '),
    '          </Othr>',
    '        </Id>',
    '      </DbtrAcct>',
    ...txs,
    '    </PmtInf>',
    '  </CstmrCdtTrfInitn>',
    '</Document>',
    '',
  ].join('\n')

  return { xml, sha256: createHash('sha256').update(xml).digest('hex') }
}
