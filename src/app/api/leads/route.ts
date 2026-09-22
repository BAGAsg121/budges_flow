/**
 * GET /api/leads?q=&status=&limit= — list synced leads
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get('q') || '').trim()
  const status = (req.nextUrl.searchParams.get('status') || '').trim()
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

  const leads = await db.lead.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: { _count: { select: { messageLogs: true } } },
  })

  return NextResponse.json({
    ok: true,
    count: leads.length,
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
    })),
  })
}
