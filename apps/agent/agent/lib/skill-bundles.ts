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

1. **Browse the catalog** (\`catalog_list\`) to find items matching the
   requirement — filter by query or category; prices are minor units.
2. **List vendors** (\`vendor_list\`) filtered by status; only approach
   vendors in good standing.
3. **Request a quote** (\`request_quote\`) through the vendor messaging
   relay — recipients must be verified contacts on the vendor master.
   Low-risk RFQ templates auto-send; anything else waits for human
   approval.

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

1. **Create a requisition** with lines (sku, quantity, unit); every
   mutation carries an idempotency key.
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

1. **List audit entries** (\`audit list\`) filtered by entity, actor kind
   (human vs agent), or entity id — newest first.
2. **Check counts** (\`audit meta\`) to sanity-check system activity.
3. For exceptions, report the blocked action, its citations, and the
   gate outcome verbatim; resolution belongs to humans in the cockpit.

## Constraints

- Audit entries are append-only; nothing can correct history, only
  append context.
- Always include \`runId\` when attributing outcomes to an agent run.
`,
})
