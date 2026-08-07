/** §8.4 — money is minor-unit integers (centavos). Display helper only. */
export function minorToPhp(minor: number): string {
  return `₱${(minor / 100).toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

/** Parse a ₱ decimal string into minor units. Returns null on invalid/negative. */
export function phpToMinor(text: string): number | null {
  const cleaned = text.trim().replace(/[,\s]|₱/g, "")
  const n = Number(cleaned)
  if (!Number.isFinite(n) || n < 0 || n > 9_999_999_999) return null
  return Math.round(n * 100)
}
