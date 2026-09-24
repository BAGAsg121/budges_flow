/**
 * Diagnose a Zoho Mail API 500 "Internal Error".
 *
 *   node --env-file=.env scripts/diagnose-zoho-mail.mjs [to@example.com]
 *
 * Calls the Zoho Mail API directly (not through mailer.ts) so the RAW response body is
 * visible — mailer.ts reduces a failure to one line, which is exactly what hides the cause.
 *
 * It varies ONE thing at a time between payloads and prints the HTTP status and raw body for
 * each, so the culprit (a character, the HTML body, the recipient's domain) can be identified
 * instead of guessed at. Sends only to the address given, defaulting to the sender itself.
 */
const accountsBase = (process.env.ZOHO_ACCOUNTS_BASE || 'https://accounts.zoho.in').replace(/\/+$/, '')
const mailBase = (process.env.ZOHO_MAIL_API_BASE || 'https://mail.zoho.in').replace(/\/+$/, '')
const accountId = process.env.ZOHO_MAIL_ACCOUNT_ID
const fromAddress = process.env.ZOHO_MAIL_FROM_ADDRESS
const to = process.argv[2] || fromAddress

if (!process.env.ZOHO_MAIL_REFRESH_TOKEN || !accountId) {
  console.log('❌ Set the ZOHO_MAIL_* variables first.')
  process.exit(1)
}

// --- token ---
const tokenRes = await fetch(`${accountsBase}/oauth/v2/token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    refresh_token: process.env.ZOHO_MAIL_REFRESH_TOKEN,
    client_id: process.env.ZOHO_MAIL_CLIENT_ID,
    client_secret: process.env.ZOHO_MAIL_CLIENT_SECRET,
    grant_type: 'refresh_token',
  }),
})
const tokenData = await tokenRes.json()
if (!tokenData.access_token) {
  console.log('❌ Token refresh failed:', JSON.stringify(tokenData))
  process.exit(1)
}
const token = tokenData.access_token
console.log(`from  ${fromAddress}\nto    ${to}\naccount ${accountId}\n`)

const PAY_URL = 'https://eps.eko.in/console/pay-activation-fee'
const HTML_CTA = `<p style="text-align:center;margin:28px 0;">
    <a href="${PAY_URL}?mobile=9876543210" style="background:#0d9488;color:#ffffff;padding:12px 30px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block;">REVIEW and PAY</a>
  </p>`
const EMOJI = '🎉'
const EMDASH = '—'

/** One trial: a label plus the fields it overrides. */
const trials = [
  { label: '1. plain ASCII subject + plain body', subject: 'Nudge diagnostic (plain)', content: '<p>Hello, this is a plain test.</p>' },
  { label: '2. EMOJI in subject', subject: `${EMOJI} Nudge diagnostic`, content: '<p>Hello, this is a plain test.</p>' },
  { label: '3. EMDASH in subject', subject: `Nudge diagnostic ${EMDASH} pay today`, content: '<p>Hello, this is a plain test.</p>' },
  { label: '4. emoji in BODY', subject: 'Nudge diagnostic (emoji body)', content: `<p>${EMOJI} Special discounts are expiring soon!</p>` },
  {
    label: '5. emoji subject AND emoji body',
    subject: `${EMOJI} Special discounts expiring soon!`,
    content: `<p>${EMOJI} Special discounts are expiring soon!</p>`,
  },
  {
    label: '6. full real template as sent (emoji subject + CTA html)',
    subject: `${EMOJI} Special discounts expiring soon ${EMDASH} pay your activation fee today`,
    content: `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a;">
  <p>Hi Test,</p>
  <p>${EMOJI} Special discounts expiring soon! Pay your one-time fee today to avail the discount before it expires.</p>
  ${HTML_CTA}
  <p>Thanks,<br/>Eko Team</p>
</div>`,
  },
  { label: '7. plain subject + CTA html only', subject: 'Nudge diagnostic (cta html)', content: HTML_CTA },
  { label: '8. plain subject + non-ascii quotes/dashes', subject: 'Nudge diagnostic (typography)', content: '<p>It’s a “test” — with typographic punctuation…</p>' },
]

let failures = 0

for (const t of trials) {
  const payload = {
    fromAddress,
    toAddress: to,
    subject: t.subject,
    content: t.content,
    mailFormat: 'html',
    askReceipt: 'no',
  }

  let status = 0
  let raw = ''
  try {
    const res = await fetch(`${mailBase}/api/accounts/${accountId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Zoho-oauthtoken ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    status = res.status
    raw = await res.text()
  } catch (err) {
    raw = `network error: ${err instanceof Error ? err.message : String(err)}`
  }

  const ok = status === 200 && /"code"\s*:\s*200/.test(raw)
  if (!ok) failures++
  console.log(`${ok ? '✅' : '❌'} ${t.label}`)
  console.log(`     HTTP ${status}  ${raw.slice(0, 300).replace(/\s+/g, ' ')}`)

  // Space the trials out so throttling cannot masquerade as a content problem.
  await new Promise((r) => setTimeout(r, 1500))
}

console.log(
  failures === 0
    ? '\nAll variants accepted — the 500 is NOT content-related. Look at the recipient domain or the account.'
    : `\n${failures} variant(s) rejected — the label above names what broke it.`
)
