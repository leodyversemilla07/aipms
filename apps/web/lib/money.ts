/** §8.4 — money is minor-unit integers (centavos). Display helper only. */
export function minorToPhp(minor: number): string {
  return `₱${(minor / 100).toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}
