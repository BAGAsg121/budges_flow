/**
 * GET /api/leads/{id}/score — V2
 *
 * The current score plus the per-signal breakdown, recomputed on the spot from the message history
 * rather than read from the stored column. The stored column can lag (it is refreshed on sync and on
 * the cron), and a panel that opens on a stale number while claiming to be "current" is worse than
 * one that spends 30ms recalculating.
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { computeScore, SCORE_BAND_LABEL, SCORE_WEIGHTS, scoreMax, type JourneyLog } from '@/lib/journey'

export const dynamic = 'force-dynamic'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const lead = await db.lead.findUnique({
    where: { id },
    select: { id: true, fullName: true, email: true, zohoId: true, engagementScore: true, scoreLastCalculatedAt: true },
  })
  if (!lead) return NextResponse.json({ ok: false, error: 'Lead not found' }, { status: 404 })

  const [logs, statusChanges] = await Promise.all([
    db.messageLog.findMany({
      where: { leadId: id },
      select: {
        id: true, nudgeId: true, channel: true, messageNumber: true, sentOk: true, sentAt: true,
        opened: true, replied: true, ctaClicks: true, ctaClickedAt: true,
      },
    }),
    db.leadStageHistory.count({ where: { leadId: id } }),
  ])

  const scored = computeScore(logs as unknown as JourneyLog[], statusChanges)

  return NextResponse.json({
    ok: true,
    leadId: lead.id,
    lead: lead.fullName || lead.email || lead.zohoId,
    score: scored.score,
    band: scored.band,
    bandLabel: SCORE_BAND_LABEL[scored.band],
    capped: scored.capped,
    max: scoreMax(),
    breakdown: scored.breakdown,
    counts: scored.counts,
    weights: SCORE_WEIGHTS,
    /** The stored value, so a UI can show drift if the cron has not run since the last send. */
    storedScore: lead.engagementScore,
    storedCalculatedAt: lead.scoreLastCalculatedAt,
    note: 'The engagement score is a reporting and prioritisation signal. It does not affect who is nudged — that is decided by each nudge\'s filters.',
  })
}
