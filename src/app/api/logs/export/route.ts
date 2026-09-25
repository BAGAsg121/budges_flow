/**
 * GET /api/logs/export
 *
 * Download message logs as a spreadsheet.
 *
 *   ?from=2026-09-23&to=2026-09-23            one IST day ("yesterday")
 *   &nudgeKey=whatsapp_onboarded_not_transacting
 *   &channel=whatsapp
 *   &status=failed                            sent | opened | replied | failed
 *   &format=xlsx                              xlsx (default) | csv
 *
 * Dates are inclusive IST calendar days. Without them the last 24 hours are... no: the default
 * is yesterday only when neither is given, because that is the most common ask ("yesterday's
 * logs"), and an accidental 30-day export of a large table is worse than a narrow one.
 *
 * Behind the app password (src/middleware.ts), so the file is not public.
 */
import { NextRequest, NextResponse } from 'next/server'
import { buildLogExport, countLogExport, toCsv, istToday, istDaysAgo, EXPORT_COLUMNS } from '@/lib/log-export'
import { buildXlsx } from '@/lib/xlsx'
import { istRangeToUtc } from '@/lib/export-format'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/** Make a value safe for a Content-Disposition filename (ASCII only, no separators). */
function safeFilenamePart(s: string): string {
  return (
    s
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'all'
  )
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams

  const from = (sp.get('from') || '').trim() || istDaysAgo(1)
  const to = (sp.get('to') || '').trim() || from
  const nudgeKey = (sp.get('nudgeKey') || '').trim()
  const channel = (sp.get('channel') || '').trim()
  const status = (sp.get('status') || '').trim()
  const format = (sp.get('format') || 'xlsx').trim().toLowerCase()

  // Guard against a typo turning into an unbounded export.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return NextResponse.json(
      { ok: false, error: 'from and to must be YYYY-MM-DD (IST calendar days).' },
      { status: 400 }
    )
  }
  if (from > istToday()) {
    return NextResponse.json({ ok: false, error: `"${from}" is in the future.` }, { status: 400 })
  }

  try {
    // Preview mode: how many rows would this produce? Lets the UI show a count before the
    // operator commits to a download.
    if (sp.get('countOnly') === '1') {
      const { rowCount, truncated } = await countLogExport({ from, to, nudgeKey, channel, status })
      return NextResponse.json(
        { ok: true, rowCount, truncated, description: { from, to, nudgeKey: nudgeKey || 'all', channel: channel || 'all', status: status || 'all' } },
        { headers: { 'Cache-Control': 'no-store' } }
      )
    }

    const result = await buildLogExport({ from, to, nudgeKey, channel, status })

    const filename = `nudge-logs_${safeFilenamePart(result.description)}`

    if (format === 'csv') {
      const csv = toCsv(EXPORT_COLUMNS, result.sheets[0].rows)
      return new NextResponse(csv, {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="${filename}.csv"`,
          'cache-control': 'no-store',
          'x-export-rows': String(result.rowCount),
        },
      })
    }

    const xlsx = buildXlsx(result.sheets)
    return new NextResponse(new Uint8Array(xlsx), {
      headers: {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': `attachment; filename="${filename}.xlsx"`,
        'content-length': String(xlsx.length),
        'cache-control': 'no-store',
        // Surfaced so the UI can report what happened without downloading the file twice.
        'x-export-rows': String(result.rowCount),
        'x-export-truncated': result.truncated ? '1' : '0',
      },
    })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}
