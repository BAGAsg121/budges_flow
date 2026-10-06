/**
 * V2 — the score recalculation job.
 *
 * Loads every lead's message history, computes the engagement score (journey.ts owns the maths),
 * and writes the score, its breakdown and the derived journey timestamps back to the lead.
 *
 * BATCHED, not per-lead. A naive implementation issues one message-log query per lead, which is
 * fine for 40 leads and not fine for 40,000 — and the whole point of a cron job is that it runs
 * unattended on whatever the table happens to hold. Logs and stage history are fetched for the
 * whole batch in two queries.
 *
 * `firstNudgeSentAt` is DERIVED here from the logs rather than written by the send path. Deriving
 * makes it self-healing (a lead whose sends predate V2 gets its clock back on the first run) and
 * keeps the send path free of an extra write per message.
 */
import { db } from '@/lib/db'
import {
  computeScore,
  daysBetween,
  isConvertedStatus,
  scoreMax,
  type JourneyLog,
} from '@/lib/journey'

export interface ScoreRunResult {
  leadsConsidered: number
  leadsUpdated: number
  max: number
  /** Per-band totals, for the report header. */
  bands: Record<string, number>
  errors: string[]
}

const LOG_SELECT = {
  id: true,
  leadId: true,
  nudgeId: true,
  channel: true,
  messageNumber: true,
  sentOk: true,
  sentAt: true,
  opened: true,
  replied: true,
  ctaClicks: true,
  ctaClickedAt: true,
} as const

/**
 * Recalculate scores for a batch of leads.
 *
 * `leadIds` narrows the work (used right after a sync touched specific leads); omitting it means
 * "every lead". `limit` bounds a single run so a cron tick cannot run past its timeout — the next
 * tick continues, ordered so the stalest scores are refreshed first.
 */
export async function recalculateScores(
  opts: { leadIds?: string[]; limit?: number } = {}
): Promise<ScoreRunResult> {
  const take = opts.limit && opts.limit > 0 ? Math.floor(opts.limit) : undefined

  const leads = await db.lead.findMany({
    where: opts.leadIds ? { id: { in: opts.leadIds } } : {},
    select: { id: true, leadStatus: true, firstNudgeSentAt: true, lastStatusChangedAt: true },
    // Stalest first — in MySQL an ASC sort puts NULLs first, so never-scored leads lead the queue.
    orderBy: { scoreLastCalculatedAt: 'asc' },
    ...(take ? { take } : {}),
  })

  const result: ScoreRunResult = {
    leadsConsidered: leads.length,
    leadsUpdated: 0,
    max: scoreMax(),
    bands: { cold: 0, warming: 0, engaged: 0, hot: 0 },
    errors: [],
  }
  if (leads.length === 0) return result

  const ids = leads.map((l) => l.id)

  // Two queries for the whole batch, rather than two per lead.
  const [logs, history] = await Promise.all([
    db.messageLog.findMany({ where: { leadId: { in: ids } }, select: LOG_SELECT }),
    db.leadStageHistory.findMany({ where: { leadId: { in: ids } }, select: { leadId: true } }),
  ])

  const logsByLead = new Map<string, JourneyLog[]>()
  for (const l of logs) {
    // Sheet-sourced sends carry leadId=null by design; they belong to no lead, so they score no one.
    if (!l.leadId) continue
    const bucket = logsByLead.get(l.leadId) ?? []
    bucket.push(l as unknown as JourneyLog)
    logsByLead.set(l.leadId, bucket)
  }

  const changesByLead = new Map<string, number>()
  for (const h of history) changesByLead.set(h.leadId, (changesByLead.get(h.leadId) ?? 0) + 1)

  const now = new Date()

  for (const lead of leads) {
    try {
      const own = logsByLead.get(lead.id) ?? []
      const changes = changesByLead.get(lead.id) ?? 0
      const scored = computeScore(own, changes)

      // Earliest successful send ever — the time-to-conversion clock.
      const successful = own.filter((l) => l.sentOk && l.sentAt instanceof Date)
      const firstSentAt =
        successful.length > 0
          ? new Date(Math.min(...successful.map((l) => (l.sentAt as Date).getTime())))
          : lead.firstNudgeSentAt

      // Stamped only on the converted stage, and only when the clock is known.
      const convertDays =
        isConvertedStatus(lead.leadStatus) && lead.lastStatusChangedAt
          ? daysBetween(firstSentAt, lead.lastStatusChangedAt)
          : null

      await db.lead.update({
        where: { id: lead.id },
        data: {
          engagementScore: scored.score,
          scoreBreakdown: JSON.stringify(scored.breakdown),
          scoreLastCalculatedAt: now,
          firstNudgeSentAt: firstSentAt,
          ...(convertDays !== null ? { totalDaysToConvert: convertDays } : {}),
        },
      })

      result.leadsUpdated++
      result.bands[scored.band] = (result.bands[scored.band] ?? 0) + 1
    } catch (err) {
      // One bad row must not abort the batch — the rest still deserve a fresh score.
      result.errors.push(`${lead.id}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return result
}
