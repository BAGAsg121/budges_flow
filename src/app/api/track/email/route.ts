/**
 * POST /api/track/email — inbound reply webhook (public, secret-protected).
 *
 * Point a mail-provider webhook, a forwarding rule, or a mailbox rule at this URL to
 * mark a lead as replied. The IMAP poller covers the no-webhook case.
 *
 * Body (JSON): { "from": "lead@example.com", "inReplyTo": "<msgid>", "references": "<msgid> <msgid2>" }
 * Auth: x-webhook-secret header, Authorization: Bearer, or ?secret= must equal EMAIL_WEBHOOK_SECRET.
 *
 * Always answers 200 once authorized so upstream never retry-storms; `matched` reports
 * whether an outbound message was actually found.
 */
import { NextRequest, NextResponse } from 'next/server'
import { recordReply } from '@/lib/reply-tracker'
import { isWebhookAuthorized } from '@/lib/cron-auth'

export const dynamic = 'force-dynamic'

interface ReplyBody {
  from?: string
  fromEmail?: string
  inReplyTo?: string
  references?: string | string[]
  receivedAt?: string
}

export async function POST(req: NextRequest) {
  if (!isWebhookAuthorized(req)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  const params = req.nextUrl.searchParams
  let body: ReplyBody = {}
  try {
    body = (await req.json()) as ReplyBody
  } catch {
    // no/invalid JSON -> fall back to query params
  }

  const received = body.receivedAt ? new Date(body.receivedAt) : new Date()

  try {
    const matched = await recordReply(
      {
        fromEmail: body.from || body.fromEmail || params.get('from'),
        inReplyTo: body.inReplyTo || params.get('inReplyTo'),
        references: body.references ?? params.get('references'),
      },
      Number.isNaN(received.getTime()) ? new Date() : received
    )
    return NextResponse.json({ ok: true, matched })
  } catch (err) {
    return NextResponse.json({ ok: true, matched: false, error: err instanceof Error ? err.message : String(err) })
  }
}

/** GET mirrors POST for providers that can only fire a URL — pass ?from=... */
export async function GET(req: NextRequest) {
  if (!isWebhookAuthorized(req)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  const params = req.nextUrl.searchParams
  try {
    const matched = await recordReply({
      fromEmail: params.get('from'),
      inReplyTo: params.get('inReplyTo'),
      references: params.get('references'),
    })
    return NextResponse.json({ ok: true, matched })
  } catch (err) {
    return NextResponse.json({ ok: true, matched: false, error: err instanceof Error ? err.message : String(err) })
  }
}
