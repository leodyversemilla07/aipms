/** Format an ISO/Date timestamp for desk feeds (local time). */
export function fmtTime(at: string | Date): string {
  return new Date(at).toLocaleString()
}
