/**
 * GET /api/stats — dashboard aggregates.
 *
 * WHATSAPP ONLY. The dashboard deliberately shows nothing about email at the moment, so this
 * returns a `whatsapp` block and the recent-activity list is restricted to WhatsApp messages.
 * The email numbers still exist in the Logs tab and the export; they are just not on the
 * dashboard.
 *
 * "Read" is Meta's read receipt (`opened` on the row) and "Clicked" comes from the CTA tracker
 * (`ctaClicks`), which only counts messages sent on a tracked (`_cta`) template.
 */
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  const whatsapp = { channel: 'whatsapp' as const }

  const [leads, nudges, waSent, waFailed, waRead, waReplied, waClickedRows, waClicks, recentLogs] =
    await Promise.all([
      db.lead.count(),
      db.nudge.count(),
      db.messageLog.count({ where: { ...whatsapp, sentOk: true } }),
      db.messageLog.count({ where: { ...whatsapp, sentOk: false } }),
      db.messageLog.count({ where: { ...whatsapp, opened: true } }),
      db.messageLog.count({ where: { ...whatsapp, replied: true } }),
      // Messages that had at least one button tap…
      db.messageLog.count({ where: { ...whatsapp, ctaClicks: { gt: 0 } } }),
      // …and the total number of taps.
      db.messageLog.aggregate({ where: whatsapp, _sum: { ctaClicks: true } }),
      db.messageLog.findMany({
        where: whatsapp,
        orderBy: { createdAt: 'desc' },
        take: 8,
        include: {
          lead: { select: { fullName: true, email: true } },
          nudge: { select: { name: true, key: true } },
        },
      }),
    ])

  const attempted = waSent + waFailed
  const readRate = attempted > 0 ? Math.round((waRead / attempted) * 100) : 0
  const clickRate = waSent > 0 ? Math.round((waClickedRows / waSent) * 100) : 0

  return NextResponse.json({
    ok: true,
    leads,
    nudges,
    whatsapp: {
      sent: waSent,
      failed: waFailed,
      read: waRead,
      replied: waReplied,
      /** Messages with at least one CTA tap. */
      clicked: waClickedRows,
      /** Total taps, including repeats by the same person. */
      clicks: waClicks._sum.ctaClicks ?? 0,
      readRate,
      clickRate,
    },
    recentLogs: recentLogs.map((l) => ({
      id: l.id,
      channel: l.channel,
      lead: l.lead?.fullName || l.lead?.email || l.toPhone || 'Sheet send',
      nudge: l.nudge.name,
      messageNumber: l.messageNumber,
      templateName: l.templateName,
      sentOk: l.sentOk,
      sendError: l.sendError,
      engagementStatus: l.engagementStatus,
      opensCount: l.opensCount,
      ctaClicks: l.ctaClicks ?? 0,
      sentAt: l.sentAt,
      createdAt: l.createdAt,
    })),
  })
}
