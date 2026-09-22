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

const GRAPH_BASE = () => `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION || 'v21.0'}`

export function isWhatsAppConfigured(): boolean {
  return Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID)
}

export function getWhatsAppDisplayNumber(): string {
  return process.env.WHATSAPP_DISPLAY_NUMBER || ''
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

/** Send an approved template message. params[] map positionally to {{1}}, {{2}}, ... */
export async function sendWhatsAppTemplate(opts: {
  to: string
  templateName: string
  language?: string
  params: string[]
}): Promise<WhatsAppSendResult> {
  if (!isWhatsAppConfigured()) {
    return {
      ok: false,
      error:
        'WhatsApp not configured (set WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID in .env; template must be approved in Meta)',
    }
  }

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
  if (opts.params.length > 0) {
    ;(payload.template as Record<string, unknown>).components = [
      {
        type: 'body',
        parameters: opts.params.map((text) => ({ type: 'text', text: String(text) })),
      },
    ]
  }

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
      error?: { message?: string }
    }
    if (!res.ok) {
      return { ok: false, error: `WhatsApp API: ${data?.error?.message || `HTTP ${res.status}`}` }
    }
    return { ok: true, waMessageId: data.messages?.[0]?.id }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Update a WhatsApp MessageLog from a Meta webhook status event.
 * read -> opened (first-read timestamp kept), failed -> sendError, replied never downgraded.
 */
export async function applyWhatsAppStatus(messageId: string, status: string, errors?: { title?: string; message?: string }[]) {
  const log = await db.messageLog.findFirst({ where: { channel: 'whatsapp', messageId } })
  if (!log) return false

  if (status === 'failed') {
    const detail = errors?.[0] ? `${errors[0].title || ''} ${errors[0].message || ''}`.trim() : 'delivery failed'
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

/** Mark replied when a lead messages us back on WhatsApp. */
export async function applyWhatsAppInbound(fromPhone: string) {
  const log = await db.messageLog.findFirst({
    where: { channel: 'whatsapp', toPhone: fromPhone },
    orderBy: { createdAt: 'desc' },
  })
  if (!log) return false
  await db.messageLog.update({
    where: { id: log.id },
    data: { replied: true, repliedAt: new Date(), engagementStatus: 'replied' },
  })
  return true
}
