/**
 * An in-memory log of inbound CRM webhook deliveries.
 *
 * WHY THIS EXISTS: both hooks answer `401` for a bad secret and `400` for a malformed payload, and in
 * neither case is anything written to the database — by design, because a rejected delivery must not
 * touch lead data. But that makes "nothing in the database" ambiguous between *the CRM never called
 * us* and *it called us and we refused*, and those need completely different fixes. Without this, the
 * only way to tell them apart is the CRM's own webhook log, which is on the other side of the problem.
 *
 * Deliberately NOT a database table: this is diagnostic, it is expected to be lost on a restart, and
 * the standing rule against adding tables still applies. If the buffer is empty after a redeploy that
 * is a fact about the process, not about the CRM.
 *
 * Records the OUTCOME, never the whole payload — a webhook body can carry personal data, and this is
 * a debugging aid, not a second copy of the lead.
 */

export interface DeliveryAttempt {
  at: string
  /** Which hook: 'lead' for a stage change, 'nudge:<key>' for a nudge trigger. */
  hook: string
  /** HTTP status we answered with. */
  status: number
  /** 'accepted' | 'unauthorized' | 'bad_payload' | 'not_found' | 'error' */
  outcome: string
  /** Human-readable reason for a refusal. */
  reason?: string | null
  /** The lead id we read from the payload, when there was one. */
  leadId?: string | null
  /** The field names the payload carried — enough to spot a missing id without storing its values. */
  fields?: string[]
  /** What we did or would do, e.g. "stage_changed: Documents Pending → Agreement Signed". */
  detail?: string | null
}

const MAX = 50
const globalForInbox = globalThis as unknown as { __webhookInbox?: DeliveryAttempt[] }

// Survives module reloads in dev / on the same instance, which is where this is actually read.
const buffer: DeliveryAttempt[] = (globalForInbox.__webhookInbox ??= [])

export function recordDelivery(entry: Omit<DeliveryAttempt, 'at'>): DeliveryAttempt {
  const full: DeliveryAttempt = { at: new Date().toISOString(), ...entry }
  buffer.unshift(full)
  if (buffer.length > MAX) buffer.length = MAX
  // Also to stdout, because on a host whose logs are readable this is the fastest path to an answer.
  // Quietable so a test that records 60 entries does not bury its own output.
  if (process.env.WEBHOOK_INBOX_QUIET !== 'true') {
    console.log(
      `[webhook] ${full.hook} ${full.status} ${full.outcome}${full.leadId ? ` lead=${full.leadId}` : ''}` +
        `${full.reason ? ` — ${full.reason}` : ''}${full.detail ? ` — ${full.detail}` : ''}`
    )
  }
  return full
}

/** Most recent attempts, newest first. */
export function recentDeliveries(limit = 20): DeliveryAttempt[] {
  return buffer.slice(0, Math.max(1, Math.min(limit, MAX)))
}

/** Counts by outcome, so "did anything arrive at all" is one line. */
export function deliverySummary(): {
  total: number
  byOutcome: Record<string, number>
  lastAt: string | null
} {
  const byOutcome: Record<string, number> = {}
  for (const d of buffer) byOutcome[d.outcome] = (byOutcome[d.outcome] ?? 0) + 1
  return { total: buffer.length, byOutcome, lastAt: buffer[0]?.at ?? null }
}
