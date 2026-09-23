/**
 * Inbound email reply tracking.
 *
 * Email has no free delivery webhook like WhatsApp, so replies are detected two ways:
 *  1. IMAP polling (`IMAP_ENABLED=true`) — the scheduler scans the mailbox for messages
 *     whose In-Reply-To/References point at one of our sent message-ids.
 *  2. An inbound webhook (POST /api/track/email) for whatever forwarding rule or mail
 *     provider hook you wire up.
 *
 * A lead marked `replied` stops its follow-up sequence (see decideSend).
 */
import { db } from '@/lib/db'

export function isImapConfigured(): boolean {
  return (
    process.env.IMAP_ENABLED === 'true' &&
    Boolean(process.env.IMAP_HOST && process.env.IMAP_USER && process.env.IMAP_PASS)
  )
}

/** Strip angle brackets/whitespace so ids from different sources compare equal. */
function normalizeMessageId(raw?: string | null): string {
  return String(raw || '')
    .trim()
    .replace(/^<+/, '')
    .replace(/>+$/, '')
    .toLowerCase()
}

function extractIds(...values: (string | undefined | null)[]): string[] {
  const out = new Set<string>()
  for (const v of values) {
    if (!v) continue
    for (const part of String(v).split(/[\s,]+/)) {
      const id = normalizeMessageId(part)
      if (id) out.add(id)
    }
  }
  return [...out]
}

export interface ReplyTarget {
  fromEmail?: string | null
  inReplyTo?: string | null
  references?: string | string[] | null
}

/** Locate the outbound email log a reply belongs to. */
export async function findReplyTarget(target: ReplyTarget) {
  const refs = Array.isArray(target.references) ? target.references.join(' ') : target.references
  const refIds = extractIds(target.inReplyTo, refs)

  if (refIds.length) {
    const byReference = await db.messageLog.findFirst({
      where: { channel: 'email', messageId: { in: refIds } },
      orderBy: { createdAt: 'desc' },
    })
    if (byReference) return byReference
  }

  const from = String(target.fromEmail || '').trim().toLowerCase()
  if (from) {
    const byAddress = await db.messageLog.findFirst({
      where: { channel: 'email', toEmail: from },
      orderBy: { createdAt: 'desc' },
    })
    if (byAddress) return byAddress
  }

  return null
}

/** Mark one log as replied. Returns false when it was already replied / not found. */
export async function markReplied(logId: string, repliedAt: Date = new Date()): Promise<boolean> {
  const log = await db.messageLog.findUnique({ where: { id: logId } })
  if (!log || log.replied) return false
  await db.messageLog.update({
    where: { id: logId },
    data: { replied: true, repliedAt, engagementStatus: 'replied' },
  })
  return true
}

/** Handle a single reply event (webhook or IMAP). Returns true when newly marked. */
export async function recordReply(target: ReplyTarget, repliedAt: Date = new Date()): Promise<boolean> {
  const log = await findReplyTarget(target)
  if (!log) return false
  return markReplied(log.id, repliedAt)
}

export interface ImapSyncResult {
  configured: boolean
  scanned: number
  matched: number
  error?: string
}

function parseHeaders(raw: Buffer | string | undefined): { inReplyTo?: string; references?: string } {
  if (!raw) return {}
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)
  const out: { inReplyTo?: string; references?: string } = {}
  // unfold continuation lines, then pick the two headers we care about
  const unfolded = text.replace(/\r?\n[ \t]+/g, ' ')
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx < 0) continue
    const key = line.slice(0, idx).trim().toLowerCase()
    const value = line.slice(idx + 1).trim()
    if (key === 'in-reply-to') out.inReplyTo = value
    else if (key === 'references') out.references = value
  }
  return out
}

/**
 * Poll the configured mailbox and mark matching logs as replied.
 * Never throws — returns an `error` string instead so callers can log and continue.
 */
export async function syncRepliesFromImap(): Promise<ImapSyncResult> {
  if (!isImapConfigured()) return { configured: false, scanned: 0, matched: 0 }

  const lookbackDays = Math.max(1, Number(process.env.IMAP_REPLY_LOOKBACK_DAYS || 7))
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000)

  try {
    const { ImapFlow } = await import('imapflow')
    const client = new ImapFlow({
      host: process.env.IMAP_HOST as string,
      port: Number(process.env.IMAP_PORT || 993),
      secure: (process.env.IMAP_SECURE || 'true') !== 'false',
      auth: {
        user: process.env.IMAP_USER as string,
        pass: process.env.IMAP_PASS as string,
      },
      logger: false,
    })

    await client.connect()
    let scanned = 0
    let matched = 0
    const lock = await client.getMailboxLock(process.env.IMAP_MAILBOX || 'INBOX')

    try {
      for await (const msg of client.fetch({ since }, { envelope: true, headers: true })) {
        scanned++
        const headers = parseHeaders(msg.headers)
        const ok = await recordReply(
          {
            fromEmail: msg.envelope?.from?.[0]?.address ?? null,
            inReplyTo: headers.inReplyTo ?? null,
            references: headers.references ?? null,
          },
          msg.envelope?.date instanceof Date ? msg.envelope.date : new Date()
        )
        if (ok) matched++
      }
    } finally {
      lock.release()
    }

    await client.logout().catch(() => undefined)
    return { configured: true, scanned, matched }
  } catch (err) {
    return {
      configured: true,
      scanned: 0,
      matched: 0,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
