/**
 * Email sending, with two interchangeable transports:
 *
 *   1. Zoho Mail REST API  — the credentials the original n8n flow used
 *                            (ZOHO_MAIL_CLIENT_ID / SECRET / REFRESH_TOKEN / ACCOUNT_ID)
 *   2. SMTP via nodemailer — SMTP_HOST / SMTP_USER / SMTP_PASS / MAIL_FROM
 *
 * The app originally supported only SMTP, so the Zoho Mail credentials sitting in .env were
 * never used and every email failed with "SMTP not configured". Auto-selection now prefers
 * Zoho Mail when it is configured, because that is the transport with working credentials.
 * Set MAIL_TRANSPORT=smtp or =zoho to force one.
 */
import nodemailer from 'nodemailer'
// Relative with an explicit extension (not "@/") so this module stays path-alias free and
// the CLI scripts can import the real sender.
import { isZohoMailConfigured, sendViaZohoMail, zohoMailStatus } from './zoho-mail.ts'
import { addLeadNote } from './zoho-notes.ts'
import { isEmailWebhookConfigured, sendViaEmailWebhook, emailWebhookUrl } from './email-webhook.ts'

export interface SendResult {
  ok: boolean
  messageId?: string
  error?: string
  /** Which transport actually handled this message. */
  transport?: MailTransport
  /**
   * Outcome of the "email sent" CRM note, when the caller supplied a lead.
   *
   * Reported rather than thrown: the email has already gone, and a CRM hiccup must never turn a
   * delivered message into a failed one.
   */
  note?: { ok: boolean; noteId?: string; error?: string }
}

/**
 * Who/what this email is about. Feeds BOTH the n8n webhook (so the flow can report back on the right
 * lead) and the CRM note.
 */
export interface EmailSendContext {
  leadId: string | null
  nudgeName?: string | null
  nudgeKey?: string | null
  messageNumber?: number | null
  trackingId?: string | null
}

export type MailTransport = 'zoho' | 'smtp' | 'webhook'

export function isSmtpConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.MAIL_FROM)
}

/**
 * Decide which transport to use.
 *
 * Auto order: **webhook first**, then Zoho Mail, then SMTP. The webhook leads because it is the only
 * one that can currently deliver at all — the Zoho Mail API for this mailbox answers
 * `550 5.4.6 Unusual sending activity`, and SMTP is not configured. Putting it last would mean a
 * working path never being reached while a broken one is tried first.
 *
 * Set MAIL_TRANSPORT=webhook|smtp|zoho to force one.
 */
export function selectMailTransport(): MailTransport | null {
  const forced = (process.env.MAIL_TRANSPORT || '').trim().toLowerCase()
  if (forced === 'webhook') return isEmailWebhookConfigured() ? 'webhook' : null
  if (forced === 'zoho') return isZohoMailConfigured() ? 'zoho' : null
  if (forced === 'smtp') return isSmtpConfigured() ? 'smtp' : null
  if (isEmailWebhookConfigured()) return 'webhook'
  if (isZohoMailConfigured()) return 'zoho'
  if (isSmtpConfigured()) return 'smtp'
  return null
}

export function isMailerConfigured(): boolean {
  return selectMailTransport() !== null
}

/** Why email is unavailable, in terms the operator can act on. */
export function describeMailConfig() {
  const transport = selectMailTransport()
  const zoho = zohoMailStatus()
  return {
    transport,
    zoho,
    smtp: {
      host: process.env.SMTP_HOST || null,
      port: process.env.SMTP_PORT || null,
      userPresent: Boolean(process.env.SMTP_USER),
      passPresent: Boolean(process.env.SMTP_PASS),
      from: process.env.MAIL_FROM || null,
    },
    forced: process.env.MAIL_TRANSPORT || 'auto',
    webhook: {
      configured: isEmailWebhookConfigured(),
      // Never print the URL's query/secret — only whether one is set and where it points.
      host: isEmailWebhookConfigured() ? new URL(emailWebhookUrl()).host : null,
      secretSet: Boolean((process.env.EMAIL_WEBHOOK_SECRET || '').trim()),
    },
    error: transport
      ? null
      : 'No email transport is configured. Set EMAIL_WEBHOOK_URL to send through n8n, or the Zoho Mail credentials (ZOHO_MAIL_CLIENT_ID, ZOHO_MAIL_CLIENT_SECRET, ZOHO_MAIL_REFRESH_TOKEN, ZOHO_MAIL_ACCOUNT_ID, ZOHO_MAIL_FROM_ADDRESS) / SMTP_HOST/SMTP_USER/SMTP_PASS/MAIL_FROM.',
  }
}

let transporter: ReturnType<typeof nodemailer.createTransport> | null = null

function getTransporter() {
  if (!isSmtpConfigured()) return null
  if (transporter) return transporter
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: (process.env.SMTP_SECURE || 'true') === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  })
  return transporter
}

async function sendViaSmtp(opts: { to: string; subject: string; html: string; text?: string }): Promise<SendResult> {
  const tx = getTransporter()
  if (!tx) return { ok: false, error: 'SMTP not configured', transport: 'smtp' }
  try {
    const info = await tx.sendMail({
      from: process.env.MAIL_FROM,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
    })
    return { ok: true, messageId: info.messageId, transport: 'smtp' }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), transport: 'smtp' }
  }
}

export async function sendEmail(opts: {
  to: string
  subject: string
  html: string
  text?: string
  /** Supplies the tracking id to the webhook and the lead to the CRM note. */
  context?: EmailSendContext
}): Promise<SendResult> {
  const transport = selectMailTransport()
  if (!transport) {
    return {
      ok: false,
      error: describeMailConfig().error as string,
    }
  }

  let result: SendResult
  if (transport === 'webhook') {
    result = await sendViaEmailWebhook({
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
      trackingId: opts.context?.trackingId,
      leadId: opts.context?.leadId,
      nudgeKey: opts.context?.nudgeKey,
      nudgeName: opts.context?.nudgeName,
      messageNumber: opts.context?.messageNumber,
    })
  } else if (transport === 'zoho') {
    const viaZoho = await sendViaZohoMail(opts)
    result = { ...viaZoho, transport: 'zoho' }
  } else {
    result = await sendViaSmtp(opts)
  }

  // Record it in the CRM — only for a message that actually went out, and only when we know which
  // lead it belongs to (a Google-Sheet send has no lead row, so it has nothing to attach to).
  //
  // Done HERE rather than at each call site so the manual sheet run, the failed-log retry and the
  // WhatsApp→email fallback all inherit it by construction. `addLeadNote` never throws, so this
  // cannot fail the send.
  if (result.ok && opts.context?.leadId) {
    result.note = await addLeadNote({
      leadId: opts.context.leadId,
      nudgeName: opts.context.nudgeName,
      nudgeKey: opts.context.nudgeKey,
      messageNumber: opts.context.messageNumber,
      trackingId: opts.context.trackingId,
      to: opts.to,
      subject: opts.subject,
    })
  }

  return result
}
