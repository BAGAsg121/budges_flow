/**
 * SMTP mailer (nodemailer). Configure via .env:
 *   SMTP_HOST=smtp.zoho.in
 *   SMTP_PORT=465
 *   SMTP_SECURE=true
 *   SMTP_USER=you@domain.com
 *   SMTP_PASS=...
 *   MAIL_FROM="Eko EPS <noreply@domain.com>"
 */
import nodemailer from 'nodemailer'

export interface SendResult {
  ok: boolean
  messageId?: string
  error?: string
}

export function isMailerConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.MAIL_FROM)
}

let transporter: ReturnType<typeof nodemailer.createTransport> | null = null

function getTransporter() {
  if (!isMailerConfigured()) return null
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

export async function sendEmail(opts: { to: string; subject: string; html: string; text?: string }): Promise<SendResult> {
  const tx = getTransporter()
  if (!tx) {
    return { ok: false, error: 'SMTP not configured (set SMTP_HOST/SMTP_USER/SMTP_PASS/MAIL_FROM in .env)' }
  }
  try {
    const info = await tx.sendMail({
      from: process.env.MAIL_FROM,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
    })
    return { ok: true, messageId: info.messageId }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
