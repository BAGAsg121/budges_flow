/**
 * GET /api/reports/stage-flow — V2
 *
 * The macro view: how many leads sit in each stage right now, how many moved between each pair of
 * stages, and how long leads typically spend in a stage before leaving it.
 *
 * `transitions` is the Sankey input (fromStatus → toStatus, with a count). `currentStages` is the
 * funnel input. `avgHoursInStage` comes from the stage history rather than from the current
 * snapshot, because a lead that is still sitting somewhere has no "time spent" yet — its clock is
 * still running, and counting it would understate the average.
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { attributionConfidence, attributionWindowHours } from '@/lib/journey'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const limit = Math.min(Number(req.nextUrl.searchParams.get('transitions') || 100), 500)

  const [currentGroups, transitionGroups] = await Promise.all([
    db.lead.groupBy({ by: ['leadStatus'], _count: { _all: true } }),
    db.leadStageHistory.groupBy({
      by: ['fromStatus', 'toStatus'],
      _count: { _all: true },
      _avg: { timeInPrevStageHours: true },
    }),
  ])

  // Average time spent in a stage = mean timeInPrevStageHours over the transitions that LEFT it.
  const stageTime = new Map<string, { sum: number; n: number }>()
  for (const g of transitionGroups) {
    const avg = g._avg.timeInPrevStageHours
    const from = g.fromStatus ?? '(unset)'
    if (typeof avg !== 'number') continue
    const acc = stageTime.get(from) ?? { sum: 0, n: 0 }
    acc.sum += avg * g._count._all
    acc.n += g._count._all
    stageTime.set(from, acc)
  }

  const round1 = (n: number) => Math.round(n * 10) / 10

  /**
   * The individual recorded transitions, newest first — what makes this report clickable.
   *
   * Each row carries enough to open the lead's full story (id + leadId) and, where a nudge was
   * credited, the same confidence score the drawer shows. Confidence is computed here in one batch:
   * the transitions are fetched, then every message log for those leads in a single query, because
   * doing it per transition would be one query per row.
   */
  const history = await db.leadStageHistory.findMany({
    orderBy: { detectedAt: 'desc' },
    take: limit,
    include: {
      lead: { select: { id: true, fullName: true, email: true, leadStatus: true, engagementScore: true } },
      triggeredByNudge: { select: { key: true, channel: true } },
    },
  })

  const leadIds = [...new Set(history.map((h) => h.leadId))]
  const logs = leadIds.length
    ? await db.messageLog.findMany({
        where: { leadId: { in: leadIds }, sentOk: true },
        select: {
          id: true, leadId: true, messageNumber: true, sentAt: true,
          opened: true, replied: true, ctaClicks: true, ctaClickedAt: true,
        },
      })
    : []

  const logsByLead = new Map<string, typeof logs>()
  for (const l of logs) {
    if (!l.leadId) continue
    const bucket = logsByLead.get(l.leadId) ?? []
    bucket.push(l)
    logsByLead.set(l.leadId, bucket)
  }

  const windowMs = attributionWindowHours() * 60 * 60 * 1000

  const recentTransitions = history.map((h) => {
    const at = h.detectedAt.getTime()
    const before = (logsByLead.get(h.leadId) ?? []).filter(
      (l) => l.sentAt && l.sentAt.getTime() <= at && at - l.sentAt.getTime() <= windowMs
    )
    const credited = h.triggeredByMessageLogId
      ? before.find((l) => l.id === h.triggeredByMessageLogId) ?? null
      : null
    const confidence = credited?.sentAt
      ? attributionConfidence(
          {
            opened: credited.opened,
            replied: credited.replied,
            ctaClicks: credited.ctaClicks,
            ctaClickedAt: credited.ctaClickedAt,
          },
          (at - credited.sentAt.getTime()) / 3_600_000,
          before.length
        )
      : null

    return {
      id: h.id,
      leadId: h.leadId,
      leadName: h.lead.fullName || h.lead.email || h.leadId,
      leadScore: h.lead.engagementScore,
      fromStatus: h.fromStatus,
      toStatus: h.toStatus,
      detectedAt: h.detectedAt,
      timeInPrevStageHours: h.timeInPrevStageHours,
      attributedNudgeKey: h.triggeredByNudge?.key ?? null,
      attributedChannel: h.triggeredByNudge?.channel ?? null,
      hoursSinceNudge: h.hoursSinceNudge,
      confidenceScore: confidence?.score ?? null,
      confidenceBand: confidence?.band ?? null,
      nudgesBeforeCount: before.length,
    }
  })

  return NextResponse.json({
    ok: true,
    recentTransitions,
    currentStages: currentGroups
      .map((g) => ({ status: g.leadStatus ?? '(unset)', leads: g._count._all }))
      .sort((a, b) => b.leads - a.leads),
    transitions: transitionGroups
      .map((g) => ({
        from: g.fromStatus ?? '(first seen)',
        to: g.toStatus,
        leads: g._count._all,
        avgHoursInFromStage: typeof g._avg.timeInPrevStageHours === 'number' ? round1(g._avg.timeInPrevStageHours) : null,
      }))
      .sort((a, b) => b.leads - a.leads),
    avgHoursInStage: [...stageTime.entries()]
      .map(([status, acc]) => ({ status, avgHours: acc.n ? round1(acc.sum / acc.n) : null, transitions: acc.n }))
      .sort((a, b) => (b.avgHours ?? 0) - (a.avgHours ?? 0)),
    note:
      'A stage\'s average is measured from the transitions that LEFT it, so a stage that nothing has ' +
      'left yet reports no average rather than zero.',
  })
}
