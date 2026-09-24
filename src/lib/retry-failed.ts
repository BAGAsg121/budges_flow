/**
 * Re-send a message that previously failed, using the nudge it originally belonged to.
 *
 * Design decisions worth stating:
 *
 *  - A retry NEVER mutates the original log row. That row is the audit trail of a real failed
 *    attempt; it stays exactly as it was. The retry writes a NEW row, and the failures view
 *    derives "resolved" by looking for a later success against the same nudge and address.
 *
 *  - Lead-driven sends rebuild their variables from the lead, exactly as runNudge does.
 *    Sheet-driven sends cannot: their variables live in a Google Sheet, so the sheet is
 *    re-fetched from the URL stored in the log and the matching row is found again. If the
 *    sheet is unreachable the retry fails loudly rather than sending a body with an empty
 *    mobile link.
 *
 *  - A retry is refused when the recipient has since replied. They answered; messaging them
 *    again is not what "retry" should mean.
 */
import { randomUUID } from 'crypto'
import { db } from '@/lib/db'
import { sendEmail } from '@/lib/mailer'
import { renderTemplate, injectTrackingPixel, htmlToText } from '@/lib/template'
import { sendWhatsAppTemplate, sendWhatsAppText, normalizePhone, getDefaultTemplateLanguage } from '@/lib/whatsapp'
import { buildWhatsAppParams } from '@/lib/whatsapp-params'
import { getBaseUrl } from '@/lib/base-url'
import { parseSheetCsv, toSheetCsvUrl } from '@/lib/sheet-parser'
import { buildSheetVars, pickSheetEmail, pickSheetMobile, type SheetRow, type TemplateVars } from '@/lib/sheet-vars'

export interface RetryOutcome {
  logId: string
  ok: boolean
  /** 'email' | 'whatsapp' — the channel actually attempted. */
  channel: string
  to: string | null
  reason?: string
  messageId?: string | null
  newLogId?: string
}

/** A template-variable bag, matching what renderTemplate accepts. */
type Vars = TemplateVars

function leadVars(lead: {
  fullName: string | null
  firstName: string | null
  lastName: string | null
  email: string | null
  phone: string | null
  mobile: string | null
  company: string | null
  leadStatus: string | null
  kycDocumentUploadCount: number | null
  businessVertical: string | null
  city: string | null
  ownerName: string | null
}, messageNumber: number, now: Date): Vars {
  return {
    full_name: lead.fullName,
    first_name: lead.firstName || lead.fullName,
    last_name: lead.lastName,
    email: lead.email,
    phone: lead.phone || lead.mobile,
    company: lead.company,
    lead_status: lead.leadStatus,
    kyc_document_upload_count: lead.kycDocumentUploadCount,
    business_vertical: lead.businessVertical,
    city: lead.city,
    owner_name: lead.ownerName,
    message_number: messageNumber,
    today: now.toISOString().slice(0, 10),
  }
}

/** `<csvUrl>|<address>` — written by sheet-run, and the only way back to the source row. */
function parseSheetRowRef(ref: string | null): { csvUrl: string; address: string } | null {
  if (!ref || ref.startsWith('fallback:')) return null
  const idx = ref.lastIndexOf('|')
  if (idx <= 0) return null
  return { csvUrl: ref.slice(0, idx), address: ref.slice(idx + 1) }
}

/**
 * Rebuild the variables for a sheet-sourced log by re-reading its sheet.
 * Throws with a clear reason when the row can no longer be found.
 */
async function rebuildSheetVars(log: {
  sheetRowRef: string | null
  toEmail: string | null
  toPhone: string | null
  messageNumber: number
}): Promise<Vars> {
  const parsed = parseSheetRowRef(log.sheetRowRef)
  if (!parsed) {
    throw new Error('This send did not record a sheet row, so its content cannot be rebuilt.')
  }

  let csvText: string
  try {
    const res = await fetch(parsed.csvUrl, { redirect: 'follow' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    csvText = await res.text()
  } catch (err) {
    throw new Error(
      `Could not re-read the source sheet (${err instanceof Error ? err.message : String(err)}). ` +
        'Make sure it is still shared as "Anyone with the link can view".'
    )
  }

  const rows = parseSheetCsv(csvText)
  const wanted = parsed.address.toLowerCase()
  const digits = String(log.toPhone || '').replace(/\D/g, '')

  const match = rows.find((r: SheetRow) => {
    const email = pickSheetEmail(r).toLowerCase()
    if (email && email === wanted) return true
    const mobile = pickSheetMobile(r).replace(/\D/g, '')
    if (digits && mobile && (mobile === digits || mobile.endsWith(digits) || digits.endsWith(mobile))) return true
    return false
  })

  if (!match) {
    throw new Error(`The row for ${parsed.address} is no longer in the sheet.`)
  }

  const email = pickSheetEmail(match)
  const mobile = pickSheetMobile(match)
  return buildSheetVars(match, { email, mobile, messageNumber: log.messageNumber })
}

export interface RetryResult {
  requested: number
  attempted: number
  sent: number
  failed: number
  skipped: number
  outcomes: RetryOutcome[]
}

/**
 * Retry a batch of failed logs, one at a time.
 *
 * Sequential on purpose: these are the sends that already failed once, most often because
 * something upstream was throttling, so firing them concurrently would recreate the burst
 * that caused the problem. The transports also rate-limit internally.
 */
export async function retryFailedLogs(logIds: string[]): Promise<RetryResult> {
  const baseUrl = await getBaseUrl()
  const now = new Date()

  const logs = await db.messageLog.findMany({
    where: { id: { in: logIds } },
    include: { nudge: true, lead: true },
  })

  const result: RetryResult = { requested: logIds.length, attempted: 0, sent: 0, failed: 0, skipped: 0, outcomes: [] }

  // Preserve the caller's ordering rather than the database's.
  const byId = new Map(logs.map((l) => [l.id, l]))

  for (const id of logIds) {
    const log = byId.get(id)
    if (!log) {
      result.skipped++
      result.outcomes.push({ logId: id, ok: false, channel: 'unknown', to: null, reason: 'log not found' })
      continue
    }

    const nudge = log.nudge
    const channel = log.channel === 'whatsapp' ? 'whatsapp' : 'email'
    const to = channel === 'whatsapp' ? log.toPhone : log.toEmail

    // Never re-message someone who has answered.
    const replied = await db.messageLog.findFirst({
      where: { nudgeId: log.nudgeId, replied: true, ...(log.leadId ? { leadId: log.leadId } : { toEmail: log.toEmail }) },
      select: { id: true },
    })
    if (replied) {
      result.skipped++
      result.outcomes.push({ logId: id, ok: false, channel, to, reason: 'recipient already replied' })
      continue
    }

    if (!to) {
      result.skipped++
      result.outcomes.push({ logId: id, ok: false, channel, to: null, reason: `no ${channel === 'whatsapp' ? 'phone' : 'email'} on the log` })
      continue
    }

    let vars: Vars
    try {
      vars = log.lead
        ? leadVars(log.lead, log.messageNumber, now)
        : await rebuildSheetVars({
            sheetRowRef: log.sheetRowRef,
            toEmail: log.toEmail,
            toPhone: log.toPhone,
            messageNumber: log.messageNumber,
          })
    } catch (err) {
      result.skipped++
      result.outcomes.push({
        logId: id,
        ok: false,
        channel,
        to,
        reason: err instanceof Error ? err.message : String(err),
      })
      continue
    }

    result.attempted++
    const trackingId = randomUUID()

    try {
      if (channel === 'whatsapp') {
        const raw = log.toPhone as string
        const toPhone = normalizePhone(raw)
        if (!toPhone) {
          result.skipped++
          result.outcomes.push({ logId: id, ok: false, channel, to: raw, reason: 'phone is not a valid WhatsApp number' })
          continue
        }

        const templateName = (nudge.whatsappTemplateName || '').trim()
        const waParams = buildWhatsAppParams(nudge.whatsappParams, vars)
        const send = templateName
          ? await sendWhatsAppTemplate({
              to: toPhone,
              templateName,
              language: nudge.whatsappLanguage || getDefaultTemplateLanguage(),
              params: waParams.body,
              buttonParams: waParams.button,
            })
          : await sendWhatsAppText({ to: toPhone, text: renderTemplate(nudge.bodyTemplate || '', vars) })

        const created = await db.messageLog.create({
          data: {
            leadId: log.leadId,
            nudgeId: log.nudgeId,
            channel: 'whatsapp',
            messageNumber: log.messageNumber,
            toPhone,
            templateName: nudge.whatsappTemplateName,
            messageId: send.waMessageId ?? null,
            trackingId,
            sentOk: send.ok,
            sendError: send.error ?? null,
            sentAt: send.ok ? new Date() : null,
            engagementStatus: send.ok ? 'sent' : 'failed',
          },
        })

        if (send.ok) result.sent++
        else result.failed++
        result.outcomes.push({
          logId: id,
          ok: send.ok,
          channel,
          to: toPhone,
          messageId: send.waMessageId ?? null,
          newLogId: created.id,
          reason: send.error,
        })
      } else {
        const subject = renderTemplate(nudge.subjectTemplate || '', vars)
        const html = injectTrackingPixel(
          renderTemplate(nudge.bodyTemplate || '', vars, { escapeValues: true }),
          baseUrl,
          trackingId
        )
        const send = await sendEmail({ to, subject, html, text: htmlToText(html) })

        const created = await db.messageLog.create({
          data: {
            leadId: log.leadId,
            nudgeId: log.nudgeId,
            channel: 'email',
            messageNumber: log.messageNumber,
            toEmail: to,
            subject,
            messageId: send.messageId ?? null,
            trackingId,
            sheetRowRef: log.sheetRowRef,
            sentOk: send.ok,
            sendError: send.error ?? null,
            sentAt: send.ok ? new Date() : null,
            engagementStatus: send.ok ? 'sent' : 'failed',
          },
        })

        if (send.ok) result.sent++
        else result.failed++
        result.outcomes.push({
          logId: id,
          ok: send.ok,
          channel,
          to,
          messageId: send.messageId ?? null,
          newLogId: created.id,
          reason: send.error,
        })
      }
    } catch (err) {
      result.failed++
      result.outcomes.push({
        logId: id,
        ok: false,
        channel,
        to,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return result
}

/**
 * Which failed logs have since been resolved by a successful retry.
 *
 * Derived at read time — a later successful send to the same nudge and address means the
 * failure was recovered. This avoids adding a column to a production table just to record
 * something the log rows already imply.
 */
export async function findResolvedFailures(): Promise<Map<string, string>> {
  const logs = await db.messageLog.findMany({
    select: { id: true, nudgeId: true, channel: true, toEmail: true, toPhone: true, sentOk: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  })

  // First success per (nudge, address)…
  const firstSuccess = new Map<string, Date>()
  for (const l of logs) {
    if (!l.sentOk) continue
    const addr = l.channel === 'whatsapp' ? l.toPhone : l.toEmail
    if (!addr) continue
    const key = `${l.nudgeId}|${addr}`
    if (!firstSuccess.has(key)) firstSuccess.set(key, l.createdAt)
  }

  // …resolves every earlier failure against that key.
  const resolved = new Map<string, string>()
  for (const l of logs) {
    if (l.sentOk) continue
    const addr = l.channel === 'whatsapp' ? l.toPhone : l.toEmail
    if (!addr) continue
    const at = firstSuccess.get(`${l.nudgeId}|${addr}`)
    if (at && at > l.createdAt) resolved.set(l.id, at.toISOString())
  }
  return resolved
}

/** Not exported from the sheet parser; re-exported here so the route needs one import. */
export { toSheetCsvUrl }
