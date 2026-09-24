/**
 * Email connectivity check + test send.
 *
 * GET  /api/email/test
 *      Reports which transport is active and which credentials are present —
 *      booleans only, never the secret values.
 *
 * POST /api/email/test
 *      Body: { "to": "someone@example.com" }   (optional)
 *      Sends one real email through the SAME code path a nudge uses and returns the
 *      transport that handled it plus its message id. This is the fastest way to prove
 *      a deployment's mail credentials work without running a nudge against real leads.
 *
 *      Defaults to the configured MAIL_FROM / ZOHO_MAIL_FROM_ADDRESS, so a self-test needs
 *      no request body at all.
 *
 * Behind the app password (src/middleware.ts).
 */
import { NextRequest, NextResponse } from 'next/server'
import { describeMailConfig, isMailerConfigured, selectMailTransport, sendEmail } from '@/lib/mailer'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/** Never echo a credential — only whether it is usable. */
function configSummary() {
  const config = describeMailConfig()
  const missing: string[] = []

  if (!config.zoho.clientIdPresent) missing.push('ZOHO_MAIL_CLIENT_ID')
  if (!config.zoho.clientSecretPresent) missing.push('ZOHO_MAIL_CLIENT_SECRET')
  if (!config.zoho.refreshTokenPresent) missing.push('ZOHO_MAIL_REFRESH_TOKEN')
  if (!config.zoho.accountId) missing.push('ZOHO_MAIL_ACCOUNT_ID')
  if (!config.zoho.fromAddress) missing.push('ZOHO_MAIL_FROM_ADDRESS')

  return {
    forcedTransport: config.forced,
    selectedTransport: config.transport || null,
    zoho: {
      clientIdPresent: config.zoho.clientIdPresent,
      clientSecretPresent: config.zoho.clientSecretPresent,
      refreshTokenPresent: config.zoho.refreshTokenPresent,
      accountId: config.zoho.accountId || null,
      fromAddress: config.zoho.fromAddress || null,
      apiBase: config.zoho.apiBase,
    },
    smtp: {
      host: config.smtp.host || null,
      userPresent: config.smtp.userPresent,
      passPresent: config.smtp.passPresent,
      from: config.smtp.from || null,
    },
    zohoMissingEnvVars: missing,
    configError: config.error || null,
  }
}

export async function GET() {
  const summary = configSummary()
  return NextResponse.json({
    ok: isMailerConfigured(),
    configured: isMailerConfigured(),
    ...summary,
    hint: isMailerConfigured()
      ? `Email will go out through the "${summary.selectedTransport}" transport. POST {"to":"…"} here to send a real test.`
      : summary.zohoMissingEnvVars.length === 0
        ? 'Nothing is configured. Set the ZOHO_MAIL_* variables (preferred) or SMTP_HOST/SMTP_USER/SMTP_PASS/MAIL_FROM.'
        : `Zoho Mail is missing: ${summary.zohoMissingEnvVars.join(', ')}. Set them, or configure SMTP.`,
  })
}

export async function POST(req: NextRequest) {
  let body: { to?: string; subject?: string } = {}
  try {
    body = (await req.json()) as typeof body
  } catch {
    // empty body -> self-test to the configured from-address
  }

  const config = describeMailConfig()
  const to =
    (body.to || '').trim() ||
    (config.zoho.fromAddress || '').trim() ||
    (config.smtp.from || '').trim() ||
    ''

  if (!to) {
    return NextResponse.json(
      { ok: false, error: 'No recipient, and no MAIL_FROM / ZOHO_MAIL_FROM_ADDRESS to fall back to.', ...configSummary() },
      { status: 400 }
    )
  }
  // Deliberately loose — a bad address should come back as a transport error, not a 400.
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
    return NextResponse.json({ ok: false, error: `"${to}" does not look like an email address.` }, { status: 400 })
  }

  if (!isMailerConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        to,
        error:
          'No email transport is configured. Set the ZOHO_MAIL_* credentials (ZOHO_MAIL_CLIENT_ID/SECRET/REFRESH_TOKEN/ACCOUNT_ID/FROM_ADDRESS) or SMTP_HOST/SMTP_USER/SMTP_PASS/MAIL_FROM.',
        ...configSummary(),
      },
      { status: 400 }
    )
  }

  const startedAt = Date.now()
  const result = await sendEmail({
    to,
    subject: body.subject || 'Nudge Engine email test',
    html:
      '<p>This is a test message from the Nudge Engine.</p>' +
      '<p>If you received it, the email transport on this deployment works.</p>',
    text:
      'This is a test message from the Nudge Engine. If you received it, the email transport on this deployment works.',
  })

  return NextResponse.json(
    {
      ok: result.ok,
      to,
      transport: result.transport ?? selectMailTransport() ?? null,
      messageId: result.messageId ?? null,
      error: result.error ?? null,
      latencyMs: Date.now() - startedAt,
      ...configSummary(),
      hint: result.ok
        ? 'Sent. If it is not in the inbox, check the spam folder and the sender reputation of the from-address.'
        : 'Zoho Mail: a failed refresh usually means the token was revoked or came from another DC (api-console.zoho.in), the token lacks ZohoMail.messages.CREATE, or the from-address is not a verified sender on that account.',
    },
    { status: result.ok ? 200 : 502 }
  )
}
