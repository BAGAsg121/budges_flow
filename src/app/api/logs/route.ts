/**
 * GET /api/logs?nudgeId=&status=&q=&limit= — email log (replaces the Google Sheet log)
 * status: sent | opened | replied | failed
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const nudgeId = (req.nextUrl.searchParams.get('nudgeId') || '').trim()
  const status = (req.nextUrl.searchParams.get('status') || '').trim()
  const q = (req.nextUrl.searchParams.get('q') || '').trim()
  const limit = Math.min(Number(req.nextUrl.searchParams.get('limit') || 200), 1000)

  const where: Record<string, unknown> = {}
  if (nudgeId) where.nudgeId = nudgeId
  if (status === 'failed') where.sentOk = false
  else if (status) where.engagementStatus = status
  if (q) {
    where.OR = [
      { toEmail: { contains: q } },
      { subject: { contains: q } },
      { lead: { is: { OR: [{ fullName: { contains: q } }, { email: { contains: q } }, { company: { contains: q } }] } } },
    ]
  }

  const logs = await db.emailLog.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      lead: { select: { fullName: true, email: true, company: true } },
      nudge: { select: { name: true, key: true } },
    },
  })

  return NextResponse.json({
    ok: true,
    count: logs.length,
    logs: logs.map((l) => ({
      id: l.id,
      lead: l.lead.fullName || l.lead.email,
      company: l.lead.company,
      toEmail: l.toEmail,
      nudge: l.nudge.name,
      nudgeKey: l.nudge.key,
      emailNumber: l.emailNumber,
      subject: l.subject,
      sentOk: l.sentOk,
      sendError: l.sendError,
      sentAt: l.sentAt,
      opened: l.opened,
      openedAt: l.openedAt,
      opensCount: l.opensCount,
      replied: l.replied,
      engagementStatus: l.replied ? 'replied' : l.opened ? 'opened' : l.sentOk ? 'sent' : 'failed',
      trackingId: l.trackingId,
    })),
  })
}
