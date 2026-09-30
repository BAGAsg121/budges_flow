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

/**
 * Shared-secret check for the per-nudge CRM lead webhook (LEAD_WEBHOOK_SECRET).
 *
 * Accepts, in order of preference:
 *   • `x-webhook-secret: <secret>`  — use this if your CRM's webhook UI has a Headers section
 *   • `?token=<secret>`             — the fallback, because a URL is the one field every Zoho
 *                                     workflow webhook definitely lets you edit
 *   • `Authorization: Bearer <secret>`
 *
 * The `token` name is deliberate rather than reused `secret`: it makes it obvious in the CRM UI
 * that this value is a credential and must not be shared.
 */
export function isLeadWebhookAuthorized(req: NextRequest): boolean {
  const secret = process.env.LEAD_WEBHOOK_SECRET
  if (!secret) return false
  const candidates = [
    req.headers.get('x-webhook-secret') || '',
    (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, ''),
    req.nextUrl.searchParams.get('token') || '',
  ]
  return candidates.some((c) => c && safeEqual(c, secret))
}

export const leadWebhookSecretConfigured = (): boolean => Boolean(process.env.LEAD_WEBHOOK_SECRET)
