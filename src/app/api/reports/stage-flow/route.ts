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
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET() {
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

  return NextResponse.json({
    ok: true,
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
