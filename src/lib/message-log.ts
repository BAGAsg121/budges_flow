/**
 * Write a message-log row, and never throw.
 *
 * WHY THIS EXISTS — a log write must not be able to abort a send run.
 *
 * The send happens BEFORE the log row is written, and it has to: the row records the provider's
 * message id, which does not exist until the send returns. So by the time this runs the recipient
 * already has the message. Throwing here does not undo the send — it kills the loop, so the
 * remaining recipients are never attempted, and the ones already messaged are forgotten.
 *
 * That is exactly what happened with `INSERT command denied`: one message delivered, the whole run
 * reported as failed, and the next run free to message the same people again because nothing
 * recorded that they had been contacted.
 *
 * Losing the row is still serious — it breaks the dashboard, open/click/reply attribution, the
 * failed-log retry, and the sequence's duplicate protection. So callers must COUNT the failure and
 * surface it in the run summary. Swallowing it silently would be worse than throwing.
 *
 * The error-wording helpers live in src/lib/db-error-text.ts (dependency-free) so the verification
 * suite can assert them without importing Prisma.
 */
import { db } from '@/lib/db'
import { describeLogError } from './db-error-text.ts'

export { describeLogError, logFailureWarning } from './db-error-text.ts'

export interface LogOutcome {
  ok: boolean
  id?: string
  /** Present when the row was not written — short, operator-readable. */
  error?: string
}

/** The minimum a caller supplies; the rest defaults live in the schema. */
export interface LogMessageInput {
  nudgeId: string
  channel: string
  messageNumber: number
  trackingId: string
  leadId?: string | null
  toEmail?: string | null
  toPhone?: string | null
  subject?: string | null
  templateName?: string | null
  messageId?: string | null
  ctaUrl?: string | null
  sheetRowRef?: string | null
  sentOk: boolean
  sendError?: string | null
  sentAt?: Date | null
}

export async function logMessageSafely(data: LogMessageInput): Promise<LogOutcome> {
  try {
    const created = await db.messageLog.create({
      data: {
        leadId: data.leadId ?? null,
        nudgeId: data.nudgeId,
        channel: data.channel,
        messageNumber: data.messageNumber,
        toEmail: data.toEmail ?? null,
        toPhone: data.toPhone ?? null,
        subject: data.subject ?? null,
        templateName: data.templateName ?? null,
        messageId: data.messageId ?? null,
        trackingId: data.trackingId,
        ctaUrl: data.ctaUrl ?? null,
        sheetRowRef: data.sheetRowRef ?? null,
        sentOk: data.sentOk,
        sendError: data.sendError ?? null,
        sentAt: data.sentAt ?? null,
        engagementStatus: 'sent',
      },
      select: { id: true },
    })
    return { ok: true, id: created.id }
  } catch (err) {
    const message = describeLogError(err)
    // Logged once per occurrence, so it is visible in the server logs even if the summary is missed.
    console.error('[message-log] could not record a send that ALREADY happened:', message)
    return { ok: false, error: message }
  }
}
