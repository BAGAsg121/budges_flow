/**
 * WhatsApp URL-button click attribution.
 *
 * THE CONSTRAINT: Meta does **not** send a webhook when someone taps a URL button on a template.
 * Only quick-reply and list replies come back, as inbound messages. So there is exactly one way
 * to learn WHO clicked: make the button point at this app, record the tap, and redirect to the
 * real destination. That means the destination has to be stored per send (ctaUrl), because the
 * token in the URL identifies the message, not the target.
 *
 * Everything here is pure so the mechanics can be unit-tested without a database or a redirect.
 *
 * Tracking is OPT-IN via `CTA_TRACK_BASE_URL`. When it is unset, `buildCtaUrl` returns the direct
 * destination and the button behaves exactly as before — which matters because the button URL
 * lives inside the Meta-approved template, so enabling tracking requires NEW templates and a
 * fresh review. Nothing breaks in the meantime.
 */

/** Where the app's tracker lives. Empty means "do not track, send the direct link". */
export function ctaTrackBaseUrl(): string {
  return (process.env.CTA_TRACK_BASE_URL || '').trim().replace(/\/+$/, '')
}

export function isCtaTrackingEnabled(): boolean {
  return ctaTrackBaseUrl().length > 0
}

/**
 * The direct destination a button should reach, with the recipient's mobile filled in.
 *
 * The mobile is normalised (10 digits) because the console/payment links expect national format
 * and the sheets/DB store it half a dozen ways.
 */
export function directCtaUrl(baseUrl: string, mobileDigits: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '')
  const sep = base.includes('?') ? '&' : '?'
  return mobileDigits ? `${base}${sep}mobile=${encodeURIComponent(mobileDigits)}` : base
}

/**
 * The URL to put in the template's button.
 *
 * With tracking off this is the real destination. With tracking on it is
 * `<CTA_TRACK_BASE_URL>/<token>`, and the token is the message's trackingId — which is what the
 * tracker uses to find the intended destination.
 */
export function buildCtaUrl(opts: { destination: string; token: string }): string {
  const base = ctaTrackBaseUrl()
  if (!base) return opts.destination
  return `${base}/${encodeURIComponent(opts.token)}`
}

/**
 * The value handed to Meta as the URL button's `{{1}}`.
 *
 * Meta appends this to the template's button URL, and the URL must end in a single `{{1}}`. When
 * tracking is on, the token goes in the PATH (per Meta's suffix rule) and the destination is
 * looked up server-side — never passed through the URL, which would be an open redirect.
 */
export function ctaButtonParam(opts: { token: string; mobileDigits: string }): string {
  return isCtaTrackingEnabled() ? opts.token : opts.mobileDigits
}

/**
 * Where a click should actually go, given a stored destination.
 *
 * Falls back rather than failing: a recipient who taps "Pay Now" must never land on an error
 * page. If the stored destination is missing the fallback is used, and if there is no fallback
 * either, the EPS console home is the last resort.
 */
export function resolveCtaDestination(storedUrl: string | null | undefined): string {
  const stored = (storedUrl || '').trim()
  if (stored) return stored
  return (process.env.CTA_FALLBACK_URL || 'https://eps.eko.in/console').trim()
}

/** True when a token looks like one of ours (a UUID), so the route can reject obvious junk early. */
export function isPlausibleCtaToken(token: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token.trim())
}

/**
 * The button parameters and stored destination for one WhatsApp send.
 *
 * With tracking OFF the configured button parameters are passed through untouched — this must be
 * a strict no-op, because the button URL lives in an already-approved Meta template and changing
 * what we send would break live sends. With tracking ON the button carries the message token and
 * the real destination is stored on the log row for the tracker to read.
 *
 * `ctaUrl` is stored even when tracking is off, so the export can show which link a recipient was
 * given — it is free metadata.
 */
export function ctaSendParams(opts: {
  /** Where the button would go, from the template spec. Null means the template has no button. */
  destination: string | null
  trackingId: string
  mobileDigits: string
  /** Whatever `whatsappParams.button` resolved to, used verbatim when tracking is off. */
  configured: string[]
}): { buttonParams: string[]; ctaUrl: string | null } {
  if (!opts.destination) return { buttonParams: opts.configured, ctaUrl: null }
  if (!isCtaTrackingEnabled()) return { buttonParams: opts.configured, ctaUrl: opts.destination }
  return { buttonParams: [opts.trackingId], ctaUrl: opts.destination }
}
