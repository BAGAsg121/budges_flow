/**
 * Run one SHEET-driven nudge: fetch the Google Sheet, render the nudge for every row, send, log.
 *
 * WHY THIS IS A LIB AND NOT THE ROUTE BODY: there are now two ways to trigger a sheet nudge — the
 * operator pasting a URL (POST /api/nudges/{id}/sheet-run) and the daily scheduler running the URL
 * stored on the nudge. Two implementations of "read a sheet and message its rows" is exactly how the
 * manual and the scheduled path start disagreeing about parameters, CTA tokens or the email
 * fallback, and the disagreement is invisible until someone reads a message. So the route is a thin
 * wrapper and this module is the only sender.
 *
 * WHAT IT DOES NOT DO: it does not consult message history. Every row is sent on every run; the only
 * de-duplication is WITHIN one run (an address repeated in the sheet is collapsed once). That is the
 * operator's chosen policy for the daily activation-fee reminders — the same partner is reminded
 * again the next day until they pay — and it is why this flow is safe to run on a timer while a
 * lead-driven nudge is not.
 *
 * NOTHING IS UPSERTED INTO THE LEAD TABLE: MessageLog rows are created with leadId=null and
 * sheetRowRef="<csvUrl>|<address>", because a sheet row is an address, not a CRM record.
 */
import { randomUUID } from 'crypto'
import { db } from '@/lib/db'
import { sendEmail, isMailerConfigured } from '@/lib/mailer'
import { renderTemplate, injectTrackingPixel, htmlToText } from '@/lib/template'
import { isWhatsAppConfigured, sendWhatsAppTemplate, normalizePhone, getDefaultTemplateLanguage } from '@/lib/whatsapp'
import { isDeliveryCapError, isPermanentDeliveryFailure } from '@/lib/whatsapp-errors'
import { buildWhatsAppParams, missingSheetColumns } from '@/lib/whatsapp-params'
import { getBaseUrl } from '@/lib/base-url'
import { parseSheetCsv, toSheetCsvUrl } from '@/lib/sheet-parser'
import { buildSheetVars, planSheetSends } from '@/lib/sheet-vars'
import { ctaSendParams } from '@/lib/cta'
import { logMessageSafely } from '@/lib/message-log'
import { logFailureWarning } from '@/lib/db-error-text'
import { resolveLeadByEmail } from '@/lib/lead-lookup'
import { ctaDestinationFor } from '@/lib/nudge-defaults'
import type { Nudge } from '@prisma/client'

export interface SheetRunSummary {
  nudgeKey: string
  channel: string
  source: 'sheet'
  sheetUrl: string
  rowsRead: number
  sent: number
  failed: number
  skipped: number
  /** Rows that WERE messaged but could not be recorded — see src/lib/message-log.ts. */
  logFailures: number
  logErrorSample?: string
  logWarning?: string
  /** CRM notes: written, failed, and skipped-because-no-lead. */
  notesWritten: number
  noteFailures: number
  noteErrorSample?: string
  notesSkipped: number
  fallbackEmails: { to: string; reason: string }[]
  sentEmails: string[]
  failedEntries: { email: string; error: string }[]
  skippedEntries: { lead: string; email: string | null; reason: string; detail?: string }[]
  smtpConfigured: boolean
  whatsappConfigured: boolean
}

/**
 * A refusal is a value, not a throw: the route maps `status` onto its HTTP response and the
 * scheduler records it as a per-nudge error, and neither should have to parse an exception.
 */
export type SheetRunOutcome =
  | { ok: true; summary: SheetRunSummary }
  | { ok: false; status: number; error: string; missingColumns?: string[] }

export interface SheetRunInput {
  nudge: Nudge
  sheetUrl: string
  /** Tab to read. Falls back to the gid in the URL, then to tab 0. */
  gid?: string
  /** Scheduler supplies a static base URL; the route lets it resolve per request. */
  baseUrl?: string
}

export async function runSheetNudge(input: SheetRunInput): Promise<SheetRunOutcome> {
  const { nudge } = input
  const rawUrl = input.sheetUrl.trim()
  if (!rawUrl) return { ok: false, status: 400, error: 'sheetUrl is required' }

  const isWhatsApp = nudge.channel === 'whatsapp'
  if (isWhatsApp) {
    if (!nudge.whatsappTemplateName?.trim()) {
      return { ok: false, status: 400, error: 'WhatsApp sheet-run needs an approved template name on the nudge' }
    }
    if (!isWhatsAppConfigured()) {
      return {
        ok: false,
        status: 400,
        error: 'WhatsApp is not configured (WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID)',
      }
    }
  } else if (!nudge.subjectTemplate || !nudge.bodyTemplate) {
    return { ok: false, status: 400, error: 'Nudge has no subject or body template' }
  }

  // 1. Fetch the sheet as CSV.
  let csvUrl: string
  try {
    csvUrl = toSheetCsvUrl(rawUrl, input.gid)
  } catch (err) {
    return { ok: false, status: 400, error: err instanceof Error ? err.message : String(err) }
  }

  let csvText: string
  try {
    const fetchRes = await fetch(csvUrl, { redirect: 'follow' })
    if (!fetchRes.ok) {
      return {
        ok: false,
        status: 400,
        error: `Could not fetch the sheet (HTTP ${fetchRes.status}). Make sure it is shared as "Anyone with the link can view".`,
      }
    }
    csvText = await fetchRes.text()
  } catch (err) {
    return {
      ok: false,
      status: 502,
      error: `Network error fetching sheet: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  // 2. Parse rows.
  const rows = parseSheetCsv(csvText)
  if (rows.length === 0) {
    return { ok: false, status: 400, error: 'Sheet has no data rows (or only a header row)' }
  }

  // 2b. WhatsApp only: the sheet must carry every column the template's body reads.
  //
  // The engine substitutes a fallback ("-") for a value it cannot find rather than shifting the
  // parameters, which is right for a partially-filled CRM lead but wrong here: a WHOLE COLUMN being
  // absent means every recipient gets a message with a literal "-" in the hole. Meta accepts it, so
  // nothing surfaces it later. Refuse the run instead and name the columns.
  if (isWhatsApp) {
    const missingColumns = missingSheetColumns(nudge.whatsappParams, Object.keys(rows[0] ?? {}))
    if (missingColumns.length) {
      return {
        ok: false,
        status: 400,
        error:
          `This WhatsApp nudge's template reads ${missingColumns.map((c) => `{{${c}}}`).join(', ')} ` +
          `from the sheet, but the sheet has no such column. Present columns: ` +
          `${Object.keys(rows[0] ?? {}).join(', ') || '(none)'}.`,
        missingColumns,
      }
    }
  }

  const baseUrl = input.baseUrl ?? (await getBaseUrl())
  const now = new Date()

  type SkipEntry = { lead: string; email: string | null; reason: string; detail?: string }
  const sent: string[] = []
  const failed: { email: string; error: string }[] = []
  const skipped: SkipEntry[] = []
  const fallbackEmails: { to: string; reason: string }[] = []

  /**
   * Rows whose message went out but whose log row could not be written.
   *
   * Never fatal: the recipient already has the message by the time the insert runs, so aborting here
   * would abandon the rest of the sheet AND forget the ones already messaged.
   */
  let logFailures = 0
  let logErrorSample: string | undefined
  /** Sent, but the CRM note write was rejected (usually the Zoho credential or its scope). */
  let noteFailures = 0
  let noteErrorSample: string | undefined
  /** Sent, but no lead matched the address — nothing to attach a note to. */
  let notesSkipped = 0

  // Optional email fallback: when WhatsApp cannot deliver (Meta's marketing cap, or the number is
  // unreachable), send the twin EMAIL nudge instead. Configured per nudge as
  // filters.emailFallback = "<nudge key>". A configuration error is never masked by this.
  let fallbackNudge: Awaited<ReturnType<typeof db.nudge.findUnique>> = null
  let fallbackFilters: { emailFallback?: string } = {}
  try {
    fallbackFilters = JSON.parse(nudge.filters || '{}') as { emailFallback?: string }
  } catch {
    fallbackFilters = {}
  }
  if (isWhatsApp && fallbackFilters.emailFallback) {
    fallbackNudge = await db.nudge.findUnique({ where: { key: fallbackFilters.emailFallback } })
    if (!fallbackNudge) {
      skipped.push({
        lead: '-',
        email: null,
        reason: 'email_fallback_missing',
        detail: `filters.emailFallback="${fallbackFilters.emailFallback}" does not match any nudge`,
      })
    }
  }

  // 3. Decide the recipients, then send.
  //
  // The plan comes from planSheetSends(), which never consults history: every row is sent even to
  // someone this nudge has messaged before, and the only de-duplication is within this upload.
  const plan = planSheetSends(rows, { isWhatsApp, normalisePhone: normalizePhone })
  for (const s of plan.skipped) {
    skipped.push({ lead: s.lead, email: s.email, reason: s.reason, detail: s.detail })
  }

  for (const planned of plan.toSend) {
    const { row, email, mobile } = planned
    const toPhone = isWhatsApp ? planned.address : null

    // Build template vars from row columns + synthetic fields. Shared with the retry path
    // (src/lib/sheet-vars.ts) so a retry cannot render a subtly different message.
    const vars = buildSheetVars(row, { email, mobile, now, messageNumber: 1 })

    const trackingId = randomUUID()
    const sheetRowRef = `${csvUrl}|${isWhatsApp ? toPhone : email}`

    if (isWhatsApp) {
      const waParams = buildWhatsAppParams(nudge.whatsappParams, vars)
      const { buttonParams, ctaUrl, fallback } = ctaSendParams({
        templateName: nudge.whatsappTemplateName,
        destination: ctaDestinationFor(nudge.whatsappTemplateName, String(vars.mobile_digits ?? '')),
        trackingId,
        mobileDigits: String(vars.mobile_digits ?? ''),
        configured: waParams.button,
      })
      const result = await sendWhatsAppTemplate({
        to: toPhone as string,
        templateName: nudge.whatsappTemplateName as string,
        language: nudge.whatsappLanguage || getDefaultTemplateLanguage(),
        params: waParams.body,
        buttonParams,
        fallback,
      })

      const logged = await logMessageSafely({
        leadId: null,
        nudgeId: nudge.id,
        channel: 'whatsapp',
        messageNumber: 1,
        toPhone,
        templateName: result.usedFallbackTemplate ?? nudge.whatsappTemplateName,
        messageId: result.waMessageId ?? null,
        trackingId,
        ctaUrl,
        sheetRowRef: sheetRowRef.slice(0, 512),
        sentOk: result.ok,
        sendError: result.error ?? null,
        sentAt: result.ok ? new Date() : null,
      })
      if (!logged.ok) {
        logFailures++
        logErrorSample ??= logged.error
      }

      if (result.ok) sent.push(toPhone as string)
      else {
        failed.push({ email: toPhone as string, error: result.error ?? 'unknown error' })

        // Fall back to email when WhatsApp is the wrong channel for this recipient — either Meta
        // capped them (retryable but slow) or the number cannot receive.
        const undeliverable = isDeliveryCapError(result.error) || isPermanentDeliveryFailure(result.error)
        if (undeliverable && fallbackNudge && email && fallbackNudge.subjectTemplate && fallbackNudge.bodyTemplate) {
          // Honour the EMAIL nudge's own "one successful send per recipient" rule. Without this, a
          // capped WhatsApp recipient would be emailed again on every daily run — the sheet makes the
          // run revisit them every day, the dedup makes it safe.
          const alreadyEmailed = await db.messageLog.findFirst({
            where: { nudgeId: fallbackNudge.id, toEmail: email, sentOk: true },
          })
          if (alreadyEmailed) {
            skipped.push({
              lead: email || mobile,
              email: email || null,
              reason: 'email_fallback',
              detail: 'already sent by the email nudge',
            })
          } else {
            const fbTrackingId = randomUUID()
            const fbSubject = renderTemplate(fallbackNudge.subjectTemplate, vars)
            const fbHtml = injectTrackingPixel(
              renderTemplate(fallbackNudge.bodyTemplate, vars, { escapeValues: true }),
              baseUrl,
              fbTrackingId
            )
            // Same lead resolution as the direct-email path: the fallback email is a real send to a
            // real address, so the CRM should record it too.
            const fbMatch = await resolveLeadByEmail(email)
            const fbContext =
              fbMatch.kind === 'matched'
                ? {
                    leadId: fbMatch.zohoId,
                    nudgeName: fallbackNudge.name,
                    nudgeKey: fallbackNudge.key,
                    messageNumber: 1,
                    trackingId: fbTrackingId,
                  }
                : undefined

            const fbResult = await sendEmail({
              to: email,
              subject: fbSubject,
              html: fbHtml,
              text: htmlToText(fbHtml),
              ...(fbContext ? { context: fbContext } : {}),
            })

            if (fbResult.note && !fbResult.note.ok) {
              noteFailures++
              noteErrorSample ??= fbResult.note.error
            } else if (fbResult.ok && !fbContext) {
              notesSkipped++
            }

            const fbLogged = await logMessageSafely({
              leadId: null,
              nudgeId: fallbackNudge.id,
              channel: 'email',
              messageNumber: 1,
              toEmail: email,
              subject: fbSubject,
              messageId: fbResult.messageId ?? null,
              trackingId: fbTrackingId,
              sheetRowRef: `fallback:${nudge.key}|${email}`.slice(0, 512),
              sentOk: fbResult.ok,
              sendError: fbResult.error ?? null,
              sentAt: fbResult.ok ? new Date() : null,
            })
            if (!fbLogged.ok) {
              logFailures++
              logErrorSample ??= fbLogged.error
            }

            if (fbResult.ok) {
              fallbackEmails.push({
                to: email,
                reason: isDeliveryCapError(result.error) ? 'whatsapp capped' : 'whatsapp undeliverable',
              })
            }
          }
        }
      }

      await new Promise((r) => setTimeout(r, 250))
      continue
    }

    const subject = renderTemplate(nudge.subjectTemplate as string, vars)
    const bodyHtml = injectTrackingPixel(
      renderTemplate(nudge.bodyTemplate as string, vars, { escapeValues: true }),
      baseUrl,
      trackingId
    )

    // A sheet row carries an email address, not a lead — so resolve the CRM record id from the
    // address, otherwise the note has nowhere to go and the send leaves no trace on the lead.
    // Ambiguous addresses (several leads share one) are refused rather than guessed at.
    const match = await resolveLeadByEmail(email)
    // NOT pushed to `skipped`: the message is still sent. Only the note is withheld, so it belongs in
    // the note counters — listing it as skipped would make the row look un-sent.
    const noteAmbiguous = match.kind === 'ambiguous'
    const noteContext =
      match.kind === 'matched'
        ? {
            leadId: match.zohoId,
            nudgeName: nudge.name,
            nudgeKey: nudge.key,
            messageNumber: 1,
            trackingId,
          }
        : undefined

    const result = await sendEmail({
      to: email,
      subject,
      html: bodyHtml,
      text: htmlToText(bodyHtml),
      ...(noteContext ? { context: noteContext } : {}),
    })

    if (result.note && !result.note.ok) {
      noteFailures++
      noteErrorSample ??= result.note.error
    } else if (result.ok && !noteContext) {
      // Sent, but there is no single lead to write to — reported so "why is there no note?" is
      // answerable instead of a mystery.
      notesSkipped++
      if (noteAmbiguous && !noteErrorSample) {
        noteErrorSample = `email matches ${match.kind === 'ambiguous' ? match.count : 0} leads — ambiguous, note not written`
      }
    }

    const logged = await logMessageSafely({
      leadId: null,
      nudgeId: nudge.id,
      channel: 'email',
      messageNumber: 1,
      toEmail: email,
      subject,
      messageId: result.messageId ?? null,
      trackingId,
      sheetRowRef,
      sentOk: result.ok,
      sendError: result.error ?? null,
      sentAt: result.ok ? new Date() : null,
    })
    if (!logged.ok) {
      logFailures++
      logErrorSample ??= logged.error
    }

    if (result.ok) {
      sent.push(email)
    } else {
      failed.push({ email, error: result.error ?? 'unknown error' })
    }

    // small delay to keep SMTP-friendly
    await new Promise((r) => setTimeout(r, 250))
  }

  // Update the nudge's lastRunAt — bookkeeping, and the daily scheduler's own "already ran today?"
  // gate reads it, so it must not fail a run that already sent messages.
  await db.nudge.update({ where: { id: nudge.id }, data: { lastRunAt: new Date() } }).catch((err) => {
    console.error('[sheet-run] could not stamp lastRunAt:', err instanceof Error ? err.message : err)
  })

  return {
    ok: true,
    summary: {
      nudgeKey: nudge.key,
      channel: nudge.channel,
      source: 'sheet',
      sheetUrl: rawUrl,
      rowsRead: rows.length,
      sent: sent.length,
      failed: failed.length,
      skipped: skipped.length,
      logFailures,
      logErrorSample,
      logWarning: logFailureWarning(logFailures, logErrorSample) ?? undefined,
      notesWritten: sent.length - noteFailures - notesSkipped,
      noteFailures,
      noteErrorSample,
      notesSkipped,
      fallbackEmails,
      sentEmails: sent,
      failedEntries: failed,
      skippedEntries: skipped,
      smtpConfigured: isMailerConfigured(),
      whatsappConfigured: isWhatsAppConfigured(),
    },
  }
}
