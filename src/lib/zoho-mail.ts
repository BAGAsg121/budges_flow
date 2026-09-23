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

  try {
    let res = await attempt(await getMailAccessToken())

    // Access token may have just expired -> refresh once and retry.
    if (res.status === 401) {
      clearZohoMailTokenCache()
      res = await attempt(await getMailAccessToken(true))
    }

    const data = (await res.json().catch(() => ({}))) as {
      status?: { code?: number; description?: string }
      data?: { messageId?: string; mailId?: string }
      error?: unknown
    }

    // Zoho reports application errors in the body with an HTTP 200, so check both.
    const code = data.status?.code
    const ok = res.ok && (code === undefined || Number(code) === 200)

    if (!ok) {
      const detail =
        data.status?.description || (data.error ? JSON.stringify(data.error).slice(0, 300) : `HTTP ${res.status}`)
      return { ok: false, error: `Zoho Mail API: ${detail}${code ? ` (code ${code})` : ''}` }
    }

    const messageId = data.data?.messageId ?? data.data?.mailId
    return { ok: true, messageId: messageId === undefined ? undefined : String(messageId) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
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
