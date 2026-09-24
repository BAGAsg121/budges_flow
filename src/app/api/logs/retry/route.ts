/**
 * POST /api/logs/retry
 *
 * Re-send failed messages, each through the nudge it originally belonged to.
 *
 * Body:
 *   { "ids": ["<logId>", …] }          — retry exactly these failures
 *   { "all": true }                    — every unresolved retryable failure
 *   { "channel": "email" | "whatsapp" } — narrow `all` to one channel
 *   { "nudgeKey": "…" }                — narrow `all` to one nudge
 *   { "includeNonRetryable": true }    — also retry ones we know cannot succeed
 *   { "limit": 50 }                    — safety cap on a single request
 *
 * Guard rails, all deliberate:
 *  - Only `sentOk = false` rows are eligible; a retry never re-sends a success.
 *  - Already-resolved failures are skipped unless explicitly included, so pressing the button
 *    twice does not message everyone twice.
 *  - Non-retryable errors (undeliverable numbers, a template that does not exist, bad
 *    credentials) are skipped by default. Re-sending those just re-logs the same failure.
 *  - Recipients who have since replied are skipped.
 *  - The batch is capped, and each send is sequential, because the original failure was very
 *    often caused by sending too fast.
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { explainWhatsAppError } from '@/lib/whatsapp-errors'
import { explainMailError } from '@/lib/mail-errors'
import { findResolvedFailures, retryFailedLogs } from '@/lib/retry-failed'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const MAX_BATCH = 200

export async function POST(req: NextRequest) {
  let body: {
    ids?: string[]
    all?: boolean
    channel?: string
    nudgeKey?: string
    includeNonRetryable?: boolean
    includeResolved?: boolean
    limit?: number
  } = {}
  try {
    body = (await req.json()) as typeof body
  } catch {
    // handled below
  }

  const limit = Math.min(Math.max(Number(body.limit) || 50, 1), MAX_BATCH)

  let ids: string[] = []

  if (Array.isArray(body.ids) && body.ids.length) {
    ids = body.ids.filter((i) => typeof i === 'string' && i.trim()).slice(0, MAX_BATCH)
  } else if (body.all) {
    const where: Record<string, unknown> = { sentOk: false }
    if (body.channel === 'email' || body.channel === 'whatsapp') where.channel = body.channel
    if (body.nudgeKey) where.nudge = { key: body.nudgeKey }

    const candidates = await db.messageLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 1000,
      select: { id: true, channel: true, sendError: true },
    })

    const resolved = body.includeResolved ? null : await findResolvedFailures()

    ids = candidates
      .filter((c) => (resolved ? !resolved.has(c.id) : true))
      .filter((c) => {
        if (body.includeNonRetryable) return true
        const help = c.channel === 'whatsapp' ? explainWhatsAppError(c.sendError) : explainMailError(c.sendError)
        return help?.retryable ?? true
      })
      .slice(0, limit)
      .map((c) => c.id)

    if (!ids.length) {
      return NextResponse.json({
        ok: true,
        requested: 0,
        attempted: 0,
        sent: 0,
        failed: 0,
        skipped: 0,
        outcomes: [],
        message: 'Nothing to retry — every failure is either already resolved or not retryable.',
      })
    }
  } else {
    return NextResponse.json(
      { ok: false, error: 'Provide either "ids" (a list) or "all": true.' },
      { status: 400 }
    )
  }

  try {
    const result = await retryFailedLogs(ids)
    return NextResponse.json({
      ok: true,
      ...result,
      // The UI shows the same breakdown it displays on the failures list.
      message: `${result.sent} sent, ${result.failed} failed, ${result.skipped} skipped (of ${result.attempted} attempted).`,
    })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}
