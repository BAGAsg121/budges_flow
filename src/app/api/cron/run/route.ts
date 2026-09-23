/**
 * POST /api/cron/run — run one full scheduler cycle (all enabled nudges + reply poll).
 * For external schedulers (Windows Task Scheduler, cron, EasyCron...). The in-process
 * scheduler does the same thing automatically when SCHEDULER_ENABLED=true.
 *
 * Auth: x-cron-secret header, Authorization: Bearer, or ?secret= must equal CRON_SECRET.
 */
import { NextRequest, NextResponse } from 'next/server'
import { runScheduledCycle } from '@/lib/scheduler'
import { isCronAuthorized } from '@/lib/cron-auth'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  const status = await runScheduledCycle('cron')
  return NextResponse.json({ ok: true, ...status })
}
