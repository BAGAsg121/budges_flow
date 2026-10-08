/**
 * Splitting a Zoho criteria that is too large to read in one search.
 *
 * WHY: Zoho's MCP search fails once a single search passes 2000 records —
 *   {"code":"LIMIT_REACHED","details":{"limit":"2000"},
 *    "message":"maximum response iteration limit reached"}
 * — and it fails by PAGE, mid-iteration, not by refusing up front. Page 11 of a 200-per-page search
 * simply returns an error, so a criteria matching 3,906 leads (the "email missing" sandbox nudge)
 * could not be read at all, and the sync surfaced only a confusing downstream error.
 *
 * The only way to honour such a criteria is to ask for it in pieces. `Created_Time` partitions
 * cleanly and every lead has it, so the criteria is repeated per calendar month with the window
 * ANDed on; the union of the windows is exactly the original criteria.
 *
 * Dependency-free apart from the date formatter, so scripts/verify-changes.mjs can test the split —
 * a wrong window silently drops or duplicates whole months of leads, which is invisible until
 * somebody notices a cohort is short.
 */
import { zohoIstIso } from './nudge-defaults.ts'

/** Zoho's documented per-search ceiling, measured: page 11 of a 200-per-page search fails. */
export const MCP_SEARCH_LIMIT = 2000

export interface MonthWindow {
  from: Date
  to: Date
}

/**
 * Calendar-month windows covering `[fromMonth, to)`.
 *
 * The final window is clipped to `to` rather than running to the end of its month, so the union is
 * exactly the requested range and the newest leads are never excluded.
 *
 * Bounded at 240 windows (20 years): a nonsense start date must not spin, and this CRM's data does
 * not go back further.
 *
 * `monthIndex` is ZERO-BASED, matching Date.UTC and `getUTCMonth()`. It is named that way rather
 * than `month` precisely because writing a test for this with `month: 9` meaning September (it means
 * October) is a mistake that produces a silently empty window list rather than an error.
 */
export function monthWindows(from: { year: number; monthIndex: number }, to: Date): MonthWindow[] {
  const windows: MonthWindow[] = []
  let cursor = new Date(Date.UTC(from.year, from.monthIndex, 1, 0, 0, 0))
  const end = new Date(to.getTime())

  for (let i = 0; i < 240 && cursor < end; i++) {
    const next = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1, 0, 0, 0))
    windows.push({ from: cursor, to: next < end ? next : end })
    cursor = next
  }
  return windows
}

/**
 * AND a Created_Time window onto an existing criteria.
 *
 * Uses the CRM's `+05:30` offset via zohoIstIso, because Zoho compares the criteria literally and
 * rejects a `…Z` suffix on a datetime.
 */
export function withCreatedWindow(criteria: string, from: Date, to: Date): string {
  return `(${criteria}and(Created_Time:greater_than:${zohoIstIso(from)})and(Created_Time:less_than:${zohoIstIso(to)}))`
}
