/**
 * V2 — the lead journey: engagement scoring and nudge→stage attribution.
 *
 * Kept dependency-free (no database, no Prisma) so scripts/verify-changes.mjs can test the maths
 * directly. Every function takes its inputs explicitly; the env-var getters are separate.
 *
 * TWO THINGS THIS MODULE IS CAREFUL NOT TO CLAIM:
 *
 *  1. **Attribution is probabilistic, not causal.** `pickAttribution()` says "this nudge was the
 *     last thing we sent before the status changed", never "this nudge caused it". The stage may
 *     have moved for a hundred reasons we cannot see — a phone call, a competitor, an internal
 *     approval. The window exists to bound the guess, not to justify it.
 *
 *  2. **Scores do not affect sending.** The score is a reporting and prioritisation tool. Run
 *     eligibility remains entirely the filters' business (status, KYC counts, business vertical).
 *     Nothing in the send path reads engagementScore, and that is deliberate.
 */

/** The subset of a MessageLog row the journey logic needs. */
export interface JourneyLog {
  id: string
  nudgeId: string
  channel: string
  messageNumber: number
  sentOk: boolean
  sentAt: Date | null
  opened: boolean
  replied: boolean
  /** Our column is `ctaClicks`; the V2 document calls it `ctaClickCount`. Same thing. */
  ctaClicks: number
  ctaClickedAt: Date | null
}

/* ────────────────────────────── configuration ────────────────────────────── */

/** Max hours after a send to credit a stage change to that nudge. */
export function attributionWindowHours(): number {
  const raw = Number(process.env.ATTRIBUTION_WINDOW_HOURS ?? 72)
  return Number.isFinite(raw) && raw > 0 ? raw : 72
}

/** Maximum score. Lowering this re-scales the bands, so it is a cap rather than a constant. */
export function scoreMax(): number {
  const raw = Number(process.env.SCORE_MAX ?? 100)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 100
}

/** How often the background recalculation runs. */
export function scoreRecalcIntervalMinutes(): number {
  const raw = Number(process.env.SCORE_RECALC_INTERVAL_MINUTES ?? 60)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 60
}

/** Detect stage changes on every Zoho sync (rather than only on demand). */
export function journeySyncOnFetch(): boolean {
  return (process.env.JOURNEY_SYNC_ON_FETCH ?? 'true') !== 'false'
}

/* ─────────────────────────────── the score ─────────────────────────────── */

/** The signal weights, exactly as specified in the V2 document. */
export const SCORE_WEIGHTS = {
  whatsappSent: 2,
  whatsappSentCap: 10,
  emailSent: 1,
  opened: 5,
  replied: 15,
  ctaClicked: 20,
  ctaRepeatBonus: 10,
  ctaRepeatThreshold: 2,
  statusChanged: 25,
} as const

export type ScoreBand = 'cold' | 'warming' | 'engaged' | 'hot'

export interface ScoreBreakdown {
  whatsappSent: number
  emailSent: number
  opened: number
  replied: number
  ctaClicked: number
  ctaRepeatBonus: number
  statusChanged: number
}

export interface ScoreResult {
  score: number
  band: ScoreBand
  breakdown: ScoreBreakdown
  /** Raw counts behind the breakdown, so the UI can explain the arithmetic. */
  counts: {
    whatsappSent: number
    emailSent: number
    opened: number
    replied: number
    ctaClicks: number
    statusChanges: number
  }
  /** True when the clamp actually bit — the UI can then say the score is at the ceiling. */
  capped: boolean
}

/**
 * Compute the engagement score from a lead's message history.
 *
 * `statusChanges` is the number of detected CRM stage transitions for this lead, passed in rather
 * than queried, so this stays pure.
 *
 * The two caps matter and are not decoration:
 *   • WhatsApp sends stop counting after `whatsappSentCap`. Being sent to repeatedly is not
 *     engagement — without the cap, a long sequence would inflate the score of someone who never
 *     opened anything.
 *   • The final score is clamped to `scoreMax`.
 */
export function computeScore(
  logs: JourneyLog[],
  statusChanges: number,
  opts: { max?: number } = {}
): ScoreResult {
  const max = opts.max ?? scoreMax()

  // Only successful sends are engagement. A failed attempt reached nobody.
  const delivered = logs.filter((l) => l.sentOk)

  const whatsappSends = delivered.filter((l) => l.channel === 'whatsapp').length
  const emailSends = delivered.filter((l) => l.channel === 'email').length
  // "Per unique open": one point award per message that was actually opened, not per pixel hit.
  const opens = delivered.filter((l) => l.opened).length
  // A reply is a single signal however many times it happened.
  const replied = delivered.some((l) => l.replied) ? 1 : 0
  const clicked = delivered.filter((l) => l.ctaClickedAt !== null).length > 0 ? 1 : 0
  const totalClicks = delivered.reduce((n, l) => n + (l.ctaClicks || 0), 0)
  const repeatBonus = Math.max(...delivered.map((l) => l.ctaClicks || 0), 0) >= SCORE_WEIGHTS.ctaRepeatThreshold ? 1 : 0
  const changed = statusChanges > 0 ? 1 : 0

  const breakdown: ScoreBreakdown = {
    whatsappSent: Math.min(whatsappSends * SCORE_WEIGHTS.whatsappSent, SCORE_WEIGHTS.whatsappSentCap),
    emailSent: emailSends * SCORE_WEIGHTS.emailSent,
    opened: opens * SCORE_WEIGHTS.opened,
    replied: replied * SCORE_WEIGHTS.replied,
    ctaClicked: clicked * SCORE_WEIGHTS.ctaClicked,
    ctaRepeatBonus: repeatBonus * SCORE_WEIGHTS.ctaRepeatBonus,
    statusChanged: changed * SCORE_WEIGHTS.statusChanged,
  }

  const raw = Object.values(breakdown).reduce((a, b) => a + b, 0)

  return {
    score: Math.min(raw, max),
    band: scoreBand(Math.min(raw, max)),
    breakdown,
    counts: {
      whatsappSent: whatsappSends,
      emailSent: emailSends,
      opened: opens,
      replied,
      ctaClicks: totalClicks,
      statusChanges,
    },
    capped: raw > max,
  }
}

/** The bands from the V2 document. Thresholds are absolute, as specified. */
export function scoreBand(score: number): ScoreBand {
  if (score <= 20) return 'cold'
  if (score <= 45) return 'warming'
  if (score <= 70) return 'engaged'
  return 'hot'
}

export const SCORE_BAND_LABEL: Record<ScoreBand, string> = {
  cold: 'Cold',
  warming: 'Warming',
  engaged: 'Engaged',
  hot: 'Hot',
}

/* ──────────────────────────── stage attribution ──────────────────────────── */

export interface Attribution {
  nudgeId: string
  messageLogId: string
  messageNumber: number
  hoursSinceNudge: number
}

/**
 * Which nudge gets credited for a stage change, if any.
 *
 * The rule from the document: the most recent SUCCESSFUL send, when it happened within the window
 * before the change. Returns null when nothing qualifies — which is recorded as "organic change,
 * no attribution" rather than being silently attached to an old nudge.
 *
 * A log with no `sentAt` cannot be attributed: it never went out, so it cannot be the last thing
 * the lead saw.
 */
export function pickAttribution(
  logs: JourneyLog[],
  detectedAt: Date,
  windowHours: number = attributionWindowHours()
): Attribution | null {
  const windowMs = windowHours * 60 * 60 * 1000

  const candidates = logs
    .filter((l) => l.sentOk && l.sentAt instanceof Date)
    .filter((l) => {
      const at = (l.sentAt as Date).getTime()
      return at <= detectedAt.getTime() && detectedAt.getTime() - at <= windowMs
    })
    .sort((a, b) => (b.sentAt as Date).getTime() - (a.sentAt as Date).getTime())

  const best = candidates[0]
  if (!best) return null

  return {
    nudgeId: best.nudgeId,
    messageLogId: best.id,
    messageNumber: best.messageNumber,
    hoursSinceNudge: Math.round(((detectedAt.getTime() - (best.sentAt as Date).getTime()) / 3_600_000) * 100) / 100,
  }
}

/* ─────────────────────────────── time maths ─────────────────────────────── */

/**
 * Hours spent in the previous stage.
 *
 * Null when there is no prior timestamp to measure from — a lead's FIRST observed status has no
 * "previous stage", and reporting 0 would claim it spent no time there.
 */
export function timeInPrevStageHours(previousChangedAt: Date | null, detectedAt: Date): number | null {
  if (!previousChangedAt) return null
  const hours = (detectedAt.getTime() - previousChangedAt.getTime()) / 3_600_000
  return hours < 0 ? null : Math.round(hours * 100) / 100
}

/** Days from the first nudge to a stage change, for time-to-conversion. Null when unknown. */
export function daysBetween(firstNudgeSentAt: Date | null, at: Date): number | null {
  if (!firstNudgeSentAt) return null
  const ms = at.getTime() - firstNudgeSentAt.getTime()
  if (ms < 0) return null
  return Math.round((ms / 86_400_000) * 100) / 100
}

/**
 * The stage that means "converted", used to decide when `totalDaysToConvert` is stamped.
 *
 * Configurable because the CRM's vocabulary is not ours to hard-code forever: a lead that is
 * "Closed Won" in one pipeline is "Activated" in another.
 */
export function convertedStatuses(): string[] {
  const raw = (process.env.CONVERTED_STATUSES || 'Closed Won').trim()
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export function isConvertedStatus(status: string | null | undefined): boolean {
  if (!status) return false
  return convertedStatuses().includes(status)
}
