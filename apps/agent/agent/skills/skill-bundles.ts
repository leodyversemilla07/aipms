import { defineSkill } from "eve/skills";
import { z } from "zod";

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   SOURCING SKILL
   — Browse catalog, request vendor quotes, list vendors.
   Used by the sourcing agent to discover suppliers and raise quote requests.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

export const sourcingSkill = defineSkill({
  name: "sourcing",
  description:
    "Skills for discovering vendors and catalog items, and raising quote requests.",
  toolNames: [
    "catalog/list",
    "vendor/list",
    "messaging/submit",
  ],

  /* ── Tool configurations ────────────────────────────────────────────── */
  tools: {
    "catalog/list": {
      input: z.object({
        query: z.string().optional(),
        category: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(50),
      }),
    },
    "vendor/list": {
      input: z.object({
        query: z.string().optional(),
        status: z.enum(["qualified", "pending", "blacklisted"]).optional(),
        limit: z.number().int().min(1).max(200).default(50),
      }),
    },
    "messaging/submit": {
      input: z.object({
        vendorId: z.string(),
        catalogItemSku: z.string(),
        quantity: z.number().int().min(1).default(1),
        notes: z.string().optional(),
        tier: z.enum(["auto", "gated"]).default("auto"),
      }),
    },
  },

  /* ── Default model shapes (what the model sees on each tool call) ──────── */
  modelOutput: {
    "catalog/list": {
      type: "text",
      parse: (output: any) =>
        output.ok
          ? `Found ${output.items?.length ?? 0} catalog item(s)` +
              (output.items?.length
                ? `\n${output.items
                    .slice(0, 5)
                    .map(
                      (i: any) =>
                        `- ${i.sku}: ${i.name} (${i.category ?? "—"}) — ₱${
                          i.defaultPriceMinor != null
                            ? `${(i.defaultPriceMinor / 100).toFixed(2)}`
                            : "no price"
                        }`
                    )
                    .join("\n")}
                : "")`
          : `Catalog list failed: ${output.error}`,
    },
    "vendor/list": {
      type: "text",
      parse: (output: any) =>
        output.ok
          ? `Found ${output.vendors?.length ?? 0} vendor(s)${
              output.vendors?.length
                ? `\n${output.vendors
                    .slice(0, 5)
                    .map(
                      (v: any) =>
                        `- ${v.name} (${v.status}) — ${v.email ?? "no email"}`
                    )
                    .join("\n")}`
                : ""}`
          : `Vendor list failed: ${output.error}`,
    },
    "messaging/submit": {
      type: "text",
      parse: (output: any) =>
        output.ok
          ? `Quote request ${output.status === "approved" ? "submitted" : "pending"} (${
              output.requestId ?? "N/A"
            })`
          : `Quote request failed: ${output.error}`,
    },
  },
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   OPS SKILL
   — Requisition → PO → invoice match basics.
   Used by the ops agent to create requests, issue POs, and run 3-way matches.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

export const opsSkill = defineSkill({
  name: "ops",
  description:
    "Skills for creating requisitions, issuing purchase orders, and running invoice matches.",
  toolNames: [
    "requisition/create",
    "po/issue",
    "invoice/match",
  ],

  tools: {
    "requisition/create": {
      input: z.object({
        idempotencyKey: z.string(),
        name: z.string(),
        description: z.string().optional(),
        budgetId: z.string().optional(),
        items: z.array(
          z.object({
            sku: z.string(),
            quantity: z.number().int().min(1),
            unit: z.string().optional(),
          }),
        ),
      }),
    },
    "po/issue": {
      input: z.object({
        idempotencyKey: z.string(),
        vendorId: z.string(),
        requisitionId: z.string(),
        items: z.array(
          z.object({
            sku: z.string(),
            quantity: z.number().int().min(1),
            unit: z.string().optional(),
          }),
        ),
        notes: z.string().optional(),
      }),
    },
    "invoice/match": {
      input: z.object({
        idempotencyKey: z.string(),
        invoiceId: z.string(),
        poId: z.string(),
        tolerancePct: z.number().default(10),
      }),
    },
  },

  modelOutput: {
    "requisition/create": {
      type: "text",
      parse: (output: any) =>
        output.ok
          ? `Requisition created: ${output.id} (status: ${output.status})`
          : `Requisition creation failed: ${output.error}`,
    },
    "po/issue": {
      type: "text",
      parse: (output: any) =>
        output.ok
          ? `PO issued: ${output.id} (status: ${output.status})`
          : `PO issue failed: ${output.error}`,
    },
    "invoice/match": {
      type: "text",
      parse: (output: any) =>
        output.ok
          ? `3-way match: ${output.match?.outcome ?? "pending"} — ${output.match?.notes ?? ""}`
          : `Invoice match failed: ${output.error}`,
    },
  },
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   AUDIT SKILL
   — Audit trail checks, exception reporting.
   Used by the auditor agent to inspect the system state.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

export const auditSkill = defineSkill({
  name: "audit",
  description:
    "Skills for inspecting audit records, exception queues, and system state.",
  toolNames: [
    "audit/list",
    "audit/meta",
  ],

  tools: {
    "audit/list": {
      input: z.object({
        entity: z.enum(["PurchaseOrder", "Invoice", "Approval", "Requisition"]).optional(),
        entityId: z.string().optional(),
        actorKind: z.enum(["human", "agent"]).optional(),
        limit: z.number().int().min(1).max(200).default(20),
      }),
    },
    "audit/meta": {
      input: z.object({
        entity: z.enum(["PurchaseOrder", "Invoice", "Approval", "Requisition"]).optional(),
      }),
    },
  },

  modelOutput: {
    "audit/list": {
      type: "text",
      parse: (output: any) =>
        output.ok
          ? `Found ${output.total ?? 0} audit record(s)${
              output.total > 0
                ? `\n${output.records
                    .slice(0, 3)
                    .map(
                      (r: any) =>
                        `- ${r.action} by ${r.actorKind} on ${r.entity} ${r.entityId ?? ""} — ${r.at}`
                    )
                    .join("\n")}`
                : ""}`
          : `Audit list failed: ${output.error}`,
    },
    "audit/meta": {
      type: "text",
      parse: (output: any) =>
        output.ok
          ? `Audit system: ${output.totalRecords} total records, ${output.activeAgents} active agents`
          : `Audit meta failed: ${output.error}`,
    },
  },
});