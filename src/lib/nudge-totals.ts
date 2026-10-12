/**
 * Lifetime engagement totals per nudge.
 *
 * Extracted from the onboarding stats route when the sandbox dashboard needed the same numbers. The
 * alternative was a second copy of the same loop in a second route, which is how "what counts as a
 * failure" starts meaning two different things on two different screens.
 *
 * Kept dependency-free (no database, no Prisma) so scripts/verify-changes.mjs can exercise the
 * counting directly — every number here ends up on a dashboard someone makes decisions from.
 */
import { isDeliveryCapError } from './whatsapp-errors.ts'

export interface NudgeTotals {
  nudgeKey: string
  nudgeName: string | null
  /** Messages the provider ACCEPTED. A later failure flips this, so it is always current state. */
  sent: number
  failed: number
  /** Email: tracking pixel fired. WhatsApp: Meta's `read` receipt. Same column, different meaning. */
  opened: number
  /** Sum of opensCount — one email can be opened several times; `opened` counts it once. */
  opensTotal: number
  replied: number
  /** Delivery-cap drops among the FAILED rows (131049/131050) — retryable, not real errors. */
  capped: number
  /** WhatsApp messages whose button was tapped at least once (from the CTA tracker). */
  clicked: number
  /** Total taps, including repeats by the same person. */
  clicks: number
  lastSentAt: string | null
}

/** The minimum a log row must expose to be counted. */
export interface TotalableLog {
  nudgeId: string
  channel: string
  sentOk: boolean
  opened: boolean
  opensCount?: number | null
  replied: boolean
  sendError?: string | null
  ctaClicks?: number | null
  sentAt: Date | null
}

export function emptyTotals(nudgeKey: string): NudgeTotals {
  return {
    nudgeKey,
    nudgeName: null,
    sent: 0,
    failed: 0,
    opened: 0,
    opensTotal: 0,
    replied: 0,
    capped: 0,
    clicked: 0,
    clicks: 0,
    lastSentAt: null,
  }
}

/**
 * Is this failure Meta dropping the message for a marketing reason rather than a fault?
 *
 * Delegates to the canonical classifier in whatsapp-errors so the log badges, the send path's
 * backoff and every dashboard agree on what a cap is.
 *
 * The bare-code test sits ON TOP of it deliberately: `isDeliveryCapError` reads the code out of
 * Meta's `(code N)` wording, and log rows written by an older formatter carry the number without
 * that wrapper. Dropping them would silently under-count caps on historical data — the exact number
 * an operator uses to decide whether a template is being throttled.
 */
export function isCappedSendError(sendError: string | null | undefined): boolean {
  if (!sendError) return false
  if (isDeliveryCapError(sendError)) return true
  return /\b1310(49|50)\b/.test(sendError)
}

/**
 * Fold log rows into per-nudge totals.
 *
 * `idToKey` maps a nudge id to its key; a log whose nudge is not in the map is ignored rather than
 * being attributed to something else. `into` lets a caller pre-seed keys so a nudge with zero logs
 * still reports zeroes instead of vanishing from the dashboard.
 */
export function accumulateTotals(
  logs: TotalableLog[],
  idToKey: Map<string, string>,
  into: Map<string, NudgeTotals> = new Map()
): Map<string, NudgeTotals> {
  for (const log of logs) {
    const key = idToKey.get(log.nudgeId)
    if (!key) continue
    const t = into.get(key)
    if (!t) continue

    // Only WhatsApp has a cap concept, and only a FAILED row can be capped — a cap IS a
    // non-delivery, so a row that reports sentOk AND a cap error is contradictory. Requiring
    // `!sentOk` keeps the dashboard's "Capped" number meaning what its label says instead of
    // counting messages that actually went out.
    if (log.channel === 'whatsapp' && !log.sentOk && isCappedSendError(log.sendError)) t.capped++

    if (log.sentOk) {
      t.sent++
      if (log.sentAt && (!t.lastSentAt || log.sentAt.toISOString() > t.lastSentAt)) {
        t.lastSentAt = log.sentAt.toISOString()
      }
    } else {
      t.failed++
    }

    if (log.opened) {
      t.opened++
      t.opensTotal += log.opensCount || 0
    }
    if (log.replied) t.replied++

    // Taps only exist for WhatsApp — a tracked template's button is the only click we can see.
    const taps = log.ctaClicks ?? 0
    if (taps > 0) t.clicked++
    t.clicks += taps
  }

  return into
}
