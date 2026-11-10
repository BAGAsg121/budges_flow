/**
 * "Why was this lead messaged?" — in words that can be written into a CRM note.
 *
 * Extracted from the sandbox dispatcher so that EVERY nudge send records the same answer, not just
 * the CRM-change path. A note that only says "sent" cannot answer the question actually asked later
 * ("why did this person get a message?"), and the answer otherwise lives only in an ephemeral
 * response body.
 *
 * Prefers the stored Zoho criteria because that is literally the condition; the filter JSON is the
 * fallback, with the bookkeeping keys removed so the note stays readable.
 *
 * Dependency-free on purpose: both the dispatcher and the run engine use it.
 */

export interface WhySource {
  zohoCriteria?: string | null
  filters?: string | null
}

/** Bookkeeping keys that say nothing about WHO was selected. */
const NOISE = new Set(['category', 'requirePhone', 'requireEmail', 'dedupeByEmail', 'everyHours'])

export function whyMatched(nudge: WhySource): string {
  const criteria = (nudge.zohoCriteria || '').trim()
  if (criteria) return criteria
  try {
    const f = JSON.parse(nudge.filters || '{}') as Record<string, unknown>
    const bits = Object.entries(f)
      .filter(([k]) => !NOISE.has(k))
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    if (bits.length) return bits.join(', ')
  } catch {
    /* fall through */
  }
  return "matched this nudge's filters"
}
