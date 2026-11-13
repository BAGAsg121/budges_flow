/**
 * POST /api/nudges/{id}/sheet-run
 *
 * Reads a publicly-shared Google Sheet (via CSV export), renders the nudge's template for each row,
 * and sends it (email, or a WhatsApp template). Lead rows are NOT upserted into the Lead table —
 * MessageLog rows are created with leadId=null and sheetRowRef="<csvUrl>|<address>".
 *
 * ANY nudge can be sent this way — sheet-driven, Zoho-driven or MySQL-driven. The sheet simply
 * replaces the nudge's usual recipient selection. For a WhatsApp nudge whose template body reads
 * variables, the sheet MUST carry a column per variable; the pre-flight refuses the run instead of
 * letting the parameter fall back to "-".
 *
 * SENDING POLICY — the sheet decides who gets messaged:
 *   • Every row is sent. History is NEVER consulted, so re-uploading a sheet really does re-send,
 *     including to people this nudge has contacted before.
 *   • `maxEmailsPerLead` / `followUpDays` do not apply (see nudge-kind.ts: sheet nudges are not
 *     lead-driven, and the engine's cap logic is never reached from here).
 *   • The only de-duplication is WITHIN a single run: an address repeated in the sheet is collapsed
 *     to one send, reported as `duplicate_in_sheet`.
 *   Because nothing consults history, running the same sheet twice sends twice. That is intended —
 *   and it is exactly what the daily scheduler relies on for the activation-fee reminders.
 *
 * THE WORK IS NOT DONE HERE. src/lib/sheet-run.ts owns it, because the scheduler now runs the same
 * flow on a daily timer and two implementations would drift apart invisibly.
 *
 * Body (JSON):
 *   { "sheetUrl": "https://docs.google.com/spreadsheets/d/…", "gid": "0" }
 *
 * Returns the same RunSummary shape as /run so the UI can reuse the results dialog.
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { runSheetNudge } from '@/lib/sheet-run'

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

    const nudge = await db.nudge.findUnique({ where: { id } })
    if (!nudge) return NextResponse.json({ ok: false, error: 'Nudge not found' }, { status: 404 })
    // The button is a manual, deliberate act on an ENABLED nudge. (The scheduler only ever picks
    // enabled nudges, so this check costs it nothing.)
    if (!nudge.enabled) return NextResponse.json({ ok: false, error: 'Nudge is disabled' }, { status: 400 })

    const outcome = await runSheetNudge({ nudge, sheetUrl: rawUrl, gid: body.gid })
    if (!outcome.ok) {
      return NextResponse.json(
        { ok: false, error: outcome.error, ...(outcome.missingColumns ? { missingColumns: outcome.missingColumns } : {}) },
        { status: outcome.status }
      )
    }
    return NextResponse.json({ ok: true, summary: outcome.summary })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}
