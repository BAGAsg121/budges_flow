/**
 * GET /api/scheduler — scheduler status for the UI (behind the app password).
 */
import { NextResponse } from 'next/server'
import { schedulerStatus } from '@/lib/scheduler'
import { isImapConfigured } from '@/lib/reply-tracker'

export const dynamic = 'force-dynamic'

export async function GET() {
  const status = schedulerStatus()
  return NextResponse.json({
    ok: true,
    ...status,
    imapConfigured: isImapConfigured(),
  })
}
