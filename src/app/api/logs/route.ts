/**
 * GET /api/logs?nudgeId=&status=&channel=&q=&limit= — message log (email + whatsapp)
 * status: sent | opened | replied | failed
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const nudgeId = (req.nextUrl.searchParams.get('nudgeId') || '').trim()
  const status = (req.nextUrl.searchParams.get('status') || '').trim()
  const channel = (req.nextUrl.searchParams.get('channel') || '').trim()
  const q = (req.nextUrl.searchParams.get('q') || '').trim()
  const limit = Math.min(Number(req.nextUrl.searchParams.get('limit') || 200), 1000)

  const where: Record<string, unknown> = {}
  if (nudgeId) where.nudgeId = nudgeId
  if (channel === 'email' || channel === 'whatsapp') where.channel = channel
  if (status === 'failed') where.sentOk = false
  else if (status) where.engagementStatus = status
  if (q) {
    where.OR = [
      { toEmail: { contains: q } },
      { toPhone: { contains: q } },
      { subject: { contains: q } },
      { lead: { is: { OR: [{ fullName: { contains: q } }, { email: { contains: q } }, { company: { contains: q } }] } } },
    ]
  }

  const logs = await db.messageLog.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      lead: { select: { fullName: true, email: true, company: true } },
      nudge: { select: { name: true, key: true, channel: true } },
    },
  })

  return NextResponse.json({
    ok: true,
    count: logs.length,
    logs: logs.map((l) => ({
      id: l.id,
      lead: l.lead.fullName || l.lead.email,
      company: l.lead.company,
      channel: l.channel,
      toEmail: l.toEmail,
      toPhone: l.toPhone,
      nudge: l.nudge.name,
      nudgeKey: l.nudge.key,
      messageNumber: l.messageNumber,
      subject: l.subject,
      templateName: l.templateName,
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
