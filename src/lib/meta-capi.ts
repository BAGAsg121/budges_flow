/**
 * Meta Conversions API — reporting WhatsApp-driven conversions back to Meta.
 *
 * WHY THIS EXISTS: for ad optimisation Meta needs to know what happened AFTER the message, not
 * just that it was delivered. A delivered/read receipt is a messaging metric; a conversion is a
 * business event. Reporting them lets Meta attribute returns to the campaign that produced them.
 *
 * HOW IT WORKS FOR A WABA: events go to a **dataset** (a Pixel / dataset ID) through the standard
 * Conversions API endpoint, with `action_source: "business_messaging"` and
 * `messaging_channel: "whatsapp"` so Meta knows the event came out of WhatsApp rather than a
 * website. User identifiers must be **SHA-256 hashed** before sending — never send a raw phone
 * number or email.
 *
 *   POST https://graph.facebook.com/v21.0/<DATASET_ID>/events?access_token=<TOKEN>
 *
 * ENV:
 *   META_CAPI_DATASET_ID        the dataset / Pixel ID the events belong to
 *   META_CAPI_TOKEN             a token with access to that dataset
 *   META_CAPI_API_VERSION       default v21.0
 *   META_CAPI_TEST_EVENT_CODE   optional; routes events to the Events Manager "Test events" tab
 *   META_CAPI_CTA_EVENT_NAME    event name for a WhatsApp button click (default: CTA_Click)
 *   META_CAPI_CTA_EVENT_ENABLED "true" to report button clicks automatically
 *
 * HONEST LIMIT: this module is built from Meta's documented contract and its payload shape is
 * unit-tested, but it has NOT been verified against a live dataset — that needs the account's own
 * dataset ID and token. Confirm the exact required fields for your WABA in Events Manager before
 * trusting a live stream.
 */
import { createHash } from 'crypto'

export function capiDatasetId(): string {
  return (process.env.META_CAPI_DATASET_ID || '').trim()
}

export function capiToken(): string {
  return (process.env.META_CAPI_TOKEN || '').trim()
}

export function capiApiVersion(): string {
  return (process.env.META_CAPI_API_VERSION || 'v21.0').trim()
}

export function capiTestEventCode(): string {
  return (process.env.META_CAPI_TEST_EVENT_CODE || '').trim()
}

export function isMetaCapiConfigured(): boolean {
  return Boolean(capiDatasetId() && capiToken())
}

/** Event name used for a WhatsApp CTA click. Standard names optimise best; a custom one is fine. */
export function capiCtaEventName(): string {
  return (process.env.META_CAPI_CTA_EVENT_NAME || 'CTA_Click').trim()
}

export function isCtaConversionReportingEnabled(): boolean {
  return isMetaCapiConfigured() && (process.env.META_CAPI_CTA_EVENT_ENABLED || '').toLowerCase() === 'true'
}

/* ────────────────────────────── hashing ────────────────────────────── */

/** SHA-256, lowercase hex — the only form Meta accepts for user identifiers. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/**
 * Normalise a phone the way Meta expects before hashing: digits only, country code included,
 * no `+`, no spaces, no trunk zero. A mismatch here is silent — the event is accepted and simply
 * never matches anyone.
 */
export function normalisePhoneForHashing(raw: string, defaultCountryCode = '91'): string {
  let digits = String(raw || '').replace(/\D/g, '')
  if (!digits) return ''
  digits = digits.replace(/^0+/, '')
  // A bare 10-digit national number needs the country code prepended.
  if (digits.length === 10) digits = `${defaultCountryCode}${digits}`
  return digits
}

/** Emails must be trimmed and lowercased before hashing. */
export function normaliseEmailForHashing(raw: string | null | undefined): string {
  return String(raw || '').trim().toLowerCase()
}

/* ────────────────────────────── payload ────────────────────────────── */

export interface ConversionInput {
  eventName: string
  /** When it happened. Defaults to now. */
  eventTime?: Date
  phone?: string | null
  email?: string | null
  /** From the inbound message's `referral.ctwa_clid` for a Click-to-WhatsApp ad. */
  ctwaClid?: string | null
  /** Deduplicates retries of the same event. Use the MessageLog tracking id. */
  eventId?: string | null
  value?: number | null
  currency?: string | null
  /** Defaults to business_messaging — this app only reports WhatsApp-originated events. */
  actionSource?: string
  defaultCountryCode?: string
}

export interface MetaEvent {
  event_name: string
  event_time: number
  action_source: string
  messaging_channel?: string
  event_id?: string
  user_data: { ph?: string[]; em?: string[]; ctwa_clid?: string }
  custom_data?: { value?: number; currency?: string }
}

/**
 * Build one Conversions API event.
 *
 * Only identifiers that actually exist are included — an empty `ph: []` is worse than omitting
 * the field, because Meta may then match on nothing and drop the event.
 */
export function buildConversionEvent(input: ConversionInput): MetaEvent {
  const eventTime = input.eventTime ?? new Date()
  const userData: MetaEvent['user_data'] = {}

  const phone = normalisePhoneForHashing(input.phone || '', input.defaultCountryCode || process.env.WHATSAPP_DEFAULT_CC || '91')
  if (phone) userData.ph = [sha256Hex(phone)]

  const email = normaliseEmailForHashing(input.email)
  if (email) userData.em = [sha256Hex(email)]

  // ctwa_clid is NOT hashed — it is an opaque click id Meta issues.
  if (input.ctwaClid) userData.ctwa_clid = input.ctwaClid

  const event: MetaEvent = {
    event_name: input.eventName,
    event_time: Math.floor(eventTime.getTime() / 1000),
    action_source: input.actionSource || 'business_messaging',
    messaging_channel: 'whatsapp',
    user_data: userData,
  }

  if (input.eventId) event.event_id = input.eventId

  if (input.value !== null && input.value !== undefined) {
    event.custom_data = { value: input.value, currency: input.currency || 'INR' }
  }

  return event
}

/* ────────────────────────────── sending ────────────────────────────── */

export interface CapiResult {
  ok: boolean
  /** Meta's per-event result, when it answered. */
  received?: number
  error?: string
  payload?: unknown
}

/**
 * Send events. Never throws — a failed analytics call must not break the customer's click.
 *
 * `test_event_code` is included only when configured, which routes the events to the Events
 * Manager "Test events" tab instead of counting them.
 */
export async function sendMetaConversions(events: MetaEvent[], fetchImpl: typeof fetch = fetch): Promise<CapiResult> {
  if (!isMetaCapiConfigured()) {
    return { ok: false, error: 'Meta CAPI is not configured (META_CAPI_DATASET_ID / META_CAPI_TOKEN).' }
  }
  if (!events.length) return { ok: false, error: 'No events to send.' }

  const body: Record<string, unknown> = { data: events }
  const testCode = capiTestEventCode()
  if (testCode) body.test_event_code = testCode

  try {
    const res = await fetchImpl(
      `https://graph.facebook.com/${capiApiVersion()}/${encodeURIComponent(capiDatasetId())}/events`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${capiToken()}` },
        body: JSON.stringify(body),
      }
    )
    const text = await res.text()
    let parsed: { events_received?: number; error?: { message?: string; code?: number } } = {}
    try {
      parsed = JSON.parse(text) as typeof parsed
    } catch {
      // fall through to the raw text below
    }

    if (!res.ok || parsed.error) {
      return {
        ok: false,
        error: `Meta CAPI HTTP ${res.status}: ${parsed.error?.message || text.slice(0, 300)}`,
        payload: body,
      }
    }

    return { ok: true, received: parsed.events_received ?? events.length, payload: body }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), payload: body }
  }
}

/** Report a WhatsApp URL-button click as a conversion, best-effort. */
export async function reportCtaClickConversion(opts: {
  phone?: string | null
  email?: string | null
  trackingId?: string | null
  ctwaClid?: string | null
}): Promise<CapiResult> {
  if (!isCtaConversionReportingEnabled()) {
    return { ok: false, error: 'CTA conversion reporting is off (set META_CAPI_DATASET_ID, META_CAPI_TOKEN and META_CAPI_CTA_EVENT_ENABLED=true).' }
  }
  const event = buildConversionEvent({
    eventName: capiCtaEventName(),
    phone: opts.phone,
    email: opts.email,
    ctwaClid: opts.ctwaClid,
    // The tracking id makes a repeated click idempotent in Meta's dedup window.
    eventId: opts.trackingId,
  })
  return sendMetaConversions([event])
}
