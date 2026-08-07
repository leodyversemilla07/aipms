import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  computeTax,
  normalizeTaxPolicy,
  PH_DEFAULT_POLICY,
  type TaxLine,
} from "../src/index"

const goods: TaxLine = { amountMinor: 10_000_00, class: "goods" }
const services: TaxLine = { amountMinor: 5_000_00, class: "services" }
const exempt: TaxLine = {
  amountMinor: 2_000_00,
  class: "goods",
  vatExempt: true,
}

describe("computeTax (§8.4 PH engine)", () => {
  it("computes VAT 12% and EWT 1%/2% on vatable lines", () => {
    const result = computeTax([goods, services], PH_DEFAULT_POLICY)

    assert.equal(result.grossMinor, 15_000_00)
    assert.equal(result.vatableMinor, 15_000_00)
    assert.equal(result.vatMinor, 1_800_00) // 12% of 15,000.00
    assert.equal(result.ewtMinor, 200_00) // 1% of 10,000 + 2% of 5,000 = 100+100
    assert.equal(result.netPayableMinor, 15_000_00 + 1_800_00 - 200_00)
  })

  it("excludes VAT-exempt lines from VAT but not from gross", () => {
    const result = computeTax([goods, exempt], PH_DEFAULT_POLICY)

    assert.equal(result.grossMinor, 12_000_00)
    assert.equal(result.vatableMinor, 10_000_00)
    assert.equal(result.vatMinor, 1_200_00) // 12% of 10,000.00 only
    assert.equal(result.ewtMinor, 120_00) // 1% of 10,000 + 1% of 2,000
  })

  it("is deterministic across calls", () => {
    const a = computeTax([services, goods], PH_DEFAULT_POLICY)
    const b = computeTax([services, goods], PH_DEFAULT_POLICY)
    assert.deepEqual(a, b)
  })

  it("rounds per line and never produces fractional centavos", () => {
    const odd: TaxLine = { amountMinor: 333_33, class: "services" } // 2% = 6.6666
    const result = computeTax([odd], PH_DEFAULT_POLICY)
    assert.equal(result.vatMinor, 4_000) // round(333.33 × 12%) = ₱40.00
    assert.equal(result.ewtMinor, 667) // round(333.33 × 2%) = ₱6.67
    assert.equal(result.netPayableMinor, 333_33 + 4_000 - 667)
  })
})

describe("normalizeTaxPolicy", () => {
  it("fills PH defaults for missing rates", () => {
    const policy = normalizeTaxPolicy({ vatRateBps: 1200 })
    assert.equal(policy.vatRateBps, 1200)
    assert.equal(policy.ewtRatesBps.goods, 100)
    assert.equal(policy.ewtRatesBps.services, 200)
  })

  it("overrides configured rates", () => {
    const policy = normalizeTaxPolicy({
      vatRateBps: 0,
      ewtRatesBps: { services: 300 },
    })
    assert.equal(policy.vatRateBps, 0)
    assert.equal(policy.ewtRatesBps.services, 300)
    assert.equal(policy.ewtRatesBps.goods, 100)
  })

  it("ignores garbage input safely", () => {
    const policy = normalizeTaxPolicy(undefined)
    assert.equal(policy.vatRateBps, 1200)
  })
})
