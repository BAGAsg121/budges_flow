/**
 * Write a "this email was sent" note onto the Zoho CRM lead.
 *
 * WHY: email is being moved off our SMTP/Zoho-Mail transport onto an n8n webhook, and the CRM is the
 * place a salesperson actually looks. The note is the record that a nudge reached a lead — what was
 * sent, to which address, and the tracking id that ties it to the open/click data in our own log.
 *
 * REST, not MCP. The MCP server we read leads through exposes only `get*` tools, so it cannot write
 * anything; this uses the CRM v8 REST API with the Zoho CRM OAuth credential
 * (ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET / ZOHO_REFRESH_TOKEN). Those must be granted a WRITE scope —
 * a read-only token fails with OAUTHLIB_SCOPE_MISMATCH / 401.
 *
 * A note is evidence, never a precondition. Every function here swallows failure and reports it,
 * because a CRM hiccup must not make an email that already went out look like it did not.
 */
import { getAccessToken } from './zoho.ts'

export interface EmailNoteInput {
  /** Zoho CRM lead id. Without one there is nothing to attach a note to. */
  leadId: string
  nudgeName?: string | null
  nudgeKey?: string | null
  messageNumber?: number | null
  to: string
  subject: string
  /** Our per-message id: ties this note to the open-tracking pixel and the CTA click. */
  trackingId?: string | null
  /** Defaults to now. Injectable so the note text can be asserted. */
  at?: Date
}

export const NOTE_TITLE = 'Nudge Engine — email sent'

/** The CRM's timezone — notes must read in the operator's time, not UTC. */
// 5h30m in milliseconds: (5*60+30) MINUTES, so ×60×1000. Writing ×60×60×1000 makes this 330 HOURS.
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000

/** `yyyy-mm-dd HH:MM` in IST. */
export function istStamp(d: Date): string {
  const shifted = new Date(d.getTime() + IST_OFFSET_MS)
  return `${shifted.toISOString().slice(0, 10)} ${shifted.toISOString().slice(11, 16)}`
}

/**
 * The note body, kept to plain lines.
 *
 * Deliberately no HTML: a note is read in the CRM's activity feed, and markup there renders as
 * literal characters more often than not. One fact per line also makes it greppable.
 */
export function buildEmailNote(input: EmailNoteInput): { title: string; content: string } {
  const at = input.at ?? new Date()
  const who = input.nudgeName || input.nudgeKey || 'Nudge'
  const key = input.nudgeKey && input.nudgeName ? ` (${input.nudgeKey})` : ''
  const lines = [
    `Nudge: ${who}${key}`,
    `Message: #${input.messageNumber ?? 1}`,
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    `Tracking: ${input.trackingId || '—'}`,
    `Sent: ${istStamp(at)} IST`,
  ]
  return { title: NOTE_TITLE, content: lines.join('\n') }
}

/** Notes are on unless explicitly disabled. */
export function isLeadNoteEnabled(): boolean {
  return (process.env.ZOHO_NOTE_ENABLED ?? 'true') !== 'false'
}

function apiBase(): string {
  return (process.env.ZOHO_API_BASE || 'https://www.zohoapis.in/crm/v8').replace(/\/+$/, '')
}

export interface NoteResult {
  ok: boolean
  noteId?: string
  /** Present on failure — reported, never thrown. */
  error?: string
}

/**
 * Create the note. Returns `ok: false` rather than throwing, always.
 *
 * `Note_Title` + `Note_Content` on the lead's Notes sub-resource is the documented shape for
 * "a note attached to this record"; the id comes back under data[0].details.id.
 */
export async function addLeadNote(input: EmailNoteInput): Promise<NoteResult> {
  if (!input.leadId) return { ok: false, error: 'no lead id' }
  if (!isLeadNoteEnabled()) return { ok: false, error: 'disabled (ZOHO_NOTE_ENABLED=false)' }

  let token: string
  try {
    token = await getAccessToken()
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }

  const note = buildEmailNote(input)
  try {
    const res = await fetch(`${apiBase()}/Leads/${encodeURIComponent(input.leadId)}/Notes`, {
      method: 'POST',
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ data: [{ Note_Title: note.title, Note_Content: note.content }] }),
      // Bounded: a slow CRM must not hold up a send loop. The note is fire-and-report.
      signal: AbortSignal.timeout(10_000),
    })
    const data = (await res.json().catch(() => ({}))) as {
      data?: { code?: string; details?: { id?: string }; message?: string }[]
    }
    const row = data?.data?.[0]
    if (res.ok && row?.code === 'SUCCESS') {
      return { ok: true, noteId: row.details?.id }
    }
    return {
      ok: false,
      error: `${row?.code || `HTTP ${res.status}`}${row?.message ? `: ${row.message}` : ''}`,
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
