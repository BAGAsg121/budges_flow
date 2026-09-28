/**
 * GET /api/track/cta/[token] — WhatsApp URL-button click tracker.
 *
 * The button in a WhatsApp template points here (via `CTA_TRACK_BASE_URL`), carrying the
 * message's trackingId. This records the tap against the MessageLog and then 302s to the
 * destination that was stored when the message was sent.
 *
 * Public on purpose (middleware exempts /api/track/*): the clicker is a customer with no
 * credentials, and the token is an unguessable UUID.
 *
 * TWO RULES THAT MATTER MORE THAN THE TRACKING:
 *   1. NEVER show an error page. If the token is unknown, expired, malformed or the database is
 *      unreachable, the customer still gets redirected to the fallback destination. A broken
 *      tracker must not cost a sale.
 *   2. NEVER redirect to a URL supplied in the request. The destination is read from the stored
 *      row, so this cannot be turned into an open redirect.
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { isPlausibleCtaToken, resolveCtaDestination } from '@/lib/cta'
import { isCtaConversionReportingEnabled, reportCtaClickConversion } from '@/lib/meta-capi'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

function redirectTo(url: string) {
  // 302, not 301: a permanent redirect would be cached by the browser and every later click on
  // the same link would skip the tracker entirely.
  return NextResponse.redirect(url, 302)
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const clean = (token || '').trim()

  // Unknown destination until the row says otherwise — the fallback is always safe.
  let destination = resolveCtaDestination(null)

  if (isPlausibleCtaToken(clean)) {
    try {
      const log = await db.messageLog.findFirst({
        where: { trackingId: clean },
        select: {
          id: true,
          ctaUrl: true,
          ctaClickedAt: true,
          toPhone: true,
          toEmail: true,
          nudge: { select: { key: true, name: true } },
        },
      })

      if (log) {
        destination = resolveCtaDestination(log.ctaUrl)

        // Increment and stamp the first click. Deliberately NOT awaited: the redirect must not
        // wait on a write, and a failed count is not worth delaying the customer for.
        void db.messageLog
          .update({
            where: { id: log.id },
            data: {
              ctaClicks: { increment: 1 },
              ctaClickedAt: log.ctaClickedAt ?? new Date(),
            },
          })
          .catch(() => {
            // Counting is best-effort; the redirect below is not.
          })

        // Report the click to Meta as a conversion, if that is switched on. Also not awaited —
        // an analytics call must never stand between the customer and the payment page.
        if (isCtaConversionReportingEnabled()) {
          void reportCtaClickConversion({
            phone: log.toPhone,
            email: log.toEmail,
            trackingId: clean,
          }).catch(() => {
            // Analytics is best-effort by design.
          })
        }
      }
    } catch {
      // Database unreachable — fall through to the fallback destination.
    }
  }

  return redirectTo(destination)
}
