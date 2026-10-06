/**
 * POST /api/cron/score-leads — V2
 *
 * Recalculates engagement scores. Run it on a schedule; SCORE_RECALC_INTERVAL_MINUTES documents the
 * intended cadence (the in-process scheduler also honours it).
 *
 * Auth: CRON_SECRET via x-cron-secret, Authorization: Bearer, or ?secret=.
 *
 * Body (optional):
 *   { "limit": 500 }   — bound this run; the next one continues, stalest scores first
 *   { "all": true }    — ignore the batch limit
 *
 * Why a batch limit exists: the job walks every lead and their message history. Unbounded, it grows
 * with the lead table until one tick runs past its timeout and never completes — the classic cron
 * that silently stops working. Bounded, each tick finishes and the queue drains.
 */
import { NextRequest, NextResponse } from 'next/server'
import { recalculateScores } from '@/lib/score-leads'
import { isCronAuthorized } from '@/lib/cron-auth'
import { scoreRecalcIntervalMinutes } from '@/lib/journey'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/** Default batch when the caller does not specify one. */
const DEFAULT_BATCH = 500

export async function POST(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  let limit: number | undefined = DEFAULT_BATCH
  try {
    const body = (await req.json()) as { limit?: number; all?: boolean }
    if (body?.all === true) limit = undefined
    else if (typeof body?.limit === 'number' && body.limit > 0) limit = Math.floor(body.limit)
  } catch {
    // no body -> the default batch
  }

  const started = Date.now()
  const result = await recalculateScores({ limit })

  return NextResponse.json({
    ok: true,
    ...result,
    limit: limit ?? null,
    intervalMinutes: scoreRecalcIntervalMinutes(),
    tookMs: Date.now() - started,
  })
}

/** GET reports the contract, so the cron can be probed without triggering a run. */
export async function GET() {
  return NextResponse.json({
    ok: true,
    method: 'POST',
    auth: 'CRON_SECRET as x-cron-secret, Authorization: Bearer, or ?secret=',
    body: { limit: DEFAULT_BATCH, all: false },
    intervalMinutes: scoreRecalcIntervalMinutes(),
  })
}
