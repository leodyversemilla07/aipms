import { defineTool } from "eve/tools";
import { z } from "zod";

/**
 * Sourcing agent tools — browse catalog, request vendor quotes.
 * All tools are authenticated via AIPMS_SERVICE_TOKEN (Bearer auth).
 * Returns are normalized for the model; errors are surface-level only.
 */

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

export default defineTool({
  description:
    "List catalog items, optionally filtered by search query and category.",
  inputSchema: z.object({
    query: z.string().optional(),
    category: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  async execute({ query, category, limit }) {
    const token = process.env.AIPMS_SERVICE_TOKEN;
    if (!token) return { error: "AIPMS_SERVICE_TOKEN not configured" };

    const res = await fetch(`${process.env.AIPMS_API_URL}/api/catalog/list`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query, category, limit: limit ?? 50 }),
    });
    if (!res.ok) {
      const txt = await res.text();
      return { error: `catalog/list ${res.status}: ${txt.slice(0, 200)}` };
    }
    return { ok: true, ...(await res.json()) };
  },

  toModelOutput(output) {
    if (output.error) return { type: "text", value: `Catalog list failed: ${output.error}` };
    const items = (output as any)?.items ?? [];
    return {
      type: "text",
      value: `Found ${items.length} catalog item(s)${
        items.length
          ? `\n${items
              .slice(0, 5)
              .map(
                (i: any) =>
                  `- ${i.sku}: ${i.name} (${i.category || "—"}) — ₱${
                    i.defaultPriceMinor != null
                      ? `${(i.defaultPriceMinor / 100).toFixed(2)}`
                      : "no price"
                  }`
              )
              .join("\n")}`
          : ""}`,
    };
  },
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

export default defineTool({
  description:
    "List vendors, optionally filtered by status and search query.",
  inputSchema: z.object({
    query: z.string().optional(),
    status: z.enum(["qualified", "pending", "blacklisted"]).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  async execute({ query, status, limit }) {
    const token = process.env.AIPMS_SERVICE_TOKEN;
    if (!token) return { error: "AIPMS_SERVICE_TOKEN not configured" };

    const res = await fetch(`${process.env.AIPMS_API_URL}/api/vendor/list`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query, status, limit: limit ?? 50 }),
    });
    if (!res.ok) {
      const txt = await res.text();
      return { error: `vendor/list ${res.status}: ${txt.slice(0, 200)}` };
    }
    return { ok: true, ...(await res.json()) };
  },

  toModelOutput(output) {
    if (output.error) return { type: "text", value: `Vendor list failed: ${output.error}` };
    const vendors = (output as any)?.vendors ?? [];
    return {
      type: "text",
      value: `Found ${vendors.length} vendor(s)${
        vendors.length
          ? `\n${vendors
              .slice(0, 5)
              .map((v: any) => `- ${v.name} (${v.status}) — ${v.email ?? "no email"}`)
              .join("\n")}`
          : ""}`,
    };
  },
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

export default defineTool({
  description:
    "Request a vendor quote for a catalog item. The agent sends a structured quote request to the vendor relay.",
  inputSchema: z.object({
    vendorId: z.string(),
    catalogItemSku: z.string(),
    quantity: z.number().int().min(1).optional(),
    notes: z.string().optional(),
  }),
  async execute({ vendorId, catalogItemSku, quantity, notes }) {
    const token = process.env.AIPMS_SERVICE_TOKEN;
    if (!token) return { error: "AIPMS_SERVICE_TOKEN not configured" };

    const res = await fetch(`${process.env.AIPMS_API_URL}/api/messaging/submit`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        vendorId,
        catalogItemSku,
        quantity: quantity ?? 1,
        notes,
        tier: "auto", // low-risk: RFQ / status inquiry
      }),
    });
    if (!res.ok) {
      const txt = await res.text();
      return { error: `messaging/submit ${res.status}: ${txt.slice(0, 200)}` };
    }
    return { ok: true, ...(await res.json()) };
  },

  toModelOutput(output) {
    if (output.error)
      return { type: "text", value: `Quote request failed: ${output.error}` };
    const { requestId, status } = output as any;
    return {
      type: "text",
      value: `Quote request ${status === "approved" ? "submitted" : "pending"} (${requestId ?? "N/A"})`,
    };
  },
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

export default defineTool({
  description:
    "List budget envelopes for a cost center/period. Reads budget state; no mutation.",
  inputSchema: z.object({
    costCenter: z.string().optional(),
    period: z.string().optional(),
    limit: z.number().int().min(1).max(12).optional(),
  }),
  async execute({ costCenter, period, limit }) {
    const token = process.env.AIPMS_SERVICE_TOKEN;
    if (!token) return { error: "AIPMS_SERVICE_TOKEN not configured" };

    const res = await fetch(`${process.env.AIPMS_API_URL}/api/budget/list`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ costCenter, period, limit: limit ?? 12 }),
    });
    if (!res.ok) {
      const txt = await res.text();
      return { error: `budget/list ${res.status}: ${txt.slice(0, 200)}` };
    }
    return { ok: true, ...(await res.json()) };
  },

  toModelOutput(output) {
    if (output.error)
      return { type: "text", value: `Budget list failed: ${output.error}` };
    const budgets = (output as any)?.budgets ?? [];
    return {
      type: "text",
      value: `Found ${budgets.length} budget envelope(s)${
        budgets.length
          ? `\n${budgets
              .slice(0, 3)
              .map(
                (b: any) =>
                  `- ${b.costCenter} · limit ₱${(b.limit / 100).toFixed(2)} · spent ₱${
                    (b.spent / 100).toFixed(2)
                  } · committed ₱${(b.committed / 100).toFixed(2)}`
              )
              .join("\n")}`
          : ""}`,
    };
  },
});