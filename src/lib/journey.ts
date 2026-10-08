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

/* ───────────────────────── attribution confidence ───────────────────────── */

/**
 * How strongly the evidence points at a nudge — NOT a probability that it caused the change.
 *
 * The document is explicit that attribution is probabilistic, and "which nudge was last sent" alone
 * is a weak claim: a lead can move stage for reasons we never see. This turns that weak claim into a
 * *described* one, so the UI can say "strong / moderate / weak" with the reasons, instead of showing
 * a bare nudge name that reads like a proven cause.
 *
 * Three factors, each bounded, and each reported so the number can be argued with:
 *   • Proximity  — how soon after the send the change happened. A change 20 minutes later is far
 *                  more plausibly connected than one two days later.
 *   • Engagement — whether the recipient actually DID something with that nudge (replied > clicked >
 *                  opened > merely received). A nudge nobody opened is a poor explanation.
 *   • Uniqueness — how many nudges landed in the window. One is a clear candidate; five in three days
 *                  means we cannot tell which, if any, mattered.
 *
 * A `weak` result is a real answer, not a failure: it says "something else probably did this".
 */
export type ConfidenceBand = 'weak' | 'moderate' | 'strong'

export interface ConfidenceFactor {
  label: string
  points: number
  max: number
  detail: string
}

export interface AttributionConfidence {
  score: number
  band: ConfidenceBand
  factors: ConfidenceFactor[]
}

const BANDS: Array<{ min: number; band: ConfidenceBand }> = [
  { min: 60, band: 'strong' },
  { min: 30, band: 'moderate' },
  { min: 0, band: 'weak' },
]

export function confidenceBand(score: number): ConfidenceBand {
  return BANDS.find((b) => score >= b.min)?.band ?? 'weak'
}

export const CONFIDENCE_LABEL: Record<ConfidenceBand, string> = {
  weak: 'Weak',
  moderate: 'Moderate',
  strong: 'Strong',
}

/**
 * Score one attributed nudge.
 *
 * `nudgesInWindow` is how many successful sends landed inside the attribution window before the
 * change — the denominator that keeps a busy lead from looking well-explained by any single message.
 */
export function attributionConfidence(
  log: { opened: boolean; replied: boolean; ctaClicks: number; ctaClickedAt: Date | null; channel?: string },
  hoursSinceNudge: number,
  nudgesInWindow: number
): AttributionConfidence {
  const factors: ConfidenceFactor[] = []

  // Proximity — max 45.
  let proximity = 0
  if (hoursSinceNudge <= 1) proximity = 45
  else if (hoursSinceNudge <= 6) proximity = 35
  else if (hoursSinceNudge <= 24) proximity = 25
  else if (hoursSinceNudge <= 48) proximity = 15
  else proximity = 8
  factors.push({
    label: 'Proximity',
    points: proximity,
    max: 45,
    detail: `${Math.round(hoursSinceNudge * 10) / 10}h between the send and the change`,
  })

  // Engagement — max 35. A reply is the strongest signal we have that the message was read and acted on.
  let engagement = 0
  let engagementDetail = 'sent only — nothing came back'
  const clicked = log.ctaClicks > 0 || log.ctaClickedAt !== null
  if (log.replied) {
    engagement = 35
    engagementDetail = 'the lead replied to this nudge'
  } else if (clicked) {
    engagement = 25
    engagementDetail = 'the lead tapped the CTA in this nudge'
  } else if (log.opened) {
    engagement = 15
    engagementDetail = 'the lead opened or read this nudge'
  }
  factors.push({ label: 'Engagement', points: engagement, max: 35, detail: engagementDetail })

  // Uniqueness — max 20. One candidate is clean; several means we cannot single one out.
  let uniqueness = 20
  let uniquenessDetail = 'this was the only nudge in the window'
  if (nudgesInWindow === 2) {
    uniqueness = 12
    uniquenessDetail = '2 nudges fell inside the window'
  } else if (nudgesInWindow >= 3) {
    uniqueness = 6
    uniquenessDetail = `${nudgesInWindow} nudges fell inside the window — any of them could be responsible`
  }
  factors.push({ label: 'Uniqueness', points: uniqueness, max: 20, detail: uniquenessDetail })

  const score = Math.min(100, factors.reduce((n, f) => n + f.points, 0))
  return { score, band: confidenceBand(score), factors }
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
