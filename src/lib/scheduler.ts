/**
 * In-process scheduler.
 *
 * Started from src/instrumentation.ts when the Next server boots. Every
 * SCHEDULE_INTERVAL_MINUTES it:
 *   1. runs every enabled nudge (optionally syncing leads from Zoho first), and
 *   2. polls for email replies over IMAP when IMAP_ENABLED=true.
 *
 * Each nudge is capped at NUDGE_MAX_PER_RUN messages per cycle so a cycle can never
 * run past a request timeout; the remainder is picked up on the next cycle.
 */
import { db } from '@/lib/db'
import { runNudge, syncLeads, type RunSummary } from '@/lib/nudge-engine'
import { getStaticBaseUrl } from '@/lib/base-url'
import { isImapConfigured, syncRepliesFromImap, type ImapSyncResult } from '@/lib/reply-tracker'
import { nudgeSourceOf } from '@/lib/nudge-kind'

export interface NudgeRunResult {
  nudgeKey: string
  name: string
  channel: string
  summary?: RunSummary
  error?: string
}

export interface SchedulerStatus {
  enabled: boolean
  running: boolean
  intervalMinutes: number
  runsCompleted: number
  lastCycleAt: string | null
  lastCycleTrigger: string | null
  lastResults: NudgeRunResult[]
  lastReplySync: ImapSyncResult | null
}

interface SchedulerState {
  timer: ReturnType<typeof setInterval> | null
  running: boolean
  runsCompleted: number
  lastCycleAt: Date | null
  lastCycleTrigger: string | null
  lastResults: NudgeRunResult[]
  lastReplySync: ImapSyncResult | null
}

const globalForScheduler = globalThis as unknown as { __nudgeScheduler?: SchedulerState }

const state: SchedulerState =
  globalForScheduler.__nudgeScheduler ??
  (globalForScheduler.__nudgeScheduler = {
    timer: null,
    running: false,
    runsCompleted: 0,
    lastCycleAt: null,
    lastCycleTrigger: null,
    lastResults: [],
    lastReplySync: null,
  })

export function isSchedulerEnabled(): boolean {
  return (process.env.SCHEDULER_ENABLED ?? 'false') === 'true'
}

export function getIntervalMinutes(): number {
  const raw = Number(process.env.SCHEDULE_INTERVAL_MINUTES || 15)
  return Number.isFinite(raw) && raw > 0 ? raw : 15
}

export function getBatchLimit(): number | null {
  const raw = Number(process.env.NUDGE_MAX_PER_RUN || 0)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : null
}

export function schedulerStatus(): SchedulerStatus {
  return {
    enabled: isSchedulerEnabled(),
    running: state.running,
    intervalMinutes: getIntervalMinutes(),
    runsCompleted: state.runsCompleted,
    lastCycleAt: state.lastCycleAt ? state.lastCycleAt.toISOString() : null,
    lastCycleTrigger: state.lastCycleTrigger,
    lastResults: state.lastResults,
    lastReplySync: state.lastReplySync,
  }
}

/**
 * Run every enabled, RUN-BASED nudge once. Never throws; per-nudge errors are captured.
 *
 * "Run-based" means lead-driven (a Zoho criteria) OR MySQL-driven (reads the business database).
 * Only SHEET nudges are excluded: they are meant to be triggered by pasting a Google Sheet URL,
 * and running one on a timer would message a list nobody supplied.
 *
 * THE BUG THIS FIXES: the filter used to be `zohoCriteria: { not: null }`, written when a null
 * criteria meant "sheet nudge". The MySQL flows were later given a null criteria too — they are
 * told apart by `filters.source = "mysql"` — so the sheet exclusion silently swallowed all six of
 * them. Enabling a MySQL flow did nothing; the scheduler never handed it to runNudge, even though
 * runNudge dispatches it correctly. Hence filtering on the shared source helper rather than on a
 * field that two different kinds of nudge happen to share.
 *
 * The Zoho refresh is now hoisted out of the per-nudge loop: with N enabled Zoho nudges the old
 * code pulled the same CRM window N times per cycle. One sync per distinct criteria, then every
 * nudge runs with `sync:false`.
 */
export async function runAllEnabledNudges(opts?: { sync?: boolean; limit?: number | null }): Promise<NudgeRunResult[]> {
  const sync = opts?.sync ?? (process.env.SCHEDULE_SYNC_FROM_ZOHO ?? 'true') === 'true'
  const limit = opts?.limit === undefined ? getBatchLimit() : opts.limit
  const baseUrl = getStaticBaseUrl()

  // Select then filter in JS: `filters` is a text column, so "is this MySQL-driven?" cannot be
  // expressed as a Prisma where-clause without matching on raw JSON. There are only a handful of
  // nudges, so one small query plus the shared helper is both correct and cheap.
  const enabled = await db.nudge.findMany({
    where: { enabled: true },
    orderBy: { createdAt: 'asc' },
  })
  const nudges = enabled.filter((n) => nudgeSourceOf(n) !== 'sheet')
  const results: NudgeRunResult[] = []

  // 1. Sync ONCE per distinct Zoho criteria — not once per nudge.
  //
  // The sync lives inside runNudge, which syncs THIS nudge's criteria. With several enabled
  // Zoho nudges that is the same CRM window pulled N times every cycle: the expensive part
  // (network + lead upserts) multiplied for no new data, and the reason a cycle could time out
  // as nudges were added. Hoisting it here means each distinct criteria is fetched exactly once
  // and the nudges then read the local Lead table.
  //
  // A failed sync is NOT swallowed into "ran on stale data": the nudges that would have used that
  // criteria are reported as errored and skipped, exactly as they were when the sync was per-nudge.
  const syncOutcome = new Map<string, { count: number; via: 'mcp' | 'api' } | { error: string }>()
  if (sync) {
    const criterias = new Set(
      nudges.map((n) => (n.zohoCriteria || '').trim()).filter((c) => c.length > 0)
    )
    for (const criteria of criterias) {
      try {
        // syncLeads, NOT syncLeadsFromCriteria: MCP first, REST only as a fallback. Using the
        // REST-only helper here (and inside runNudge) bypassed the connected MCP server and made
        // every scheduled run depend on REST credentials that are currently rejected.
        const outcome = await syncLeads(criteria)
        syncOutcome.set(criteria, { count: outcome.synced, via: outcome.via })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        syncOutcome.set(criteria, { error: message })
        console.error('[scheduler] Zoho sync failed:', message)
      }
    }
  }

  for (const nudge of nudges) {
    const criteria = (nudge.zohoCriteria || '').trim()
    const synced = criteria ? syncOutcome.get(criteria) : undefined

    if (synced && 'error' in synced) {
      results.push({
        nudgeKey: nudge.key,
        name: nudge.name,
        channel: nudge.channel,
        error: `Zoho sync failed: ${synced.error}`,
      })
      continue
    }

    try {
      // sync:false — the refresh already happened above, once for this criteria.
      const summary = await runNudge(nudge.id, baseUrl, { sync: false, limit: limit ?? undefined })
      // Report the shared sync's count so the run summary still says what was pulled.
      if (synced && 'count' in synced) {
        summary.syncedFromZoho = synced.count
        summary.syncedVia = synced.via
      }
      results.push({ nudgeKey: nudge.key, name: nudge.name, channel: nudge.channel, summary })
    } catch (err) {
      results.push({
        nudgeKey: nudge.key,
        name: nudge.name,
        channel: nudge.channel,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return results
}

export async function pollReplies(): Promise<ImapSyncResult> {
  if (!isImapConfigured()) {
    const skipped: ImapSyncResult = { configured: false, scanned: 0, matched: 0 }
    state.lastReplySync = skipped
    return skipped
  }
  const result = await syncRepliesFromImap()
  state.lastReplySync = result
  if (result.error) console.error('[scheduler] IMAP reply sync failed:', result.error)
  return result
}

/** One full cycle: nudges + reply polling. Overlapping cycles are skipped. */
export async function runScheduledCycle(trigger = 'schedule'): Promise<SchedulerStatus> {
  if (state.running) return schedulerStatus()
  state.running = true
  try {
    state.lastResults = await runAllEnabledNudges()
    await pollReplies()
    state.runsCompleted++
    state.lastCycleAt = new Date()
    state.lastCycleTrigger = trigger

    const totals = state.lastResults.reduce(
      (acc, r) => {
        if (r.error) acc.errors++
        acc.sent += r.summary?.sent ?? 0
        acc.failed += r.summary?.failed ?? 0
        return acc
      },
      { sent: 0, failed: 0, errors: 0 }
    )
    console.log(
      `[scheduler] cycle (${trigger}) complete: ${state.lastResults.length} nudge(s), ` +
        `${totals.sent} sent, ${totals.failed} failed${totals.errors ? `, ${totals.errors} error(s)` : ''}`
    )
  } catch (err) {
    console.error('[scheduler] cycle failed:', err instanceof Error ? err.message : err)
  } finally {
    state.running = false
  }
  return schedulerStatus()
}

export function startScheduler(): void {
  if (!isSchedulerEnabled()) {
    console.log('[scheduler] disabled (set SCHEDULER_ENABLED=true to enable)')
    return
  }
  if (state.timer) return

  const minutes = getIntervalMinutes()
  state.timer = setInterval(() => {
    void runScheduledCycle('schedule')
  }, minutes * 60 * 1000)
  // don't hold the process open just for the scheduler
  state.timer.unref?.()

  console.log(`[scheduler] started — every ${minutes} minute(s)`)
  // first cycle shortly after boot so a restart doesn't wait a full interval
  setTimeout(() => void runScheduledCycle('startup'), 15_000).unref?.()
}

export function stopScheduler(): void {
  if (state.timer) {
    clearInterval(state.timer)
    state.timer = null
    console.log('[scheduler] stopped')
  }
}
