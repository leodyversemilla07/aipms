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
2. **Request a quote** using an RFQ template through \`send_message\`.
   Recipients must be verified contacts on the vendor master. Low-risk
   templates auto-send; other content waits for human approval.
3. Browse items with \`catalog_list\`, searching with q and paging with
   page/pageSize. Returned monetary fields are integer minor units.
4. \`request_quote\` sends an RFQ message to a verified recipient; custom
   notes require review. It does not create a structured sourcing Quote.
   Structured quote awards still require the human desk.

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
   \`get_requisition\`. Requisition creation requires the human desk: no
   creation tool is currently exposed. Every mutation carries an idempotency key.
2. Once approved (policy gates decide routing), **issue a PO** against a
   qualified vendor — check budget first with \`get_budget\`.
3. **Record receipts** (\`record_receipt\`) against PO lines as goods
   arrive; over-receipt is refused server-side. Recording a receipt
   re-matches any invoices waiting for goods.
4. Invoices register through intake; the engine runs the three-way match
   deterministically — never adjust match outcomes manually.

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
