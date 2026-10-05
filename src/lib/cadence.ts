/**
 * Per-nudge run cadence.
 *
 * The scheduler's global tick (`SCHEDULE_INTERVAL_MINUTES`) decides how often the scheduler LOOKS.
 * This decides how often a given flow actually RUNS. They are different questions, and the n8n gave
 * each flow its own trigger (its verify_csp flows every 2 hours, csp_application every 3, the
 * document flows every 12). Without a per-flow cadence every flow inherits the tick, which re-scans
 * the same window many times over — harmless for correctness, because de-duplication is per
 * recipient, but pointless load and impossible to reason about from the config.
 *
 * Dependency-free on purpose (no database, no Prisma) so scripts/verify-changes.mjs can test the
 * "is it due?" arithmetic directly.
 */

export interface CadenceInput {
  filters: string
  lastRunAt: Date | null
}

/** A nudge's own run interval in hours, from `filters.everyHours`. Null = inherit the tick. */
export function cadenceHoursOf(nudge: { filters: string }): number | null {
  try {
    const f = JSON.parse(nudge.filters || '{}') as { everyHours?: unknown }
    const raw = Number(f.everyHours)
    return Number.isFinite(raw) && raw > 0 ? raw : null
  } catch {
    // Unparseable filters must not mean "never runs" — fall back to the global tick.
    return null
  }
}

export type CadenceVerdict = { due: true } | { due: false; reason: string; dueAt: Date }

/**
 * Is this nudge due, given its own cadence and when it last ran?
 *
 * A nudge that has NEVER run is always due: `lastRunAt` is null on a freshly seeded row, and
 * refusing to run it because "the last run was never" would mean a newly enabled flow sat idle
 * until an arbitrary boundary.
 */
export function cadenceDue(nudge: CadenceInput, now: Date): CadenceVerdict {
  const every = cadenceHoursOf(nudge)
  if (!every || !nudge.lastRunAt) return { due: true }

  const dueAt = new Date(nudge.lastRunAt.getTime() + every * 60 * 60 * 1000)
  if (now >= dueAt) return { due: true }

  const minutes = Math.max(1, Math.ceil((dueAt.getTime() - now.getTime()) / 60000))
  const last = nudge.lastRunAt.toISOString().slice(0, 16).replace('T', ' ')
  return {
    due: false,
    dueAt,
    reason: `runs every ${every}h — last ran ${last}, next in ${minutes}m`,
  }
}
