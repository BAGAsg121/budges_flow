/**
 * Plain-English explanations for Meta's WhatsApp delivery errors.
 *
 * Dependency-free so both server code and the browser bundle can use it.
 * Codes come from the Graph API error object (`code` / `error_subcode`) and from the
 * delivery-failure text Meta sends on the status webhook.
 */

interface ErrorHelp {
  /** Short label for a badge. */
  label: string
  /** What it means and what to do. */
  detail: string
  /**
   * Whether re-sending the same message could plausibly work. Caps are retryable (the window
   * rolls); a number that is not on WhatsApp, or a template that does not exist, is not.
   */
  retryable?: boolean
}

const BY_CODE: Record<number, ErrorHelp> = {
  131026: {
    label: 'undeliverable',
    detail: 'The recipient cannot receive WhatsApp messages — the number is not on WhatsApp, is invalid, or has blocked the business.',
  },
  131047: {
    label: 'outside 24h window',
    detail: 'More than 24 hours have passed since the customer last messaged you, so free-form text is not allowed. Send an approved template instead.',
  },
  131049: {
    label: 'engagement cap',
    detail:
      "Meta dropped this to maintain healthy ecosystem engagement — its per-user marketing frequency cap. The recipient has been sent too much marketing recently. Reaching them needs their opt-in, or a UTILITY-category template rather than MARKETING.",
  },
  131050: {
    label: 'opted out of marketing',
    detail: 'The user is part of an experiment and has opted out of marketing messages. Only non-marketing templates can reach them.',
  },
  131051: {
    label: 'unsupported message type',
    detail: 'Meta does not support this message type for the account.',
  },
  131052: {
    label: 'media download failed',
    detail: 'Meta could not download the media from your URL.',
  },
  131053: {
    label: 'media upload failed',
    detail: 'Media upload failed — check the file type, size and the media ID.',
  },
  132000: {
    label: 'parameter mismatch',
    detail: "The number of parameters sent does not match the template's variables. Check the nudge's Template parameters against the approved template.",
  },
  132001: {
    label: 'template not found',
    detail: "The template name does not exist in that language on this WABA. Meta treats 'en' and 'en_US' as different locales — copy the language exactly from the Templates tab.",
  },
  132005: {
    label: 'template paused',
    detail: 'Meta has paused this template, usually for low quality or user feedback.',
  },
  132007: {
    label: 'template disabled',
    detail: 'The template was disabled for a policy violation. Edit the content and resubmit.',
  },
  132012: {
    label: 'template parameter format',
    detail: 'A template parameter has the wrong format (for example a URL button variable that is not a plain value).',
  },
  132015: {
    label: 'template paused',
    detail: 'This template is paused and cannot be sent until Meta reactivates it.',
  },
  133010: {
    label: 'number not registered',
    detail: 'The WhatsApp Business phone number is not registered on the platform.',
  },
  133016: {
    label: 'number restricted',
    detail: 'This phone number is temporarily restricted by Meta.',
  },
  131042: {
    label: 'billing issue',
    detail: 'There is a payment or billing problem on the WhatsApp Business Account.',
  },
  368: {
    label: 'account blocked',
    detail: 'The account has been temporarily blocked for policy violations.',
  },
  80007: {
    label: 'rate limited',
    detail: 'Rate limit reached for this phone number. Slow the sending down.',
  },
  131056: {
    label: 'pair rate limit',
    detail: 'Too many messages sent to this recipient in a short period — Meta limits per (business, user) pair.',
  },
  190: {
    label: 'token invalid',
    detail: 'The WhatsApp access token is invalid or expired. Temporary tokens lapse after 24 hours; use a System User token.',
  },
}

/** Fallback matching on the message text, for errors that arrive without a code. */
function byText(message: string): ErrorHelp | null {
  const m = message.toLowerCase()
  if (m.includes('healthy ecosystem engagement')) return BY_CODE[131049]
  if (m.includes('part of an experiment')) return BY_CODE[131050]
  if (m.includes('undeliverable')) return BY_CODE[131026]
  if (m.includes('not configured')) {
    // Channel-neutral: the same phrasing is used when the mail transport is missing.
    return {
      label: 'not configured',
      detail:
        'The provider credentials were missing when this was attempted. Check the WhatsApp blocks (WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID) and the email transport (Zoho Mail credentials or SMTP_USER/SMTP_PASS) in the environment.',
    }
  }
  if (m.includes('24 hour') || m.includes('re-engagement')) return BY_CODE[131047]
  return null
}

/** Codes where Meta dropped the message for a marketing/engagement reason rather than a fault. */
const DELIVERY_CAP_CODES = new Set([131049, 131050])

/**
 * True when a failure is Meta's per-user marketing cap / opt-out rather than a real error.
 *
 * These are worth RETRYING LATER: the cap is a rolling per-user window, so the same message
 * can be accepted a day later. Hammering every scheduler cycle just burns quota and floods
 * the log with identical failures.
 */
type ErrorInput = { code?: number | null; message?: string | null } | string | null | undefined

export function isDeliveryCapError(input: ErrorInput): boolean {
  if (!input) return false
  const raw = typeof input === 'string' ? input : input.message || ''
  const code = typeof input === 'string' ? Number(raw.match(/\(code (\d+)/)?.[1]) : input.code ?? undefined
  if (code && DELIVERY_CAP_CODES.has(code)) return true
  const m = raw.toLowerCase()
  return m.includes('healthy ecosystem engagement') || m.includes('part of an experiment')
}

/** True when the recipient simply cannot be reached on WhatsApp, so retrying is pointless. */
export function isPermanentDeliveryFailure(input: ErrorInput): boolean {
  if (!input) return false
  const raw = typeof input === 'string' ? input : input.message || ''
  const code = typeof input === 'string' ? Number(raw.match(/\(code (\d+)/)?.[1]) : input.code ?? undefined
  if (code && [131026, 131051, 133010, 132007].includes(code)) return true
  const m = raw.toLowerCase()
  return m.includes('undeliverable') || m.includes('not a valid whatsapp') || m.includes('template disabled')
}

/**
 * How long to wait before retrying a recipient Meta capped.
 * The cap is a rolling window, so a day is a reasonable default.
 */
export function capBackoffHours(): number {
  const raw = Number(process.env.DELIVERY_CAP_BACKOFF_HOURS || 24)
  return Number.isFinite(raw) && raw > 0 ? raw : 24
}

/**
 * Explain a stored WhatsApp error. Accepts either a raw error string (as saved in the log)
 * or a code plus message.
 */
export function explainWhatsAppError(input: ErrorInput): ErrorHelp | null {
  const help = explainRaw(input)
  if (!help) return null
  return { ...help, retryable: isRetryableWhatsAppError(input, help) }
}

function explainRaw(input: ErrorInput): ErrorHelp | null {
  if (!input) return null
  if (typeof input === 'string') {
    const codeMatch = input.match(/\(code (\d+)/)
    if (codeMatch) {
      const help = BY_CODE[Number(codeMatch[1])]
      if (help) return help
    }
    return byText(input)
  }
  if (input.code && BY_CODE[input.code]) return BY_CODE[input.code]
  if (input.message) return byText(input.message)
  return null
}

/**
 * Should the failures view offer a Retry button for this error?
 *
 * Not retryable: the recipient is unreachable, or the failure is a configuration mistake on
 * our side (a wrong template name, a parameter mismatch, a bad token) — re-sending the same
 * thing would fail identically and just add noise. Retryable: engagement caps, rate limits,
 * billing hiccups, and unexplained transport errors.
 */
export function isRetryableWhatsAppError(input: ErrorInput, help?: ErrorHelp | null): boolean {
  const resolved = help ?? explainRaw(input)
  const label = (resolved?.label || '').toLowerCase()

  if (isPermanentDeliveryFailure(input)) return false
  if (['not configured', 'template not found', 'template disabled', 'parameter mismatch', 'token invalid', 'number not registered'].includes(label)) {
    return false
  }
  // A cap is explicitly retryable — that is the whole point of the backoff.
  if (isDeliveryCapError(input)) return true
  return true
}
