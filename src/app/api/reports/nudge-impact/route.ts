/**
 * GET /api/reports/nudge-impact — V2
 *
 * "Which nudge, at which message number, is most effective at moving leads forward?"
 *
 * For every nudge: how many messages it sent, how many stage changes are attributed to it, the
 * conversion rate, and the average hours between the send and the change — split by message number,
 * because "the 3rd nudge works better" is a different insight from "this nudge works".
 *
 * A WORD ON WHAT conversionRate MEANS HERE: it is
 *     (stage changes attributed to this nudge) / (successful sends by this nudge)
 * Attribution is the LAST SEND BEFORE the change, inside ATTRIBUTION_WINDOW_HOURS. It is not proof
 * of cause — a lead may move stage for reasons we never see. The rate is a lead worth following up,
 * not a result. `attributionIsProbabilistic` is in the payload so no downstream chart can forget.
 *
 * Grouped in the database rather than in JS: the log table is the largest in the app, and the point
 * of the report is that it can be run over everything.
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { attributionWindowHours } from '@/lib/journey'

export const dynamic = 'force-dynamic'

const pct = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 1000) / 10}%` : '0%')

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const sinceParam = url.searchParams.get('since')
  const since = sinceParam ? new Date(sinceParam) : null
  const validSince = since && !Number.isNaN(since.getTime()) ? since : null

  const [sentGroups, attribGroups] = await Promise.all([
    db.messageLog.groupBy({
      by: ['nudgeId', 'messageNumber'],
      where: { sentOk: true, ...(validSince ? { sentAt: { gte: validSince } } : {}) },
      _count: { _all: true },
    }),
    db.leadStageHistory.groupBy({
      by: ['triggeredByNudgeId', 'attributedMessageNumber'],
      where: validSince ? { detectedAt: { gte: validSince } } : {},
      _count: { _all: true },
      _avg: { hoursSinceNudge: true },
    }),
  ])

  const nudges = await db.nudge.findMany({ select: { id: true, key: true, name: true, channel: true } })
  const nudgeById = new Map(nudges.map((n) => [n.id, n]))

  interface Row {
    nudge: string
    name: string
    channel: string
    totalSends: number
    leadsWhoChangedStatus: number
    conversionRate: string
    avgHoursToStatusChange: number | null
    breakdownByMessageNumber: Record<string, { sends: number; conversions: number; rate: string }>
  }

  const byNudge = new Map<string, Row>()
  const rowFor = (nudgeId: string): Row => {
    const existing = byNudge.get(nudgeId)
    if (existing) return existing
    const n = nudgeById.get(nudgeId)
    const row: Row = {
      nudge: n?.key ?? nudgeId,
      name: n?.name ?? '(deleted nudge)',
      channel: n?.channel ?? 'unknown',
      totalSends: 0,
      leadsWhoChangedStatus: 0,
      conversionRate: '0%',
      avgHoursToStatusChange: null,
      breakdownByMessageNumber: {},
    }
    byNudge.set(nudgeId, row)
    return row
  }

  for (const g of sentGroups) {
    const row = rowFor(g.nudgeId)
    const n = g._count._all
    row.totalSends += n
    const key = String(g.messageNumber)
    row.breakdownByMessageNumber[key] = row.breakdownByMessageNumber[key] ?? { sends: 0, conversions: 0, rate: '0%' }
    row.breakdownByMessageNumber[key].sends += n
  }

  // A stage change with no attributed nudge is a real outcome (the lead moved organically) and is
  // reported separately rather than being dropped — otherwise the conversion column would silently
  // ignore most of the data.
  let organicChanges = 0
  const hoursAccum: Record<string, { sum: number; n: number }> = {}

  for (const g of attribGroups) {
    const n = g._count._all
    if (!g.triggeredByNudgeId) {
      organicChanges += n
      continue
    }
    const row = rowFor(g.triggeredByNudgeId)
    row.leadsWhoChangedStatus += n
    const key = String(g.attributedMessageNumber ?? 'unknown')
    row.breakdownByMessageNumber[key] = row.breakdownByMessageNumber[key] ?? { sends: 0, conversions: 0, rate: '0%' }
    row.breakdownByMessageNumber[key].conversions += n

    const avg = g._avg.hoursSinceNudge
    if (typeof avg === 'number') {
      hoursAccum[g.triggeredByNudgeId] = hoursAccum[g.triggeredByNudgeId] ?? { sum: 0, n: 0 }
      hoursAccum[g.triggeredByNudgeId].sum += avg * n
      hoursAccum[g.triggeredByNudgeId].n += n
    }
  }

  const rows = [...byNudge.values()].map((row) => {
    const id = nudges.find((n) => n.key === row.nudge)?.id
    const acc = id ? hoursAccum[id] : undefined
    return {
      ...row,
      conversionRate: pct(row.leadsWhoChangedStatus, row.totalSends),
      avgHoursToStatusChange: acc && acc.n > 0 ? Math.round((acc.sum / acc.n) * 10) / 10 : null,
      breakdownByMessageNumber: Object.fromEntries(
        Object.entries(row.breakdownByMessageNumber).map(([k, v]) => [
          k,
          { ...v, rate: pct(v.conversions, v.sends) },
        ])
      ),
    }
  })

  // Ranked by conversion rate, but only where there is enough volume to mean anything — ranking a
  // nudge that sent once and converted once at "100%" above a real pattern would be misleading.
  const MIN_SENDS_FOR_RANKING = 20
  const ranked = rows
    .filter((r) => r.totalSends >= MIN_SENDS_FOR_RANKING)
    .sort(
      (a, b) =>
        parseFloat(b.conversionRate) - parseFloat(a.conversionRate) ||
        b.leadsWhoChangedStatus - a.leadsWhoChangedStatus
    )

  return NextResponse.json({
    ok: true,
    since: validSince ? validSince.toISOString() : null,
    attributionWindowHours: attributionWindowHours(),
    attributionIsProbabilistic: true,
    minSendsForRanking: MIN_SENDS_FOR_RANKING,
    totals: {
      sends: rows.reduce((n, r) => n + r.totalSends, 0),
      attributedChanges: rows.reduce((n, r) => n + r.leadsWhoChangedStatus, 0),
      /** Stage changes with no qualifying recent nudge — reported, not hidden. */
      organicChanges,
    },
    topConvertingNudges: ranked,
    nudges: rows.sort((a, b) => b.totalSends - a.totalSends),
  })
}
