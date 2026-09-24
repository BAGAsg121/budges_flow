/**
 * Plain-English explanations for email send failures.
 *
 * The WhatsApp side has had this since the beginning; email did not, so a failed email showed
 * a raw provider string like "Zoho Mail API: Internal Error (code 500)" and the operator had
 * to guess whether that meant bad credentials, a bad address, or a provider hiccup.
 *
 * Dependency-free, so both server code and the browser bundle can use it.
 */

export interface MailErrorHelp {
  /** Short label for a badge. */
  label: string
  /** What it means and what to do. */
  detail: string
  /** Whether re-sending could plausibly work. */
  retryable: boolean
}

const RULES: Array<{ match: RegExp; help: MailErrorHelp }> = [
  {
    match: /not configured/i,
    help: {
      label: 'not configured',
      detail:
        'No email transport was configured when this was attempted. Set the ZOHO_MAIL_* credentials (preferred) or SMTP_HOST/SMTP_USER/SMTP_PASS/MAIL_FROM.',
      retryable: false,
    },
  },
  {
    // Zoho reports burst throttling as a bare 500 rather than a 429. Measured in production:
    // 39 sends in 34 seconds, all of them "Internal Error".
    match: /internal error/i,
    help: {
      label: 'provider throttled',
      detail:
        'Zoho returned a bare "Internal Error", which is how it reports burst throttling. The sender spaces sends and retries automatically, so retrying now is worthwhile — if it keeps happening, raise ZOHO_MAIL_MIN_GAP_MS or check the account\'s daily sending limit.',
      retryable: true,
    },
  },
  {
    match: /invalid oauth scope|invalid_scope|scope/i,
    help: {
      label: 'missing scope',
      detail:
        'The refresh token does not grant ZohoMail.messages.CREATE. Regenerate it at api-console.zoho.in with that scope and update ZOHO_MAIL_REFRESH_TOKEN.',
      retryable: false,
    },
  },
  {
    // Deliberately matches both word orders: Zoho says "token refresh failed" in our own
    // wrapper and "invalid_code" from the token endpoint, neither of which reads as the
    // obvious "refresh token". Missing those silently marks dead credentials as retryable.
    match: /invalid[_\s]?(grant|token|code|client)|refresh token|token refresh|unauthorized|\b401\b/i,
    help: {
      label: 'credentials rejected',
      detail:
        'Zoho rejected the credentials. The refresh token may be revoked or belong to a different data centre — regenerate it at api-console.zoho.in and check ZOHO_MAIL_CLIENT_ID / ZOHO_MAIL_CLIENT_SECRET.',
      retryable: false,
    },
  },
  {
    match: /invalid (sender|from)|not a verified|fromAddress|from address/i,
    help: {
      label: 'sender not verified',
      detail: 'The from-address is not a verified sender on that Zoho account. Verify it in Zoho Mail, or change ZOHO_MAIL_FROM_ADDRESS.',
      retryable: false,
    },
  },
  {
    match: /daily limit|quota|too many|sending limit|rate limit|429/i,
    help: {
      label: 'quota reached',
      detail:
        'The account hit its sending limit for the day, or was sending too fast. Retrying later works; raising ZOHO_MAIL_MIN_GAP_MS slows the burst down.',
      retryable: true,
    },
  },
  {
    match: /mailbox (not found|unavailable)|no such user|recipient address rejected|550|551|553/i,
    help: {
      label: 'recipient rejected',
      detail: 'The receiving server rejected this address. It is probably wrong, full, or no longer exists — retrying will not help.',
      retryable: false,
    },
  },
  {
    match: /spam|blocked|blacklist|policy/i,
    help: {
      label: 'blocked by receiver',
      detail: 'The receiving server treated this as spam or blocked the sender. Check the domain\'s sending reputation.',
      retryable: false,
    },
  },
  {
    match: /etimedout|econnrefused|econnreset|enotfound|network|fetch failed|socket hang up/i,
    help: {
      label: 'network error',
      detail: 'The connection to the provider failed before the message was accepted. Usually transient, so retrying is worthwhile.',
      retryable: true,
    },
  },
  {
    match: /content|attachment|size|too large|message too big/i,
    help: {
      label: 'message rejected',
      detail: 'The provider rejected the message content — often an oversized body or an unsupported character. Check the template body.',
      retryable: false,
    },
  },
]

/** Explain a stored email error. Returns null when nothing matches. */
export function explainMailError(input: string | null | undefined): MailErrorHelp | null {
  if (!input) return null
  for (const rule of RULES) {
    if (rule.match.test(input)) return rule.help
  }
  return {
    label: 'send failed',
    detail: 'The provider returned an unrecognised error. The raw text is shown above.',
    retryable: true,
  }
}

/** Should the failures view offer Retry for this email error? */
export function isRetryableMailError(input: string | null | undefined): boolean {
  return explainMailError(input)?.retryable ?? true
}
