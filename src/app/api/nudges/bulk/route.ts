/**
 * POST /api/nudges/bulk — enable or disable every nudge at once.
 *
 * Body: { "enabled": true | false }
 *
 * The scheduler only ever runs nudges that are enabled, so disabling all of them stops
 * every kind of sending immediately, without touching the host's environment variables or
 * redeploying. This is the "pause everything" switch.
 *
 * `enabled` is operator state and is never touched by the seeding scripts.
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  let enabled: boolean | undefined
  try {
    const body = (await req.json()) as { enabled?: unknown }
    if (typeof body.enabled === 'boolean') enabled = body.enabled
  } catch {
    // fall through to validation
  }

  if (enabled === undefined) {
    return NextResponse.json({ ok: false, error: 'Body must be { "enabled": true | false }' }, { status: 400 })
  }

  try {
    const { count } = await db.nudge.updateMany({ data: { enabled } })
    const remaining = enabled ? count : 0
    return NextResponse.json({
      ok: true,
      enabled,
      count,
      activeNudges: remaining,
      message: enabled
        ? `${count} nudge(s) enabled — the scheduler will run them on its next cycle.`
        : `${count} nudge(s) disabled — the scheduler now has nothing to send.`,
    })
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
