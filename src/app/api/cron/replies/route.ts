/**
 * POST /api/cron/replies — poll the mailbox for replies only (no nudges sent).
 * GET  /api/cron/replies — the same, convenient for a plain URL-based cron.
 *
 * Auth: x-cron-secret header, Authorization: Bearer, or ?secret= must equal CRON_SECRET.
 */
import { NextRequest, NextResponse } from 'next/server'
import { pollReplies } from '@/lib/scheduler'
import { isCronAuthorized } from '@/lib/cron-auth'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

async function handle(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  const result = await pollReplies()
  return NextResponse.json({ ok: true, ...result })
}

export async function POST(req: NextRequest) {
  return handle(req)
}

export async function GET(req: NextRequest) {
  return handle(req)
}
