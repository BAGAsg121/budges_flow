/**
 * GET /api/stats — dashboard aggregates
 */
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  const [leads, nudges, sent, failed, opened, replied, recentLogs] = await Promise.all([
    db.lead.count(),
    db.nudge.count(),
    db.emailLog.count({ where: { sentOk: true } }),
    db.emailLog.count({ where: { sentOk: false } }),
    db.emailLog.count({ where: { opened: true } }),
    db.emailLog.count({ where: { replied: true } }),
    db.emailLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 8,
      include: { lead: { select: { fullName: true, email: true } }, nudge: { select: { name: true, key: true } } },
    }),
  ])

  const openRate = sent > 0 ? Math.round((opened / sent) * 100) : 0

  return NextResponse.json({
    ok: true,
    leads,
    nudges,
    emailsSent: sent,
    emailsFailed: failed,
    opened,
    replied,
    openRate,
    recentLogs: recentLogs.map((l) => ({
      id: l.id,
      lead: l.lead.fullName || l.lead.email,
      nudge: l.nudge.name,
      emailNumber: l.emailNumber,
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
