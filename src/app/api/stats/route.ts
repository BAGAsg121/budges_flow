/**
 * GET /api/stats — dashboard aggregates (email + whatsapp)
 */
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  const [leads, nudges, sent, failed, opened, replied, recentLogs] = await Promise.all([
    db.lead.count(),
    db.nudge.count(),
    db.messageLog.count({ where: { sentOk: true } }),
    db.messageLog.count({ where: { sentOk: false } }),
    db.messageLog.count({ where: { opened: true } }),
    db.messageLog.count({ where: { replied: true } }),
    db.messageLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 8,
      include: {
        lead: { select: { fullName: true, email: true } },
        nudge: { select: { name: true, key: true } },
      },
    }),
  ])

  const openRate = sent > 0 ? Math.round((opened / sent) * 100) : 0

  return NextResponse.json({
    ok: true,
    leads,
    nudges,
    messagesSent: sent,
    messagesFailed: failed,
    opened,
    replied,
    openRate,
    recentLogs: recentLogs.map((l) => ({
      id: l.id,
      channel: l.channel,
      lead: l.lead?.fullName || l.lead?.email || l.toEmail || 'Sheet send',
      nudge: l.nudge.name,
      messageNumber: l.messageNumber,
      subject: l.subject,
      sentOk: l.sentOk,
      sendError: l.sendError,
      engagementStatus: l.engagementStatus,
      opensCount: l.opensCount,
      sentAt: l.sentAt,
      createdAt: l.createdAt,
    })),
  })
}
