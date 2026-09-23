/**
 * WhatsApp connectivity check + test send.
 *
 * GET  /api/whatsapp/test
 *      Reports which pieces of config are present (never the values themselves).
 *
 * POST /api/whatsapp/test
 *      Body: { "to": "9599722251", "text": "optional", "templateName": "optional",
 *              "language": "en", "params": ["a","b"] }
 *      Sends one message and returns Meta's raw result — this is the fastest way to
 *      prove the credentials work before wiring up a nudge.
 *
 *      Without `templateName` it sends free-form text, which Meta only permits inside the
 *      24-hour customer service window (the recipient messaged you first) or to a number
 *      registered as a test recipient in the Meta dashboard.
 *
 * Behind the app password (src/middleware.ts).
 */
import { NextRequest, NextResponse } from 'next/server'
import {
  isWhatsAppConfigured,
  whatsAppConfigStatus,
  normalizePhone,
  sendWhatsAppTemplate,
  sendWhatsAppText,
} from '@/lib/whatsapp'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET() {
  const status = whatsAppConfigStatus()
  const missing: string[] = []
  if (!status.tokenPresent) missing.push('WHATSAPP_TOKEN')
  else if (!status.tokenLooksValid) missing.push('WHATSAPP_TOKEN (does not start with "EAA" — is this an App Secret?)')
  if (!status.phoneNumberIdPresent) missing.push('WHATSAPP_PHONE_NUMBER_ID')
  else if (!status.phoneNumberIdLooksValid)
    missing.push('WHATSAPP_PHONE_NUMBER_ID (must be numeric — the Phone Number ID, not the phone number)')

  return NextResponse.json({
    ok: isWhatsAppConfigured(),
    configured: isWhatsAppConfigured(),
    status,
    missing,
  })
}

export async function POST(req: NextRequest) {
  let body: { to?: string; text?: string; templateName?: string; language?: string; params?: string[] } = {}
  try {
    body = (await req.json()) as typeof body
  } catch {
    // empty body -> use defaults below
  }

  const rawTo = body.to || process.env.WHATSAPP_DISPLAY_NUMBER || ''
  const to = normalizePhone(rawTo)
  if (!to) {
    return NextResponse.json(
      { ok: false, error: `Invalid or missing "to" phone number (got ${JSON.stringify(rawTo)})` },
      { status: 400 }
    )
  }

  const status = whatsAppConfigStatus()
  if (!isWhatsAppConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'WhatsApp is not configured. Set WHATSAPP_TOKEN (System User token starting with "EAA") and WHATSAPP_PHONE_NUMBER_ID (numeric Phone Number ID from WhatsApp Manager).',
        status,
      },
      { status: 400 }
    )
  }

  const startedAt = Date.now()
  const templateName = (body.templateName || '').trim()

  const result = templateName
    ? await sendWhatsAppTemplate({
        to,
        templateName,
        language: body.language || 'en',
        params: Array.isArray(body.params) ? body.params.map(String) : [],
      })
    : await sendWhatsAppText({
        to,
        text:
          body.text ||
          'Nudge Engine test message — if you received this, the WhatsApp integration is working.',
      })

  return NextResponse.json(
    {
      ok: result.ok,
      mode: templateName ? 'template' : 'text',
      to,
      templateName: templateName || null,
      waMessageId: result.waMessageId ?? null,
      error: result.error ?? null,
      latencyMs: Date.now() - startedAt,
      status,
      hint: result.ok
        ? 'Delivered to Meta. Check the phone; delivery/read status will flow back through /api/track/whatsapp.'
        : templateName
          ? 'Template send failed — confirm the template name, its language code, and that Meta approved it.'
          : 'Free-form text is only allowed inside the 24h customer service window, or to a number registered as a test recipient. Otherwise send an approved template instead.',
    },
    { status: result.ok ? 200 : 502 }
  )
}
