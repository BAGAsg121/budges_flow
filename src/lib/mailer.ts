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

export interface SendResult {
  ok: boolean
  messageId?: string
  error?: string
  /** Which transport actually handled this message. */
  transport?: MailTransport
}

export type MailTransport = 'zoho' | 'smtp'

export function isSmtpConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.MAIL_FROM)
}

/**
 * Decide which transport to use.
 * Auto order: Zoho Mail first (a refresh-token flow, no mailbox password needed), then SMTP.
 */
export function selectMailTransport(): MailTransport | null {
  const forced = (process.env.MAIL_TRANSPORT || '').trim().toLowerCase()
  if (forced === 'zoho') return isZohoMailConfigured() ? 'zoho' : null
  if (forced === 'smtp') return isSmtpConfigured() ? 'smtp' : null
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
    error: transport
      ? null
      : 'No email transport is configured. Set the Zoho Mail credentials (ZOHO_MAIL_CLIENT_ID, ZOHO_MAIL_CLIENT_SECRET, ZOHO_MAIL_REFRESH_TOKEN, ZOHO_MAIL_ACCOUNT_ID, ZOHO_MAIL_FROM_ADDRESS) or SMTP_HOST/SMTP_USER/SMTP_PASS/MAIL_FROM.',
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

export async function sendEmail(opts: { to: string; subject: string; html: string; text?: string }): Promise<SendResult> {
  const transport = selectMailTransport()
  if (!transport) {
    return {
      ok: false,
      error: describeMailConfig().error as string,
    }
  }
  if (transport === 'zoho') {
    const result = await sendViaZohoMail(opts)
    return { ...result, transport: 'zoho' }
  }
  return sendViaSmtp(opts)
}
