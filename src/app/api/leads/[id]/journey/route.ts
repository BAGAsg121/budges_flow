/**
 * GET /api/leads/{id}/journey — V2
 *
 * Everything the lead drawer needs: the score with its breakdown, the stage timeline with the nudge
 * attributed to each change, the full send history, and the last nudge summary.
 *
 * One endpoint rather than three, because the drawer always shows all of it and three round trips
 * would still have to agree with each other.
 *
 * Attribution is presented as "the last nudge we sent before this change" — never as a cause. The
 * `attributionIsProbabilistic` flag is in the payload so the UI cannot quietly imply otherwise.
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import {
  attributionWindowHours,
  computeScore,
  isConvertedStatus,
  SCORE_BAND_LABEL,
  type JourneyLog,
} from '@/lib/journey'

export const dynamic = 'force-dynamic'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const lead = await db.lead.findUnique({ where: { id } })
  if (!lead) return NextResponse.json({ ok: false, error: 'Lead not found' }, { status: 404 })

  const [logs, history] = await Promise.all([
    db.messageLog.findMany({
      where: { leadId: id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, nudgeId: true, channel: true, messageNumber: true, sentOk: true, sentAt: true,
        opened: true, opensCount: true, replied: true, ctaClicks: true, ctaClickedAt: true,
        templateName: true, subject: true, sendError: true, inboundText: true,
      },
    }),
    db.leadStageHistory.findMany({
      where: { leadId: id },
      orderBy: { detectedAt: 'asc' },
      include: { triggeredByNudge: { select: { key: true, name: true, channel: true } } },
    }),
  ])

  // Nudge names for the send history, in one query.
  const nudgeIds = [...new Set(logs.map((l) => l.nudgeId))]
  const nudges = await db.nudge.findMany({
    where: { id: { in: nudgeIds } },
    select: { id: true, key: true, name: true, channel: true },
  })
  const nudgeById = new Map(nudges.map((n) => [n.id, n]))

  const scored = computeScore(logs as unknown as JourneyLog[], history.length)

  // "Last Nudge Sent" — the most recent successful send, whatever the timeline says.
  const lastSent = logs.find((l) => l.sentOk && l.sentAt)

  return NextResponse.json({
    ok: true,
    lead: {
      id: lead.id,
      zohoId: lead.zohoId,
      name: lead.fullName || lead.email || lead.zohoId,
      email: lead.email,
      mobile: lead.mobile || lead.phone,
      company: lead.company,
      currentStatus: lead.leadStatus,
      businessVertical: lead.businessVertical,
      firstNudgeSentAt: lead.firstNudgeSentAt,
      lastStatusChangedAt: lead.lastStatusChangedAt,
      totalDaysToConvert: lead.totalDaysToConvert,
      converted: isConvertedStatus(lead.leadStatus),
    },
    score: {
      value: scored.score,
      band: scored.band,
      bandLabel: SCORE_BAND_LABEL[scored.band],
      breakdown: scored.breakdown,
      counts: scored.counts,
      capped: scored.capped,
      calculatedAt: lead.scoreLastCalculatedAt,
    },
    stageHistory: history.map((h) => ({
      id: h.id,
      fromStatus: h.fromStatus,
      toStatus: h.toStatus,
      detectedAt: h.detectedAt,
      timeInPrevStageHours: h.timeInPrevStageHours,
      attributedNudgeKey: h.triggeredByNudge?.key ?? null,
      attributedNudgeName: h.triggeredByNudge?.name ?? null,
      attributedChannel: h.triggeredByNudge?.channel ?? null,
      attributedMessageNumber: h.attributedMessageNumber,
      hoursSinceNudge: h.hoursSinceNudge,
    })),
    nudgeHistory: logs.map((l) => ({
      id: l.id,
      nudgeKey: nudgeById.get(l.nudgeId)?.key ?? null,
      nudgeName: nudgeById.get(l.nudgeId)?.name ?? null,
      channel: l.channel,
      messageNumber: l.messageNumber,
      sentAt: l.sentAt,
      sentOk: l.sentOk,
      opened: l.opened,
      replied: l.replied,
      ctaClicks: l.ctaClicks,
      ctaClickedAt: l.ctaClickedAt,
      templateName: l.templateName,
      subject: l.subject,
      error: l.sendError,
      reply: l.inboundText,
    })),
    lastNudge: lastSent
      ? {
          nudgeKey: nudgeById.get(lastSent.nudgeId)?.key ?? null,
          channel: lastSent.channel,
          messageNumber: lastSent.messageNumber,
          sentAt: lastSent.sentAt,
          templateName: lastSent.templateName,
          opened: lastSent.opened,
          replied: lastSent.replied,
          ctaClicks: lastSent.ctaClicks,
        }
      : null,
    attributionWindowHours: attributionWindowHours(),
    /** Stated in the payload so no UI can imply causation. */
    attributionIsProbabilistic: true,
  })
}
