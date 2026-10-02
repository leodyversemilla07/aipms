# Automatic vendor messages

Automatic messages are a narrowly scoped relay, not permission for an agent
to negotiate, award an order, promise payment, or invent business events.
Free-form commercial text remains gated for human approval.

## Version 1 contract

All templates require a verified contact on the selected vendor and no caller
subject/body. Template parameters are strict: unknown keys are rejected.

| Template | Parameters | Server-owned facts |
| --- | --- | --- |
| `rfq` | `{ sku, quantity }` | SKU must resolve to an active catalog item. Quantity is an explicit requested integer from 1 to 999,999; this is a non-binding inquiry, not an approved requisition or PO. |
| `po_status` | `{ poNumber, status }` | PO must belong to this vendor. The requested status must equal the canonical issued, confirmed, or cancelled status. |
| `delivery_notice` | `{ receiptId }` | Recorded receipt and live PO must belong to this vendor. Quantity is summed from receipt lines with one shared safe unit. Cancelled receipts and mixed units are refused. |
| `invoice_ack` | `{ invoiceNumber }` | Invoice must exist under this vendor's unique number. The acknowledgement confirms receipt only, not matching, approval, or payment. |

Identifier tokens allow ASCII letters/digits, dots, underscores, slashes, and
hyphens, with an alphanumeric first character and bounded lengths. Whitespace,
newlines, controls, Unicode bidi/zero-width characters, lookalikes, and prose
delimiters are rejected. Catalog descriptions, receipt notes, vendor names,
and other arbitrary text never enter these automatic bodies.

This intentionally rejects some legitimate but unusual identifiers. Use a
free-form reviewed draft for those identifiers or arbitrary notes; do not
silently normalize them or relabel them as an automatic template.

Example:

```json
{
  "idempotencyKey": "rfq-paper-001",
  "vendorId": "canonical-vendor-id",
  "recipient": "verified-contact@example.test",
  "templateId": "rfq",
  "templateParams": { "sku": "PAPER-A4", "quantity": 3 }
}
```

The backend resolves the catalog entry. A safe-looking invented SKU is still
refused. RFQ quantity is caller intent, not a server-derived financial fact;
it does not reserve a budget, award a quote, or authorize shipment.

## Staging and dispatch

New automatic rows retain `templateVersion=1` and validated `templateParams`
source references. Composition, outbox events, audit, and idempotency commit
before delivery.

Before provider contact, the shared claim transaction checks:

1. Safely unsent staging state and absence of unresolved dispatch history.
2. Canonical recipient/subject/body hash.
3. Current vendor blacklist and verified contact.
4. Supported template provenance.
5. Canonical records and exact server-rendered subject/body again.

Deleted invoices, inactive catalog items, changed PO status, cancelled receipts,
changed receipt quantities/units, and noncanonical bodies are retained as failed
rows without contacting transport. The stored content is not rewritten to make
a stale draft look current. Validation failures retain the reason; infrastructure
errors roll back the claim and remain eligible for a later safe attempt.

These are checks at the claim boundary, not continuous source/contact locks
across SMTP. Facts can change after that transaction commits. They do not
establish exactly-once delivery, legal non-bindingness, or live-provider success.

## Upgrade and legacy rows

Apply `20261002000000_auto_message_provenance` before starting the new API.
The migration adds nullable provenance columns and does **not** invent metadata
for old automatic content.

Unsent legacy automatic rows lack supported provenance. When claimed they are
held as failed without provider contact. Already sent rows are not selected;
ambiguous sending/failed rows are never automatically replayed.

Review retained legacy drafts and provider/dispatch evidence. If a replacement
is appropriate, submit a new reviewed free-form draft with its own idempotency
key. Do not manually stamp a version on an old row, reset sending state, or
treat failed validation as permission to repeat an ambiguous delivery.

**Compatibility change:** `delivery_notice` now acknowledges a recorded receipt.
The old `{ poNumber, quantity }` expected-delivery shape is rejected. Expected
delivery promises require a reviewed free-form draft. Other parameter shapes
are preserved but now require canonical records.

During rollout, stop old API/dispatcher replicas before enabling new writers.
An old binary does not implement this guard and must not remain able to send
legacy rows. Do not roll back to the old dispatcher against retained unsafe
automatic drafts without an explicit operational hold.

See [message dispatch recovery](message-dispatch-recovery.md) for ambiguous
delivery rules. This change does not add stale-sending operator resolution.

## Verification

Database-blocked tests cover all templates, malformed/extra parameters,
canonical ownership and lifecycle checks, unsafe identifiers, mixed units,
versioned staging, legacy provenance, and hash-consistent noncanonical prose.

Guarded PostgreSQL/HTTP tests cover all four positive templates, rejected prose,
invented catalog/status/quantity/invoice claims, deletion/cancellation after
staging, rollback on canonical-reader failure, and legacy-row refusal.
Browser recovery uses a genuinely reviewed gated draft rather than fabricated
automatic provenance. Transports in these tests are injected spies or local
logging; no live SMTP or vendor acceptance is claimed.
