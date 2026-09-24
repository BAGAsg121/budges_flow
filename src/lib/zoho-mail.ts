/**
 * Zoho Mail REST API sender.
 *
 * This is how the original n8n flow sent email: an OAuth refresh token against
 * `https://mail.zoho.in/api/accounts/{accountId}/messages` — NOT SMTP. The app was built
 * with an SMTP transport, so the Zoho Mail credentials sitting in .env were never used and
 * every send failed with "SMTP not configured".
 *
 * Both transports are now supported; see selectMailTransport() in @/lib/mailer.
 *
 * Env:
 *   ZOHO_MAIL_CLIENT_ID, ZOHO_MAIL_CLIENT_SECRET, ZOHO_MAIL_REFRESH_TOKEN
 *   ZOHO_MAIL_ACCOUNT_ID     e.g. 1211051000000002002
 *   ZOHO_MAIL_FROM_ADDRESS   e.g. do.not.reply@eko.co.in (must be a verified sender)
 *   ZOHO_MAIL_API_BASE       default https://mail.zoho.in
 *   ZOHO_ACCOUNTS_BASE       default https://accounts.zoho.in
 */

/** Kept local (rather than imported from mailer) so this module has no path aliases and the
 *  CLI scripts can import and exercise the real sender. */
export interface MailSendResult {
  ok: boolean
  messageId?: string
  error?: string
}

const accountsBase = () => (process.env.ZOHO_ACCOUNTS_BASE || 'https://accounts.zoho.in').replace(/\/+$/, '')
const mailApiBase = () => (process.env.ZOHO_MAIL_API_BASE || 'https://mail.zoho.in').replace(/\/+$/, '')

export function isZohoMailConfigured(): boolean {
  return Boolean(
    process.env.ZOHO_MAIL_CLIENT_ID &&
      process.env.ZOHO_MAIL_CLIENT_SECRET &&
      process.env.ZOHO_MAIL_REFRESH_TOKEN &&
      process.env.ZOHO_MAIL_ACCOUNT_ID &&
      process.env.ZOHO_MAIL_FROM_ADDRESS
  )
}

interface MailTokenCache {
  token: string
  expiresAt: number
}
let mailTokenCache: MailTokenCache | null = null

export function clearZohoMailTokenCache() {
  mailTokenCache = null
}

async function getMailAccessToken(force = false): Promise<string> {
  if (!force && mailTokenCache && Date.now() < mailTokenCache.expiresAt) return mailTokenCache.token

  const body = new URLSearchParams({
    refresh_token: process.env.ZOHO_MAIL_REFRESH_TOKEN as string,
    client_id: process.env.ZOHO_MAIL_CLIENT_ID as string,
    client_secret: process.env.ZOHO_MAIL_CLIENT_SECRET as string,
    grant_type: 'refresh_token',
  })

  const res = await fetch(`${accountsBase()}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string }

  if (!res.ok || !data.access_token) {
    throw new Error(
      `Zoho Mail token refresh failed: ${data.error || `HTTP ${res.status}`}. Check ZOHO_MAIL_CLIENT_ID / ZOHO_MAIL_CLIENT_SECRET / ZOHO_MAIL_REFRESH_TOKEN.`
    )
  }

  mailTokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 - 60_000,
  }
  return mailTokenCache.token
}

/** Send one email through the Zoho Mail API. Never throws. */
export async function sendViaZohoMail(opts: { to: string; subject: string; html: string }): Promise<MailSendResult> {
  if (!isZohoMailConfigured()) {
    return { ok: false, error: 'Zoho Mail is not configured (ZOHO_MAIL_CLIENT_ID/SECRET/REFRESH_TOKEN/ACCOUNT_ID/FROM_ADDRESS)' }
  }

  const accountId = process.env.ZOHO_MAIL_ACCOUNT_ID
  const fromAddress = process.env.ZOHO_MAIL_FROM_ADDRESS
  const url = `${mailApiBase()}/api/accounts/${accountId}/messages`

  const attempt = async (token: string) =>
    fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fromAddress,
        toAddress: opts.to,
        subject: opts.subject,
        content: opts.html,
        mailFormat: 'html',
        askReceipt: 'no',
      }),
    })

  const attempts = positiveInt(process.env.ZOHO_MAIL_MAX_ATTEMPTS, 4)
  let lastError = 'unknown error'

  for (let n = 1; n <= attempts; n++) {
    await throttleZohoMail()

    try {
      let res = await attempt(await getMailAccessToken())

      // Access token may have just expired -> refresh once and retry immediately.
      if (res.status === 401) {
        clearZohoMailTokenCache()
        res = await attempt(await getMailAccessToken(true))
      }

      const data = (await res.json().catch(() => ({}))) as ZohoResponse

      // Zoho reports application errors in the body with an HTTP 200, so check both.
      const code = data.status?.code
      const ok = res.ok && (code === undefined || Number(code) === 200)

      if (ok) {
        const messageId = data.data?.messageId ?? data.data?.mailId
        return { ok: true, messageId: messageId === undefined ? undefined : String(messageId) }
      }

      const detail = zohoErrorDetail(data, res.status)
      lastError = `Zoho Mail API: ${detail}${data.status?.code ? ` (code ${data.status.code})` : ''}`

      // An account-level sending block is not a transient fault. Retrying cannot help and
      // actively makes it worse — Zoho lengthens the block for repeated attempts — so this
      // returns immediately instead of burning three more tries.
      if (isSendingBlocked(detail)) {
        return { ok: false, error: `${lastError}.${SENDING_BLOCKED_HINT}` }
      }

      if (!isRetryable(res.status, code, detail) || n === attempts) {
        return {
          ok: false,
          error: `${lastError}${n > 1 ? ` — gave up after ${n} attempt(s)` : ''}`,
        }
      }
    } catch (err) {
      // Network-level failure: also worth retrying.
      lastError = err instanceof Error ? err.message : String(err)
      if (n === attempts) return { ok: false, error: `${lastError} — gave up after ${n} attempt(s)` }
    }

    await sleep(backoffMs(n))
  }

  return { ok: false, error: lastError }
}

interface ZohoResponse {
  status?: { code?: number; description?: string }
  data?: { messageId?: string; mailId?: string; moreInfo?: string }
  error?: unknown
}

/**
 * The real reason a send failed.
 *
 * Zoho answers a rejected message with `status.description = "Internal Error"` and puts the
 * ONLY useful sentence in `data.moreInfo`. Reporting the former (as this code used to) turned
 * every rejection into an indistinguishable "Internal Error (code 500)" — which is how a
 * hard account block masqueraded as transient throttling for two days.
 */
function zohoErrorDetail(data: ZohoResponse, httpStatus: number): string {
  const moreInfo = data.data?.moreInfo
  if (moreInfo) return stripHtml(moreInfo)
  if (data.status?.description) return data.status.description
  if (data.error) return JSON.stringify(data.error).slice(0, 300)
  return `HTTP ${httpStatus}`
}

/** moreInfo ships with an anchor tag; keep the sentence, drop the markup. */
function stripHtml(s: string): string {
  return s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Zoho's account-level "unusual sending activity" block (SMTP 550 5.4.6). */
function isSendingBlocked(detail: string): boolean {
  return /unusual sending activity|5\.4\.6|usage-policy/i.test(detail)
}

export const SENDING_BLOCKED_HINT =
  ' This is Zoho\'s account-level sending block for external recipients — internal (same-domain) ' +
  'mail still works, which is why a test to the sending address succeeds while customer mail fails. ' +
  'Retrying extends the block, so sending should be paused and the account reviewed with Zoho ' +
  '(https://www.zoho.in/mail/help/usage-policy.html)'

/** Zoho caps per_page style knobs loosely; guard against nonsense env values. */
function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Exponential backoff with jitter.
 *
 * Jitter matters because a burst fails together and would otherwise retry together, landing
 * the same thundering herd back on the API at the same instant.
 */
function backoffMs(attempt: number): number {
  const base = positiveInt(process.env.ZOHO_MAIL_RETRY_BASE_MS, 800)
  return Math.round(base * 2 ** (attempt - 1) * (0.7 + Math.random() * 0.6))
}

/**
 * A burst of sends is throttled by Zoho, which reports it as a bare `500 Internal Error`
 * rather than a 429. Measured in production: 39 sends inside 34 seconds, 39 failures, while a
 * single send immediately afterwards succeeded. So a retry could never help unless the sends
 * were also spaced out.
 */
/**
 * Is this worth trying again immediately?
 *
 * Note what is NOT retryable: an account-level sending block, which is checked before this is
 * reached. A `500` on its own still is, because Zoho genuinely uses it for transient faults.
 */
function isRetryable(httpStatus: number, bodyCode: number | undefined, detail: string): boolean {
  if (isSendingBlocked(detail)) return false
  if (httpStatus === 429 || httpStatus >= 500) return true
  if (bodyCode !== undefined && Number(bodyCode) >= 500) return true
  return /temporarily|try again|too many|rate limit/i.test(detail)
}

/** Minimum gap between sends, enforced across concurrent callers. */
let nextSendAllowedAt = 0

async function throttleZohoMail(): Promise<void> {
  const gap = positiveInt(process.env.ZOHO_MAIL_MIN_GAP_MS, 1100)
  const now = Date.now()
  const wait = Math.max(0, nextSendAllowedAt - now)
  // Reserve this slot before awaiting, so parallel callers queue instead of racing.
  nextSendAllowedAt = Math.max(now, nextSendAllowedAt) + gap
  if (wait > 0) await sleep(wait)
}

/** Config summary for diagnostics — never returns secrets. */
export function zohoMailStatus() {
  return {
    clientIdPresent: Boolean(process.env.ZOHO_MAIL_CLIENT_ID),
    clientSecretPresent: Boolean(process.env.ZOHO_MAIL_CLIENT_SECRET),
    refreshTokenPresent: Boolean(process.env.ZOHO_MAIL_REFRESH_TOKEN),
    accountId: process.env.ZOHO_MAIL_ACCOUNT_ID || null,
    fromAddress: process.env.ZOHO_MAIL_FROM_ADDRESS || null,
    apiBase: mailApiBase(),
  }
}
