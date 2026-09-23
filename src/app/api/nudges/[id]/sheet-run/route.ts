/**
 * POST /api/nudges/{id}/sheet-run
 *
 * Reads a publicly-shared Google Sheet (via CSV export), renders the nudge's
 * email template for each row, and sends via SMTP.  Lead rows are NOT upserted
 * into the Lead table — MessageLog rows are created with leadId=null and
 * sheetRowRef="<csvUrl>|<email>" for dedup & audit.
 *
 * Body (JSON):
 *   { "sheetUrl": "https://docs.google.com/spreadsheets/d/…", "gid": "0" }
 *
 * Returns the same RunSummary shape as /run so the UI can reuse the results dialog.
 */
import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { db } from '@/lib/db'
import { sendEmail, isMailerConfigured } from '@/lib/mailer'
import { renderTemplate, injectTrackingPixel, htmlToText } from '@/lib/template'
import { isWhatsAppConfigured } from '@/lib/whatsapp'
import { getBaseUrl } from '@/lib/base-url'
import { parseSheetCsv, toSheetCsvUrl } from '@/lib/sheet-parser'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  try {
    const body = (await req.json()) as { sheetUrl?: string; gid?: string }
    const rawUrl = body.sheetUrl?.trim()
    if (!rawUrl) {
      return NextResponse.json({ ok: false, error: 'sheetUrl is required' }, { status: 400 })
    }

    // 1. Look up the nudge
    const nudge = await db.nudge.findUnique({ where: { id } })
    if (!nudge) return NextResponse.json({ ok: false, error: 'Nudge not found' }, { status: 404 })
    if (!nudge.enabled) return NextResponse.json({ ok: false, error: 'Nudge is disabled' }, { status: 400 })
    if (nudge.channel !== 'email') {
      return NextResponse.json({ ok: false, error: 'Sheet-run only supports email nudges' }, { status: 400 })
    }
    if (!nudge.subjectTemplate || !nudge.bodyTemplate) {
      return NextResponse.json({ ok: false, error: 'Nudge has no subject or body template' }, { status: 400 })
    }

    // 2. Fetch the sheet as CSV
    let csvUrl: string
    try {
      csvUrl = toSheetCsvUrl(rawUrl, body.gid)
    } catch (err) {
      return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 400 })
    }

    let csvText: string
    try {
      const fetchRes = await fetch(csvUrl, { redirect: 'follow' })
      if (!fetchRes.ok) {
        return NextResponse.json(
          {
            ok: false,
            error: `Could not fetch the sheet (HTTP ${fetchRes.status}). Make sure it is shared as "Anyone with the link can view".`,
          },
          { status: 400 }
        )
      }
      csvText = await fetchRes.text()
    } catch (err) {
      return NextResponse.json(
        { ok: false, error: `Network error fetching sheet: ${err instanceof Error ? err.message : String(err)}` },
        { status: 502 }
      )
    }

    // 3. Parse rows
    const rows = parseSheetCsv(csvText)
    if (rows.length === 0) {
      return NextResponse.json({ ok: false, error: 'Sheet has no data rows (or only a header row)' }, { status: 400 })
    }

    const baseUrl = await getBaseUrl()
    const now = new Date()

    type SkipEntry = { lead: string; email: string | null; reason: string; detail?: string }
    const sent: string[] = []
    const failed: { email: string; error: string }[] = []
    const skipped: SkipEntry[] = []

    // 4. For each row — render, deduplicate, send
    for (const row of rows) {
      const email = row['email'] || row['email_address'] || ''
      if (!email) {
        skipped.push({ lead: JSON.stringify(row).slice(0, 60), email: null, reason: 'no_email_column' })
        continue
      }

      // Dedup: skip if there is already a successful send for this nudge + email from a sheet run
      const existing = await db.messageLog.findFirst({
        where: { nudgeId: nudge.id, toEmail: email, sentOk: true },
      })
      if (existing) {
        skipped.push({ lead: email, email, reason: 'duplicate', detail: 'already sent successfully' })
        continue
      }

      // Build template vars from row columns + synthetic fields
      // Typed as the exact union renderTemplate expects so TS is happy
      const vars: Record<string, string | number | null | undefined> = {
        ...row,   // all cells are strings (from CSV parser)
        email,
        today: now.toISOString().slice(0, 10),
        message_number: 1,
        // convenience aliases
        first_name: row['first_name'] || row['name'] || email.split('@')[0],
        full_name: row['full_name'] || row['name'] || email.split('@')[0],
      }

      const trackingId = randomUUID()
      const subject = renderTemplate(nudge.subjectTemplate, vars)
      const bodyHtml = injectTrackingPixel(
        renderTemplate(nudge.bodyTemplate, vars, { escapeValues: true }),
        baseUrl,
        trackingId
      )
      const sheetRowRef = `${csvUrl}|${email}`

      const result = await sendEmail({ to: email, subject, html: bodyHtml, text: htmlToText(bodyHtml) })

      await db.messageLog.create({
        data: {
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
          engagementStatus: 'sent',
        },
      })

      if (result.ok) {
        sent.push(email)
      } else {
        failed.push({ email, error: result.error ?? 'unknown error' })
      }

      // small delay to keep SMTP-friendly
      await new Promise((r) => setTimeout(r, 250))
    }

    // Update nudge's lastRunAt
    await db.nudge.update({ where: { id: nudge.id }, data: { lastRunAt: new Date() } })

    return NextResponse.json({
      ok: true,
      summary: {
        nudgeKey: nudge.key,
        channel: 'email',
        source: 'sheet',
        sheetUrl: rawUrl,
        rowsRead: rows.length,
        sent: sent.length,
        failed: failed.length,
        skipped: skipped.length,
        sentEmails: sent,
        failedEntries: failed,
        skippedEntries: skipped,
        smtpConfigured: isMailerConfigured(),
        whatsappConfigured: isWhatsAppConfigured(),
      },
    })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}
