/**
 * Open-tracking pixel (query-param variant): GET /api/track/open?tid=...
 * Kept for parity with the n8n webhook URL shape (?tid=tracking_id).
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

const GIF_BASE64 = 'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='

function gifResponse() {
  const buf = Buffer.from(GIF_BASE64, 'base64')
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      'Content-Type': 'image/gif',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
    },
  })
}

export async function GET(req: NextRequest) {
  const tid = (req.nextUrl.searchParams.get('tid') || '').trim()

  if (tid) {
    try {
      const log = await db.messageLog.findUnique({ where: { trackingId: tid } })
      if (log) {
        await db.messageLog.update({
          where: { trackingId: tid },
          data: {
            opensCount: { increment: 1 },
            opened: true,
            openedAt: log.openedAt ?? new Date(),
            engagementStatus: log.replied ? 'replied' : 'opened',
          },
        })
      }
    } catch {
      // never break the pixel on DB errors
    }
  }

  return gifResponse()
}
