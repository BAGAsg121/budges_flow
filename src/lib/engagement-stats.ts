/**
 * Daily engagement buckets for a SET of nudges.
 *
 * This exists as its own module because bucketing used to live inline in the stats route,
 * built once across every nudge and then handed to two different charts — so both families
 * plotted identical data and nothing could catch it. Taking the nudge ids as a required
 * argument makes "which nudges am I counting?" impossible to leave implicit, and makes the
 * bucketing unit-testable.
 */

export interface DayBucket {
  date: string
  emailSent: number
  emailOpened: number
  emailFailed: number
  waSent: number
  waOpened: number
  waFailed: number
}

/** The minimum a log row must expose to be bucketed. */
export interface BucketableLog {
  nudgeId: string
  channel: string
  sentOk: boolean
  opened: boolean
  sentAt: Date | null
  createdAt: Date
}

/** The CRM's timezone — a "day" must match the day the operator works in, not UTC. */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000

/** yyyy-mm-dd for the IST day containing `d`. */
export function istDayKey(d: Date): string {
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10)
}

export function emptyBucket(date: string): DayBucket {
  return { date, emailSent: 0, emailOpened: 0, emailFailed: 0, waSent: 0, waOpened: 0, waFailed: 0 }
}

/**
 * One bucket per day for the last `days` days (oldest first), counting ONLY logs whose
 * `nudgeId` is in `nudgeIds`.
 *
 * A log for a nudge outside that set is ignored rather than folded in — that is the whole
 * point of the parameter.
 */
export function buildDailySeries(opts: {
  logs: BucketableLog[]
  nudgeIds: string[]
  days: number
  since: Date
}): DayBucket[] {
  const wanted = new Set(opts.nudgeIds)
  const buckets = new Map<string, DayBucket>()

  for (let i = 0; i < opts.days; i++) {
    const key = istDayKey(new Date(opts.since.getTime() + i * 24 * 60 * 60 * 1000))
    buckets.set(key, emptyBucket(key))
  }

  for (const log of opts.logs) {
    if (!wanted.has(log.nudgeId)) continue

    // A log with no sentAt was never sent; fall back to createdAt so failures still chart.
    const when = log.sentAt ?? log.createdAt
    const bucket = buckets.get(istDayKey(when))
    if (!bucket) continue

    if (log.channel === 'whatsapp') {
      if (log.sentOk) bucket.waSent++
      else bucket.waFailed++
      if (log.opened) bucket.waOpened++
    } else {
      if (log.sentOk) bucket.emailSent++
      else bucket.emailFailed++
      if (log.opened) bucket.emailOpened++
    }
  }

  return [...buckets.values()]
}

/** True when a series has nothing in it — lets the UI show an empty state per family. */
export function seriesIsEmpty(series: DayBucket[]): boolean {
  return series.every((d) => !d.emailSent && !d.emailOpened && !d.emailFailed && !d.waSent && !d.waOpened && !d.waFailed)
}
