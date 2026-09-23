/**
 * WhatsApp Business Cloud API (Meta) sender.
 *
 * One-time Meta setup (outside this app):
 *   1. business.facebook.com -> create WhatsApp Business Account (WABA) + register the number
 *      (e.g. 9599722251 -> +91 95997 22251)
 *   2. Create a System User token with whatsapp_business_messaging + whatsapp_business_management scopes
 *   3. Create & get approval for message templates (business-initiated messages REQUIRE templates)
 *   4. .env: WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_VERIFY_TOKEN
 *   5. Point the Meta webhook to {APP_URL}/api/track/whatsapp with the same verify token
 */
import { db } from '@/lib/db'
import { createHmac, timingSafeEqual } from 'crypto'
import { appendInbound, type InboundMessage } from '@/lib/whatsapp-inbound'

const GRAPH_BASE = () => `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION || 'v21.0'}`

export function isWhatsAppConfigured(): boolean {
  return Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID)
}

/** Which pieces of WhatsApp config are present (never returns the values themselves). */
export function whatsAppConfigStatus() {
  const token = process.env.WHATSAPP_TOKEN || ''
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID || ''
  return {
    tokenPresent: Boolean(token),
    // Length + prefix are enough to spot the classic mistakes without leaking the value.
    tokenLength: token.length,
    tokenLooksValid: token.startsWith('EAA'),
    phoneNumberIdPresent: Boolean(phoneNumberId),
    phoneNumberIdLooksValid: /^\d{10,20}$/.test(phoneNumberId),
    appSecretPresent: Boolean(process.env.WHATSAPP_APP_SECRET),
    wabaIdPresent: Boolean(process.env.WHATSAPP_WABA_ID),
    templateLanguage: process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'en_US (default)',
    displayNumber: process.env.WHATSAPP_DISPLAY_NUMBER || null,
    apiVersion: process.env.WHATSAPP_API_VERSION || 'v21.0',
  }
}

/** Human explanation for a token that is missing or the wrong kind of value. */
export function describeTokenProblem(status: ReturnType<typeof whatsAppConfigStatus>): string | null {
  if (!status.tokenPresent) return 'WHATSAPP_TOKEN is not set.'
  if (status.tokenLooksValid) return null
  if (status.tokenLength === 32)
    return `WHATSAPP_TOKEN is 32 characters and does not start with "EAA" — that is the Meta App Secret, not an access token. The App Secret can only verify webhook signatures; it cannot send messages or read templates. Use the System User token instead.`
  return `WHATSAPP_TOKEN is ${status.tokenLength} characters and does not start with "EAA", so it is not a WhatsApp access token. Paste the System User token (Business Settings → System Users → Generate token). Temporary tokens also start with "EAA" but expire within 24 hours.`
}

export function getWhatsAppDisplayNumber(): string {
  return process.env.WHATSAPP_DISPLAY_NUMBER || ''
}

/**
 * Language code used when a nudge does not specify one.
 *
 * Meta matches templates by name AND language exactly: a template approved as `en_US`
 * will not send when the request asks for `en`, and the failure is
 * 132001 "template name does not exist in the translation", which reads like the
 * template is missing. Defaulting to this account's actual locale avoids that.
 */
export function getDefaultTemplateLanguage(): string {
  return (process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'en_US').trim() || 'en_US'
}

/** Normalize a raw phone to Meta's expected format: digits only with country code. */
export function normalizePhone(raw?: string | null): string | null {
  if (!raw) return null
  let digits = String(raw).replace(/\D/g, '')
  if (!digits) return null
  digits = digits.replace(/^0+/, '') // strip leading trunk zeros
  const cc = process.env.WHATSAPP_DEFAULT_CC || '91'
  // 10-digit local number (e.g. 9599722251) -> assume default country code
  if (digits.length === 10) digits = cc + digits
  if (digits.length < 11 || digits.length > 15) return null
  return digits
}

export interface WhatsAppSendResult {
  ok: boolean
  waMessageId?: string
  error?: string
}

const NOT_CONFIGURED =
  'WhatsApp not configured — set WHATSAPP_TOKEN (a System User token starting with "EAA") and WHATSAPP_PHONE_NUMBER_ID (the numeric Phone Number ID from WhatsApp Manager, NOT the phone number itself).'

/** Shared POST to /{phone_number_id}/messages. */
async function postMessage(payload: Record<string, unknown>): Promise<WhatsAppSendResult> {
  if (!isWhatsAppConfigured()) return { ok: false, error: NOT_CONFIGURED }

  try {
    const res = await fetch(`${GRAPH_BASE()}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
    const data = (await res.json().catch(() => ({}))) as {
      messages?: { id?: string }[]
      error?: { message?: string; code?: number; error_subcode?: number; type?: string }
    }
    if (!res.ok) {
      const detail = data?.error
      const suffix = detail?.code ? ` (code ${detail.code}${detail.error_subcode ? `/${detail.error_subcode}` : ''})` : ''
      return { ok: false, error: `WhatsApp API: ${detail?.message || `HTTP ${res.status}`}${suffix}` }
    }
    return { ok: true, waMessageId: data.messages?.[0]?.id }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Send an approved template message. params[] map positionally to {{1}}, {{2}}, ... */
export async function sendWhatsAppTemplate(opts: {
  to: string
  templateName: string
  language?: string
  params: string[]
  /**
   * Values for the template's URL button variable. Meta sends these as a separate
   * `button` component, so the button's {{1}} is INDEPENDENT of the body's {{1}}.
   */
  buttonParams?: string[]
}): Promise<WhatsAppSendResult> {
  const payload: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: opts.to,
    type: 'template',
    template: {
      name: opts.templateName,
      language: { code: opts.language || 'en' },
    },
  }

  const components: Record<string, unknown>[] = []
  if (opts.params.length > 0) {
    components.push({
      type: 'body',
      parameters: opts.params.map((text) => ({ type: 'text', text: String(text) })),
    })
  }
  if (opts.buttonParams?.length) {
    components.push({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: opts.buttonParams.map((text) => ({ type: 'text', text: String(text) })),
    })
  }
  if (components.length) {
    ;(payload.template as Record<string, unknown>).components = components
  }
  return postMessage(payload)
}

/**
 * Send a plain text message.
 * Meta only allows free-form text inside the 24-hour customer service window (i.e. the
 * recipient messaged you first) or to a registered test number. Outside that window this
 * returns an error and you must use an approved template instead.
 */
export async function sendWhatsAppText(opts: { to: string; text: string }): Promise<WhatsAppSendResult> {
  return postMessage({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: opts.to,
    type: 'text',
    text: { preview_url: false, body: opts.text },
  })
}

// ---------------------------------------------------------------------------
// Webhook signature verification (X-Hub-Signature-256, HMAC-SHA256 with the App Secret)
// ---------------------------------------------------------------------------

export function isWhatsAppSignatureVerificationConfigured(): boolean {
  return Boolean(process.env.WHATSAPP_APP_SECRET)
}

/**
 * Verify Meta's `X-Hub-Signature-256` header against the raw request body.
 * Returns true when no App Secret is configured, so an unconfigured deployment keeps
 * working — but configure WHATSAPP_APP_SECRET in production, otherwise anyone who knows
 * the URL can forge webhook events.
 */
export function verifyWhatsAppSignature(rawBody: string, signatureHeader: string | null | undefined): boolean {
  const secret = process.env.WHATSAPP_APP_SECRET
  if (!secret) return true
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false

  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')
  const provided = signatureHeader.slice('sha256='.length).trim()
  if (!/^[0-9a-f]+$/i.test(provided)) return false

  const a = Buffer.from(expected, 'hex')
  const b = Buffer.from(provided, 'hex')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Update a WhatsApp MessageLog from a Meta webhook status event.
 * read -> opened (first-read timestamp kept), failed -> sendError, replied never downgraded.
 */
export async function applyWhatsAppStatus(
  messageId: string,
  status: string,
  errors?: { code?: number; title?: string; message?: string }[]
) {
  const log = await db.messageLog.findFirst({ where: { channel: 'whatsapp', messageId } })
  if (!log) return false

  if (status === 'failed') {
    // Meta often repeats the same text in title and message; keep one copy and the code,
    // so the UI can explain it instead of showing "Message undeliverable Message undeliverable".
    const e = errors?.[0]
    const parts = [e?.title, e?.message].filter(Boolean) as string[]
    const unique = [...new Set(parts.map((p) => p.trim()))]
    let detail = unique.join(' — ') || 'delivery failed'
    if (e?.code) detail = `${detail} (code ${e.code})`
    await db.messageLog.update({ where: { id: log.id }, data: { sentOk: false, sendError: detail } })
    return true
  }

  if (status === 'read') {
    await db.messageLog.update({
      where: { id: log.id },
      data: {
        opened: true,
        openedAt: log.openedAt ?? new Date(),
        opensCount: { increment: 1 },
        engagementStatus: log.replied ? 'replied' : 'opened',
      },
    })
    return true
  }

  if (status === 'sent' || status === 'delivered') {
    if (!log.sentOk) {
      await db.messageLog.update({ where: { id: log.id }, data: { sentOk: true, sentAt: log.sentAt ?? new Date() } })
    }
    return true
  }

  return true
}

/** An inbound WhatsApp message, reduced to what we store. */
export type { InboundMessage, RawInboundMessage } from '@/lib/whatsapp-inbound'
export { extractInboundText } from '@/lib/whatsapp-inbound'

/**
 * Mark replied when a lead messages us back on WhatsApp, and STORE WHAT THEY SAID.
 *
 * Previously this only flipped `replied`, so the reply content was lost — the operator could
 * see that somebody replied but not what they wrote. The most recent message is kept in
 * `inboundText` and a capped history in `inboundMessages`.
 */
export async function applyWhatsAppInbound(fromPhone: string, message?: InboundMessage) {
  const log = await db.messageLog.findFirst({
    where: { channel: 'whatsapp', toPhone: fromPhone },
    orderBy: { createdAt: 'desc' },
  })
  if (!log) return false

  const at = message?.timestamp ? new Date(message.timestamp * 1000) : new Date()
  const stored = message?.text ? appendInbound(log.inboundMessages, { ...message, timestamp: message.timestamp }) : null

  await db.messageLog.update({
    where: { id: log.id },
    data: {
      replied: true,
      repliedAt: log.repliedAt ?? at,
      engagementStatus: 'replied',
      inboundAt: at,
      ...(stored ? { inboundText: stored.text, inboundMessages: stored.messages } : {}),
    },
  })
  return true
}
