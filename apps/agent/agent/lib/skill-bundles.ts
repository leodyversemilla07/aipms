import { defineSkill } from "eve/skills"

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   SKILL BUNDLES

   eve ≥0.31 skills are instruction packages: identity is path-derived,
   input contracts live on each tool's `inputSchema`, and model-facing
   rendering lives on each tool's `toModelOutput`. These bundles carry the
   procedural guidance for each specialist role.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

export const sourcingSkill = defineSkill({
  description:
    "Skills for discovering vendors and catalog items, and raising quote requests.",
  markdown: `
# Sourcing

Discover suppliers and raise quote requests.

## Workflow

1. **List vendors** (\`list_vendors\`); only approach vendors in good standing.
2. Open durable quote records with \`open_rfq\` for an approved requisition.
3. Send each invitation with \`request_quote\` through the controlled messaging
   relay. Recipients must be verified vendor contacts; custom notes wait for
   human approval. Opening an RFQ does not itself send a message.
4. Record normalized offers with \`record_quote\`, then use \`compare_quotes\`
   for deterministic policy ranking. Use \`list_quotes\` to resume an earlier run.
5. Browse items with \`catalog_list\`, searching with q and paging with
   page/pageSize. Monetary fields are integer minor units.
6. Stop after comparison. A human procurement user must award the quote.

## Constraints

- Never message a raw address outside the relay.
- Report money as integer minor units; never convert silently.
`,
})

export const opsSkill = defineSkill({
  description:
    "Skills for creating requisitions, issuing purchase orders, and running invoice matches.",
  markdown: `
# Operations

Requisition → PO → three-way match basics.

## Workflow

1. Find existing requisitions with \`list_requisitions\` and
   \`get_requisition\`, or create a draft with \`create_requisition\`. Every
   line uses integer minor units and one matching currency.
2. Submit a draft with \`submit_requisition\`. Stop on NEED_APPROVAL or BLOCK;
   only the assigned human approval route may decide it. Every mutation uses
   the stable eve call identity as its default idempotency key.
3. Once approved and any required sourcing award is complete, **issue a PO**
   against a qualified vendor — check budget first with \`get_budget\`.
4. **Record receipts** (\`record_receipt\`) against PO lines as goods arrive;
   over-receipt is refused server-side. Recording a receipt re-matches any
   invoices waiting for goods.
5. For unstructured intake, use \`get_intake_document\` before
   \`classify_document\`. The projection is server-redacted and omits binary
   bodies; never reconstruct or request payment credentials. If usable invoice
   content is unavailable, stop for OCR/human review rather than guessing.
6. Register a validated classification with \`register_invoice\`; the engine
   runs the three-way match deterministically. Never adjust match outcomes.

## Constraints

- Agents prepare documents but never countersign POs.
- If a gate returns NEED_APPROVAL or BLOCK, stop and report verbatim.
`,
})

export const auditSkill = defineSkill({
  description:
    "Skills for inspecting audit records, exception queues, and system state.",
  markdown: `
# Audit

Inspect audit trail records, exception queues, and system state.

## Workflow

1. Inspect available domain events with \`poll_events\`; these are not a
   substitute for the complete audit trail.
2. Direct audit-list and audit-meta tools are not exposed. Refer the human
   to the Audit desk for records and verification; do not invent tool calls.
3. For exceptions, report the blocked action, its citations, and the
   gate outcome verbatim; resolution belongs to humans in the cockpit.

## Constraints

- Audit entries are append-only; nothing can correct history, only
  append context.
- Include \`runId\` when returned by the system; never invent attribution.
`,
})
