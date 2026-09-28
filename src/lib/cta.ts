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

/** Where the app's tracker lives. Used when BUILDING templates; empty means untracked. */
export function ctaTrackBaseUrl(): string {
  return (process.env.CTA_TRACK_BASE_URL || '').trim().replace(/\/+$/, '')
}

export function isCtaTrackingEnabled(): boolean {
  return ctaTrackBaseUrl().length > 0
}

/**
 * Suffix that marks a template's button as tracked.
 *
 * The template is what decides this, NOT an env var: the button's URL lives inside the approved
 * template, so a `_cta` template expects a token in `{{1}}` whether or not this process has
 * CTA_TRACK_BASE_URL set. Getting that wrong sends the MOBILE where a token belongs, the tracker
 * finds no log, and the customer lands on the fallback page instead of the payment page.
 */
export const CTA_TEMPLATE_SUFFIX = '_cta'

/** True when a template's button routes through the tracker. */
export function isTrackedTemplate(templateName: string | null | undefined): boolean {
  return (templateName || '').trim().endsWith(CTA_TEMPLATE_SUFFIX)
}

/** The approved template a tracked one is derived from: `x_cta` -> `x`. */
export function baseTemplateName(templateName: string): string {
  const name = templateName.trim()
  return isTrackedTemplate(name) ? name.slice(0, -CTA_TEMPLATE_SUFFIX.length) : name
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
 * The decision is driven by the TEMPLATE, not by an env var. A `_cta` template's button URL is
 * `<tracker>/{{1}}`, so `{{1}}` must be the message token; an ordinary template's URL is the real
 * destination, so `{{1}}` stays whatever the nudge configured (normally the mobile).
 *
 * Sending the wrong one is not a cosmetic bug: the tracker would look up `<mobile>` as a token,
 * find nothing, and redirect to the fallback URL — the customer would never reach the payment page.
 *
 * `ctaUrl` is recorded either way, so the export can show which link a recipient was given.
 */
export interface CtaSendParams {
  buttonParams: string[]
  ctaUrl: string | null
  /**
   * Set for a tracked template: the untracked original to retry with if Meta has not approved the
   * tracked one yet. Without it, pointing a live nudge at a freshly created `_cta` template would
   * break its sends until review completes.
   */
  fallback?: { templateName: string; buttonParams: string[] }
}

export function ctaSendParams(opts: {
  /** The template being sent, so the suffix can be detected. */
  templateName: string | null
  /** Where the button would go, from the template spec. Null means the template has no button. */
  destination: string | null
  trackingId: string
  mobileDigits: string
  /** Whatever `whatsappParams.button` resolved to, used verbatim for an untracked template. */
  configured: string[]
}): CtaSendParams {
  if (!opts.destination) return { buttonParams: opts.configured, ctaUrl: null }

  if (isTrackedTemplate(opts.templateName)) {
    return {
      buttonParams: [opts.trackingId],
      ctaUrl: opts.destination,
      fallback: { templateName: baseTemplateName(opts.templateName as string), buttonParams: opts.configured },
    }
  }

  return { buttonParams: opts.configured, ctaUrl: opts.destination }
}
