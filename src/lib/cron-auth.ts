/** Shared-secret check for machine callers (external cron, mail webhooks). */
import { timingSafeEqual } from 'crypto'
import type { NextRequest } from 'next/server'

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/** Accepts x-cron-secret, Authorization: Bearer, or ?secret= */
export function isCronAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const candidates = [
    req.headers.get('x-cron-secret') || '',
    (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, ''),
    req.nextUrl.searchParams.get('secret') || '',
  ]
  return candidates.some((c) => c && safeEqual(c, secret))
}

/** Accepts x-webhook-secret, Authorization: Bearer, or ?secret= for EMAIL_WEBHOOK_SECRET. */
export function isWebhookAuthorized(req: NextRequest): boolean {
  const secret = process.env.EMAIL_WEBHOOK_SECRET
  if (!secret) return false
  const candidates = [
    req.headers.get('x-webhook-secret') || '',
    (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, ''),
    req.nextUrl.searchParams.get('secret') || '',
  ]
  return candidates.some((c) => c && safeEqual(c, secret))
}
