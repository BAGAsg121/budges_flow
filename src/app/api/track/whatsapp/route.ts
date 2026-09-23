/**
 * Meta WhatsApp webhook: /api/track/whatsapp
 * GET  -> subscription verification handshake (hub.mode / hub.verify_token / hub.challenge).
 *         Configure this URL + the same WHATSAPP_VERIFY_TOKEN in the Meta App dashboard.
 * POST -> delivery statuses (sent/delivered/read/failed) and inbound messages.
 *         read    -> MessageLog.opened (first-read timestamp kept, engagement 'opened')
 *         failed  -> MessageLog.sendError
 *         inbound -> latest message from that lead marked replied (engagement 'replied')
 */
import { NextRequest, NextResponse } from 'next/server'
import {
  applyWhatsAppStatus,
  applyWhatsAppInbound,
  extractInboundText,
  verifyWhatsAppSignature,
} from '@/lib/whatsapp'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const mode = req.nextUrl.searchParams.get('hub.mode')
  const token = req.nextUrl.searchParams.get('hub.verify_token')
  const challenge = req.nextUrl.searchParams.get('hub.challenge')

  if (mode === 'subscribe' && token && token === (process.env.WHATSAPP_VERIFY_TOKEN || '')) {
    return new NextResponse(challenge, { status: 200 })
  }
  return new NextResponse('Forbidden', { status: 403 })
}

interface WebhookBody {
  entry?: {
    changes?: {
      value?: {
        statuses?: {
          id: string
          status: string
          recipient_id?: string
          errors?: { code?: number; title?: string; message?: string }[]
        }[]
        messages?: {
          from: string
          id: string
          type?: string
          timestamp?: string
          text?: { body?: string }
          button?: { text?: string; payload?: string }
          interactive?: {
            type?: string
            button_reply?: { title?: string; id?: string }
            list_reply?: { title?: string; description?: string; id?: string }
          }
          image?: { caption?: string }
          video?: { caption?: string }
          document?: { filename?: string; caption?: string }
          audio?: unknown
          sticker?: unknown
          location?: { name?: string; address?: string; latitude?: number; longitude?: number }
          contacts?: unknown
          order?: unknown
          system?: { body?: string }
        }[]
      }
    }[]
  }[]
}

export async function POST(req: NextRequest) {
  try {
    // Verify Meta's HMAC signature over the RAW body before trusting anything in it.
    // Skipped only when WHATSAPP_APP_SECRET is unset.
    const raw = await req.text()
    if (!verifyWhatsAppSignature(raw, req.headers.get('x-hub-signature-256'))) {
      return new NextResponse('Invalid signature', { status: 403 })
    }

    const body = JSON.parse(raw || '{}') as WebhookBody

    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value
        if (!value) continue

        for (const st of value.statuses ?? []) {
          if (st?.id && st?.status) {
            await applyWhatsAppStatus(st.id, st.status, st.errors).catch(() => null)
          }
        }

        for (const msg of value.messages ?? []) {
          if (msg?.from) {
            // Store what they actually wrote, not just that they wrote.
            await applyWhatsAppInbound(msg.from, {
              text: extractInboundText(msg),
              type: msg.type,
              timestamp: msg.timestamp ? Number(msg.timestamp) : undefined,
            }).catch(() => null)
          }
        }
      }
    }
  } catch {
    // never error back to Meta or it keeps retrying
  }
  return NextResponse.json({ ok: true })
}
