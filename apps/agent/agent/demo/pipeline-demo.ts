/* ── AIPMS Agent Pipeline Demo ─────────────────────────────────────────────
   This script demonstrates the Phase 3 agent skills framework by running the
   agent through the full procurement pipeline: browse → quote → requisition → PO → match.

   Prerequisites:
   - AIPMS_SERVICE_TOKEN must be set in the environment
   - AIPMS_API_URL must point to a running API instance
   - The API must have data (catalog items, vendors, etc.)

   The agent uses the eve framework's tool surface to call the API tRPC procedures
   directly, authenticated via Bearer token.
─────────────────────────────────────────────────────────────────────────────── */
import { providerCall } from "./config/agent-config"
import { sourcingSkill, opsSkill } from "./skills/skill-bundles"

// ---------------------------------------------------------------------------
// 1. HELPERS
// ---------------------------------------------------------------------------

/** Format bytes/ints as PHP amounts (minor → pesos). */
function minorToPhp(minor: number): string {
  return (minor / 100).toFixed(2)
}

/** Sleep helper for demo pacing. */
function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

// ---------------------------------------------------------------------------
// 2. DEMO CONFIG
// ---------------------------------------------------------------------------

const DEMO = {
  /** How many catalog items to fetch */
  catalogLimit: 5,

  /** How many vendors to list */
  vendorLimit: 5,

  /** Pacing between agent steps (ms) */
  stepDelay: 1500,
}

/* ── API base ─────────────────────────────────────────────────────────────── */
const API_BASE = process.env.AIPMS_API_URL ?? "http://localhost:3001"

/* ── 3. DEMO STEP: LIST CATALOG ──────────────────────────────────────────── */
async function demoListCatalog() {
  console.log("\n🛒 Step 1: Browsing catalog items…")
  const result = await providerCall(
    "List available catalog items for the procurement agent",
    `List the first ${DEMO.catalogLimit} catalog items, showing sku, name, category, and price in PHP.`
  )

  // The mock response format from providerCall — parse what we can
  const items = (result as any)?.items ?? []
  console.log(`   Found ${items.length} catalog item(s)`)
  items.slice(0, DEMO.catalogLimit).forEach((item: any, i: number) => {
    const price = item.defaultPriceMinor != null ? minorToPhp(item.defaultPriceMinor) : "no price"
    console.log(`   ${i + 1}. ${item.sku} — ${item.name} (${item.category ?? "—"}) — ₱${price}`)
  })

  // Also use the sourcingSkill's built-in parsing
  const skillResult = sourcingSkill.tools["catalog/list"].modelOutput.parse(result)
  console.log(`   Skill report: ${skillResult}`)
}

// ---------------------------------------------------------------------------
// 3. DEMO STEP: LIST VENDORS
// ---------------------------------------------------------------------------
async function demoListVendors() {
  console.log("\n👥 Step 2: Listing vendors…")
  const result = await providerCall(
    "List qualified vendors for the procurement agent",
    `List the first ${DEMO.vendorLimit} qualified vendors, showing name, status, and contact email.`
  )

  const vendors = (result as any)?.vendors ?? []
  console.log(`   Found ${vendors.length} vendor(s)`)
  vendors.slice(0, DEMO.vendorLimit).forEach((v: any, i: number) => {
    console.log(`   ${i + 1}. ${v.name} (${v.status}) — ${v.email ?? "no email"}`)
  })

  const skillResult = sourcingSkill.tools["vendor/list"].modelOutput.parse(result)
  console.log(`   Skill report: ${skillResult}`)
}

// ---------------------------------------------------------------------------
// 4. DEMO STEP: REQUEST VENDOR QUOTE
// ---------------------------------------------------------------------------
async function demoRequestQuote() {
  console.log("\n📧 Step 3: Requesting vendor quote…")
  // Use the first vendor and first catalog item from earlier steps
  const vendors = (await providerCall("dummy", "dummy")).vendors ?? []
  const catalogItems = (await providerCall("dummy", "dummy")).items ?? []

  if (vendors.length === 0 || catalogItems.length === 0) {
    console.log("   ⚠️  No vendors or catalog items available — skipping quote request")
    return
  }

  const vendorId = vendors[0].id
  const catalogItemSku = catalogItems[0].sku

  const result = await providerCall(
    "Request a vendor quote for a catalog item",
    `Request a quote from vendor ${vendorId} for catalog item ${catalogItemSku}, quantity 1, notes: "Procurement demo."`
  )

  console.log(`   Quote request status: ${result.ok ? "submitted" : "pending/error: " + (result as any)?.error}`)
  const skillResult = sourcingSkill.tools["messaging/submit"].modelOutput.parse(result)
  console.log(`   Skill report: ${skillResult}`)
}

// ---------------------------------------------------------------------------
// 5. DEMO STEP: CREATE REQUISITION
// ---------------------------------------------------------------------------
async function demoCreateRequisition() {
  console.log("\n📋 Step 4: Creating a requisition…")
  const result = await providerCall(
    "Create a requisition for office supplies",
    `Create a requisition with the following items:\n- SKU: OFFICE-001, quantity: 10, unit: each\n- SKU: OFFICE-002, quantity: 5, unit: each\n- Budget: ENG-2024, priority: high`
  )

  console.log(`   Requisition status: ${result.ok ? "created" : "failed: " + (result as any)?.error}`)
  const skillResult = opsSkill.tools["requisition/create"].modelOutput.parse(result)
  console.log(`   Skill report: ${skillResult}`)
}

// ---------------------------------------------------------------------------
// 6. DEMO STEP: ISSUE PURCHASE ORDER
// ---------------------------------------------------------------------------
async function demoIssuePO() {
  console.log("\n📦 Step 5: Issuing a purchase order…")
  const result = await providerCall(
    "Issue a purchase order for office supplies from a vendor",
    `Issue a PO for the following items to vendor VENDOR-001:\n- SKU: OFFICE-001, quantity: 10, unit: each, unit price: 50 PHP\n- SKU: OFFICE-002, quantity: 5, unit: each, unit price: 30 PHP\n- Notes: Initial order for new office set up.`
  )

  console.log(`   PO status: ${result.ok ? "issued" : "failed: " + (result as any)?.error}`)
  const skillResult = opsSkill.tools["po/issue"].modelOutput.parse(result)
  console.log(`   Skill report: ${skillResult}`)
}

// ---------------------------------------------------------------------------
// 7. DEMO STEP: RUN 3-WAY MATCH
// ---------------------------------------------------------------------------
async function demoRunMatch() {
  console.log("\n🔍 Step 6: Running 3-way invoice match…")
  const result = await providerCall(
    "Run 3-way match between PO, receipt, and invoice",
    `Run a 3-way match with 10% tolerance for PO PO-001, invoice INV-2024-001, and receipt REC-2024-001.`
  )

  console.log(`   Match outcome: ${result.ok ? result.outcome ?? "unknown" : "failed: " + (result as any)?.error}`)
  const skillResult = opsSkill.tools["invoice/match"].modelOutput.parse(result)
  console.log(`   Skill report: ${skillResult}`)
}

// ---------------------------------------------------------------------------
// 8. RUN THE PIPELINE
// ---------------------------------------------------------------------------

async function main() {
  console.log("=" .repeat(60))
  console.log("🤖 AIPMS Agent Pipeline Demo")
  console.log("=" .repeat(60))

  await demoListCatalog()
  await delay(DEMO.stepDelay)
  await demoListVendors()
  await delay(DEMO.stepDelay)
  await demoRequestQuote()
  await delay(DEMO.stepDelay)
  await demoCreateRequisition()
  await delay(DEMO.stepDelay)
  await demoIssuePO()
  await delay(DEMO.stepDelay)
  await demoRunMatch()

  console.log("\n" + "=" .repeat(60))
  console.log("✅ Pipeline demo complete")
  console.log("=" .repeat(60))
  console.log(
    "\n💡 Next steps: \n" +
    "• Set AIPMS_SERVICE_TOKEN and AIPMS_API_URL to point at a running API\n" +
    "• The agent used providerCall() which routes to cloud or offline LLM per config\n" +
    "• Real API calls would create actual requisitions, POs, and invoice matches\n" +
    "• See apps/agent/agent/skills/ for the full skill definitions"
  )
}

main().catch((err) => {
  console.error("❌ Pipeline demo failed:", err)
  process.exit(1)
})