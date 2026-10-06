/**
 * GET /api/leads?q=&status=&limit=&sort= — list synced leads
 *
 * V2: `sort=score` orders by engagement, and every lead carries its score band so the table can
 * badge it without recomputing anything client-side.
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { scoreBand } from '@/lib/journey'

export const dynamic = 'force-dynamic'

/** Whitelisted sort keys — never interpolate a caller-supplied field name into orderBy. */
const ORDER_BY: Record<string, Record<string, 'asc' | 'desc'>> = {
  score: { engagementScore: 'desc' },
  'score-asc': { engagementScore: 'asc' },
  status: { leadStatus: 'asc' },
  newest: { createdAt: 'desc' },
  oldest: { createdAt: 'asc' },
}

export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get('q') || '').trim()
  const status = (req.nextUrl.searchParams.get('status') || '').trim()
  const sort = (req.nextUrl.searchParams.get('sort') || '').trim()
  const band = (req.nextUrl.searchParams.get('band') || '').trim()
  const limit = Math.min(Number(req.nextUrl.searchParams.get('limit') || 500), 1000)

  const where: Record<string, unknown> = {}
  if (q) {
    where.OR = [
      { fullName: { contains: q } },
      { email: { contains: q } },
      { company: { contains: q } },
      { phone: { contains: q } },
      { mobile: { contains: q } },
    ]
  }
  if (status) where.leadStatus = status
  // V2 band filter. A band is a score RANGE, so it maps to a numeric filter — the boundaries are
  // the ones in journey.ts scoreBand(), and they are asserted in verify-changes.mjs so the two
  // cannot drift apart.
  const BAND_RANGE: Record<string, { gte?: number; lte?: number }> = {
    cold: { lte: 20 },
    warming: { gte: 21, lte: 45 },
    engaged: { gte: 46, lte: 70 },
    hot: { gte: 71 },
  }
  if (band && BAND_RANGE[band]) where.engagementScore = BAND_RANGE[band]

  const leads = await db.lead.findMany({
    where,
    // V2: sortable by engagement. Whitelisted, because `orderBy` comes straight from the query
    // string and an arbitrary field name would be both a crash and an information leak.
    orderBy: ORDER_BY[sort] ?? { createdAt: 'desc' },
    take: limit,
    include: { _count: { select: { messageLogs: true } } },
  })

  return NextResponse.json({
    ok: true,
    count: leads.length,
    sort,
    leads: leads.map((l) => ({
      id: l.id,
      zohoId: l.zohoId,
      fullName: l.fullName,
      email: l.email,
      phone: l.phone || l.mobile,
      company: l.company,
      businessVertical: l.businessVertical,
      leadStatus: l.leadStatus,
      kycDocumentUploadCount: l.kycDocumentUploadCount,
      ownerName: l.ownerName,
      city: l.city,
      createdTime: l.createdTime,
      lastSyncedAt: l.lastSyncedAt,
      messagesSent: l._count.messageLogs,
      // --- V2 ---
      engagementScore: l.engagementScore,
      scoreBand: scoreBand(l.engagementScore),
      scoreLastCalculatedAt: l.scoreLastCalculatedAt,
      firstNudgeSentAt: l.firstNudgeSentAt,
      lastStatusChangedAt: l.lastStatusChangedAt,
      totalDaysToConvert: l.totalDaysToConvert,
    })),
  })
}
