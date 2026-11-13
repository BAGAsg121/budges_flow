/**
 * "Is this daily job due?" — the arithmetic behind the daily sheet scheduler.
 *
 * WHY NOT reuse `filters.everyHours` (src/lib/cadence.ts): an interval says "run every 24 hours from
 * whenever it last ran", so a restart at 21:40 moves tomorrow's send to 21:40, the next restart moves
 * it again, and the message drifts out of the working day. The activation-fee reminders have to land
 * at a fixed clock time, so this module asks a different question: "has today's 11:00 IST slot passed
 * and not yet been used?"
 *
 * The consequences, all deliberate:
 *   • A restart at 12:30 still sends today — a missed slot is honoured, not skipped, because the
 *     whole point is that nobody has to click anything.
 *   • A run at 09:00 (manual, or a retry) does NOT consume the 11:00 slot: the slot is measured from
 *     the scheduled instant, not from "did anything happen today".
 *   • A second run after 11:00 the same day does nothing, because lastRunAt is now past the slot.
 *   • Exactly one send per day per nudge, however often the scheduler ticks.
 *
 * IST is a fixed +05:30 (no DST), so the offset is a constant rather than a timezone database. Kept
 * dependency-free so scripts/verify-changes.mjs can assert it without a database.
 */

/** India Standard Time is UTC+05:30 all year; a fixed offset is correct here. */
export const IST_OFFSET_MINUTES = 330

/** The default send hour for a daily sheet flow, in IST. */
export const DEFAULT_DAILY_HOUR = 11

export interface DailyGateInput {
  /** The nudge's lastRunAt, if it has ever run. */
  lastRunAt: Date | null
  /** Hour of day in IST (0–23) at which the slot opens. */
  dailyAtHour: number
  now: Date
  /** Injected so the tests can pin a non-IST offset if that ever matters. */
  tzOffsetMinutes?: number
}

export interface DailyGateResult {
  due: boolean
  /** Why not, in words that can go straight into a scheduler result. */
  reason?: string
  /** Today's scheduled instant (UTC ISO), for reporting. */
  scheduledAt: string
}

/** Clock hour for a nudge, from `filters.dailyAtHour`, or null when it is not a daily job. */
export function dailyHourOf(filters: { dailyAtHour?: unknown }): number | null {
  const raw = filters.dailyAtHour
  if (raw === undefined || raw === null || raw === '') return null
  const hour = Number(raw)
  if (!Number.isFinite(hour)) return null
  const whole = Math.trunc(hour)
  return whole >= 0 && whole <= 23 ? whole : null
}

/** 11 -> "11:00", 9 -> "09:00". */
export function formatHour(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`
}

/* ─────────────────── the daily SHEET flows (activation-fee reminders) ─────────────────── */

/**
 * A sheet nudge's own source, stored in its `filters` JSON:
 *
 *   { "sheetUrl": "https://docs.google.com/spreadsheets/d/<id>/edit#gid=0",
 *     "sheetGid": "0",
 *     "dailyAtHour": 11 }
 *
 * WHY IN THE FILTERS: the four app tables are fixed (nudge_lead, nudge_config, nudge_message_log,
 * nudge_lead_stage_history) and adding a column for "where does this flow read from" would be a
 * schema change; `filters` is already the JSON bag every other nudge-specific setting rides in.
 *
 * `sheetUrl` is the flag that makes a sheet nudge SCHEDULED. A sheet nudge without it stays what it
 * has always been: manual, pasted-URL only. That distinction is why enabling a sheet nudge is safe —
 * nothing runs on a timer unless a URL was deliberately stored.
 */
export interface SheetSchedule {
  sheetUrl: string
  gid?: string
  /** Hour of day in IST, or null to run on the first tick of the day. */
  dailyAtHour: number | null
}

/** Read the daily-sheet source out of a nudge's filters. Null when it is not a scheduled sheet flow. */
export function sheetScheduleOf(filters: { sheetUrl?: unknown; sheetGid?: unknown; dailyAtHour?: unknown } | null): SheetSchedule | null {
  const raw = typeof filters?.sheetUrl === 'string' ? filters.sheetUrl.trim() : ''
  if (!raw) return null
  const gidRaw = filters?.sheetGid
  const gid = typeof gidRaw === 'string' && gidRaw.trim() ? gidRaw.trim() : typeof gidRaw === 'number' ? String(gidRaw) : undefined
  return { sheetUrl: raw, ...(gid ? { gid } : {}), dailyAtHour: dailyHourOf(filters ?? {}) }
}

/** The UTC instant of the given hour on the local day that `now` falls in. */
export function scheduledInstantForLocalDay(now: Date, hour: number, tzOffsetMinutes = IST_OFFSET_MINUTES): Date {
  const offsetMs = tzOffsetMinutes * 60 * 1000
  // Shift into local wall-clock, take the date, then shift back — this is what makes the answer
  // independent of the server's own timezone.
  const local = new Date(now.getTime() + offsetMs)
  const localMidnightUtc = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate())
  return new Date(localMidnightUtc + hour * 60 * 60 * 1000 - offsetMs)
}

/**
 * Decide whether today's slot has arrived and is still unused.
 *
 * `lastRunAt` is compared to the SCHEDULED instant, not to midnight: a run at 09:00 today must not
 * cancel the 11:00 send, and a run at 11:05 must never be repeated at 11:15.
 */
export function dailyGate(input: DailyGateInput): DailyGateResult {
  const tz = input.tzOffsetMinutes ?? IST_OFFSET_MINUTES
  const hour = Number.isFinite(input.dailyAtHour) ? Math.trunc(input.dailyAtHour) : DEFAULT_DAILY_HOUR
  const scheduled = scheduledInstantForLocalDay(input.now, hour, tz)
  const scheduledAt = scheduled.toISOString()

  if (input.now.getTime() < scheduled.getTime()) {
    return { due: false, reason: `waiting for ${formatHour(hour)} IST`, scheduledAt }
  }
  if (input.lastRunAt && input.lastRunAt.getTime() >= scheduled.getTime()) {
    return { due: false, reason: `already ran today (slot ${formatHour(hour)} IST)`, scheduledAt }
  }
  return { due: true, scheduledAt }
}
