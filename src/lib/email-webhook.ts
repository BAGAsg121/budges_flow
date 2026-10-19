/**
 * Email transport #3: hand the finished message to an n8n webhook.
 *
 * WHY: the Zoho Mail API for this mailbox answers `550 5.4.6 Unusual sending activity detected`, so
 * the mailbox cannot send and SMTP is not configured. n8n sends it instead — through a *different*
 * provider (Gmail), which is the part that actually fixes the problem: changing the transport only
 * helps if the sender identity or the infrastructure changes with it.
 *
 * WHAT THE APP STILL OWNS. Everything except the actual delivery:
 *   • the HTML, including the open-tracking pixel (`/api/track/open/<tracking_id>`);
 *   • the per-message tracking id, which also lands in the CRM note;
 *   • the sequence decision, the dedupe, the log row.
 * n8n is a pipe. That is deliberate: if n8n rendered the body from a template, the pixel would never
 * be inserted and open tracking would silently stop working.
 *
 * THE MISCONFIGURATION THIS GUARDS AGAINST. n8n's default webhook response is
 * `{"message":"Workflow was started"}`, returned IMMEDIATELY, before the email node runs — and a
 * Webhook node with `responseMode: onReceived` ignores a Respond-to-Webhook node entirely. An app
 * that treats HTTP 200 as success would then mark messages sent (and write "email sent" notes into
 * the CRM) for mail that never left. So a 200 carrying n8n's placeholder is treated as a FAILURE
 * with an explanatory error, never as success.
 */
import type { SendResult } from './mailer.ts'

/** Where the n8n webhook lives. Absent means this transport is available but not chosen. */
export function emailWebhookUrl(): string {
  return (process.env.EMAIL_WEBHOOK_URL || '').trim()
}

export function isEmailWebhookConfigured(): boolean {
  return emailWebhookUrl().length > 0
}

/**
 * n8n's stock reply when no Respond-to-Webhook node actually produced the response.
 *
 * Matching it is the difference between "sent" and "the workflow started and we have no idea".
 */
const N8N_PLACEHOLDER = /workflow was started/i

/** Field names we accept for the provider's message id, in priority order. */
function pickMessageId(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  for (const key of ['message_id', 'messageId', 'id']) {
    const v = b[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  // n8n's Gmail node nests the API response under `json` when it is echoed back as-is.
  const nested = b.json
  if (nested && typeof nested === 'object') return pickMessageId(nested)
  return null
}

/**
 * Turn an HTTP response from the webhook into a SendResult. Pure — no network, no env.
 *
 * Rules, each chosen so a broken flow cannot masquerade as a delivered email:
 *   • non-2xx                          → failed, with the body text as the reason;
 *   • 2xx but n8n's placeholder        → failed, "the webhook did not return a result";
 *   • 2xx with `ok: false`             → failed, with its `error`;
 *   • 2xx with a message id            → sent;
 *   • 2xx with neither                 → sent, but with an unknown id (the flow replied with
 *                                        something we do not recognise — logged so it is visible).
 */
export function interpretWebhookResponse(status: number, bodyText: string): SendResult {
  const text = (bodyText || '').trim()

  if (status < 200 || status >= 300) {
    return {
      ok: false,
      error: `email webhook HTTP ${status}${text ? `: ${text.slice(0, 300)}` : ''}`,
      transport: 'webhook',
    }
  }

  let parsed: unknown = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    // Not JSON — fall through and decide on the raw text.
  }

  const rec = (parsed ?? {}) as Record<string, unknown>

  if (rec.ok === false) {
    const err = typeof rec.error === 'string' && rec.error.trim() ? rec.error.trim() : 'the webhook reported a failure'
    return { ok: false, error: err, transport: 'webhook' }
  }

  const messageId = pickMessageId(parsed)
  if (messageId) return { ok: true, messageId, transport: 'webhook' }

  // 200 with no id: either the flow's Respond node is misconfigured, or it answered with something
  // that carries no evidence of a send. Both must NOT be recorded as delivered — but they are
  // different faults, so they get different messages; telling someone to "fix the Respond mode"
  // when the body is merely EMPTY sends them to the wrong setting.
  if (!text) {
    return {
      ok: false,
      error:
        'email webhook replied 200 with an EMPTY body — the Respond to Webhook node returned no result. ' +
        'Easiest fix in n8n: set that node\'s "Respond With" to "First Incoming Item", so the Gmail ' +
        'node\'s own output (which contains the message id) is passed straight back.',
      transport: 'webhook',
    }
  }
  if (N8N_PLACEHOLDER.test(text)) {
    return {
      ok: false,
      error:
        'email webhook returned n8n\'s placeholder ("Workflow was started") instead of a send result — ' +
        'set the Webhook node\'s Respond mode to "Using Respond to Webhook Node" and give the Respond ' +
        'node a JSON body containing the message id.',
      transport: 'webhook',
    }
  }

  return {
    ok: false,
    error: `email webhook replied without a message id: ${text.slice(0, 300)}`,
    transport: 'webhook',
  }
}

/**
 * POST the finished message to n8n.
 *
 * The payload is FLAT (`to_email`, not `to.email`) so the n8n expressions are a single token —
 * `{{ $json.body.to_email }}` — rather than a nested path that is easy to mistype in the UI.
 */
export async function sendViaEmailWebhook(opts: {
  to: string
  subject: string
  html: string
  text?: string
  /** The per-message id we already generated; also embedded in the open-tracking pixel. */
  trackingId?: string | null
  leadId?: string | null
  nudgeKey?: string | null
  nudgeName?: string | null
  messageNumber?: number | null
}): Promise<SendResult> {
  const url = emailWebhookUrl()
  if (!url) return { ok: false, error: 'EMAIL_WEBHOOK_URL is not set', transport: 'webhook' }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  // Shared secret: without it, anyone who learns the URL can send mail as us.
  const secret = (process.env.EMAIL_WEBHOOK_SECRET || '').trim()
  if (secret) headers['x-nudge-secret'] = secret

  const payload = {
    tracking_id: opts.trackingId ?? null,
    lead_id: opts.leadId ?? null,
    nudge_key: opts.nudgeKey ?? null,
    nudge_name: opts.nudgeName ?? null,
    message_number: opts.messageNumber ?? 1,
    to_email: opts.to,
    subject: opts.subject,
    html: opts.html,
    text: opts.text ?? '',
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      // Generous: n8n runs the send synchronously before responding, so this tracks the send time.
      signal: AbortSignal.timeout(60_000),
    })
    const body = await res.text()
    return interpretWebhookResponse(res.status, body)
  } catch (err) {
    return {
      ok: false,
      error: `email webhook unreachable: ${err instanceof Error ? err.message : String(err)}`,
      transport: 'webhook',
    }
  }
}
