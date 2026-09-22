/**
 * Open-tracking pixel: GET /api/track/open/{trackingId}
 * Mirrors the n8n flow's fixed behaviors:
 *  - ALWAYS returns a real 1x1 GIF (even when tracking_id is unknown), so the pixel
 *    never breaks in the inbox.
 *  - opens_count increments on every open; opened_at keeps the FIRST open only.
 *  - engagement_status never downgrades (replied > opened > sent).
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

export async function GET(_req: NextRequest, { params }: { params: Promise<{ trackingId: string }> }) {
  const { trackingId } = await params
  const tid = (trackingId || '').trim()

  if (tid) {
    try {
      const log = await db.messageLog.findUnique({ where: { trackingId: tid } })
      if (log) {
        await db.messageLog.update({
          where: { trackingId: tid },
          data: {
            opensCount: { increment: 1 },
            opened: true,
            openedAt: log.openedAt ?? new Date(), // preserve first-open timestamp
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
