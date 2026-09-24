/**
 * GET /api/logs/failures?channel=&q=&limit=&includeResolved=0
 *
 * Every failed send, for both channels, with enough context to decide what to do about it:
 * the nudge it belonged to, the error translated into plain English, when it was attempted,
 * and whether a later retry already resolved it.
 *
 * `resolved` is derived at read time (see findResolvedFailures) rather than stored, so the
 * original failure row stays an honest record of what happened while the view can still say
 * "already recovered".
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { explainWhatsAppError } from '@/lib/whatsapp-errors'
import { explainMailError } from '@/lib/mail-errors'
import { findResolvedFailures } from '@/lib/retry-failed'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const channel = (sp.get('channel') || '').trim()
  const q = (sp.get('q') || '').trim()
  const nudgeKey = (sp.get('nudgeKey') || '').trim()
  const includeResolved = sp.get('includeResolved') === '1'
  const limit = Math.min(Number(sp.get('limit') || 300) || 300, 1000)

  const resolvedMap = await findResolvedFailures()

  const where: Record<string, unknown> = { sentOk: false }
  if (channel === 'email' || channel === 'whatsapp') where.channel = channel
  if (nudgeKey) where.nudge = { key: nudgeKey }
  if (q) {
    where.OR = [
      { toEmail: { contains: q } },
      { toPhone: { contains: q } },
      { sendError: { contains: q } },
      { subject: { contains: q } },
      { lead: { is: { OR: [{ fullName: { contains: q } }, { company: { contains: q } }] } } },
    ]
  }

  const logs = await db.messageLog.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      lead: { select: { fullName: true, company: true } },
      nudge: { select: { key: true, name: true, channel: true, enabled: true } },
    },
  })

  const rows = logs
    .map((l) => {
      const isWa = l.channel === 'whatsapp'
      const help = isWa ? explainWhatsAppError(l.sendError) : explainMailError(l.sendError)
      const resolvedAt = resolvedMap.get(l.id) ?? null
      return {
        id: l.id,
        channel: l.channel,
        nudgeKey: l.nudge.key,
        nudgeName: l.nudge.name,
        nudgeEnabled: l.nudge.enabled,
        to: isWa ? l.toPhone : l.toEmail,
        toEmail: l.toEmail,
        toPhone: l.toPhone,
        lead: l.lead?.fullName ?? l.lead?.company ?? null,
        subject: l.subject,
        templateName: l.templateName,
        messageNumber: l.messageNumber,
        sendError: l.sendError,
        createdAt: l.createdAt,
        /** Plain-English cause, when we know it. */
        errorLabel: help?.label ?? null,
        errorDetail: help?.detail ?? null,
        retryable: help?.retryable ?? true,
        /** True when a later send to the same nudge + address succeeded. */
        resolved: Boolean(resolvedAt),
        resolvedAt,
      }
    })
    .filter((r) => includeResolved || !r.resolved)

  // Breakdown for the header, computed before the resolved filter so the counts explain the
  // whole picture rather than only what is on screen.
  const byCause = new Map<string, { label: string; detail: string | null; count: number; retryable: boolean }>()
  for (const r of rows) {
    const key = r.errorLabel || 'other'
    const entry = byCause.get(key) ?? {
      label: r.errorLabel || 'Other',
      detail: r.errorDetail,
      count: 0,
      retryable: r.retryable,
    }
    entry.count++
    byCause.set(key, entry)
  }

  return NextResponse.json(
    {
      ok: true,
      count: rows.length,
      resolvedHidden: logs.length - rows.length,
      // Retry targets: unresolved and not a permanent/configuration error.
      retryableCount: rows.filter((r) => !r.resolved && r.retryable).length,
      byCause: [...byCause.values()].sort((a, b) => b.count - a.count),
      failures: rows,
    },
    { headers: { 'Cache-Control': 'no-store' } }
  )
}
