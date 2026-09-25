/**
 * Query the message log for a date range / nudge / channel / status and shape it for export.
 *
 * The row layout, date handling and CSV/XLSX-independent formatting live in export-format.ts
 * (alias-free and unit-testable); this module is only the database query and assembly.
 */
import { db } from './db.ts'
import { sanitiseSheetName, type CellValue, type SheetSpec } from './xlsx.ts'
import {
  buildBreakdown,
  buildSummarySheet,
  istRangeToUtc,
  logToExportRow,
  EXPORT_COLUMNS,
  EXPORT_ROW_LIMIT,
  EXPORT_WIDTHS,
  type ExportableLog,
} from './export-format.ts'

export { EXPORT_COLUMNS, EXPORT_WIDTHS, EXPORT_ROW_LIMIT, toCsv, istToday, istDaysAgo, istDay, istDateTime, istRangeToUtc } from './export-format.ts'

export interface ExportFilters {
  from: string
  to: string
  /** Nudge key, or '' for every nudge. */
  nudgeKey?: string
  channel?: string
  /** sent | opened | replied | failed | '' */
  status?: string
}

export interface ExportResult {
  sheets: SheetSpec[]
  rowCount: number
  truncated: boolean
  /** Human-readable description used for the filename. */
  description: string
  breakdown: Array<{ nudge: string; channel: string; status: string; count: number }>
}

/** Shared by the export and the count-only preview, so the two can never disagree. */
function buildExportWhere(filters: ExportFilters, range?: { start: Date; end: Date }): Record<string, unknown> {
  const where: Record<string, unknown> = {}
  if (range) where.createdAt = { gte: range.start, lte: range.end }
  if (filters.nudgeKey) where.nudge = { key: filters.nudgeKey }
  if (filters.channel === 'email' || filters.channel === 'whatsapp') where.channel = filters.channel
  if (filters.status === 'failed') where.sentOk = false
  else if (filters.status === 'sent' || filters.status === 'opened' || filters.status === 'replied') {
    where.engagementStatus = filters.status
  }
  return where
}

export interface ExportCount {
  rowCount: number
  truncated: boolean
  /**
   * When this nudge/channel/status was last active, IGNORING the date range.
   *
   * Without this, an export of a quiet day looks identical to "the logs are gone" — which is
   * exactly the wrong conclusion to invite. The dialog uses it to say where the data actually is.
   */
  latestAt: string | null
}

/**
 * How many rows the same filters would produce, without building the file.
 *
 * Used by the export dialog so the operator can see "59 rows" before committing to a download —
 * and so a mistyped date range shows up as an obviously wrong number rather than a surprise.
 */
export async function countLogExport(filters: ExportFilters): Promise<ExportCount> {
  const range = istRangeToUtc(filters.from, filters.to)
  const [rowCount, latest] = await Promise.all([
    db.messageLog.count({ where: buildExportWhere(filters, range) }),
    db.messageLog.findFirst({
      where: buildExportWhere(filters), // same filters, no date range
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    }),
  ])
  return {
    rowCount,
    truncated: rowCount >= EXPORT_ROW_LIMIT,
    latestAt: latest?.createdAt.toISOString() ?? null,
  }
}

export async function buildLogExport(filters: ExportFilters): Promise<ExportResult> {
  const { start, end } = istRangeToUtc(filters.from, filters.to)
  const where = buildExportWhere(filters, { start, end })

  const logs = await db.messageLog.findMany({
    where,
    orderBy: { createdAt: 'asc' },
    take: EXPORT_ROW_LIMIT,
    include: {
      lead: { select: { fullName: true, company: true } },
      nudge: { select: { key: true, name: true } },
    },
  })

  const exportable = logs as unknown as ExportableLog[]
  const rows: CellValue[][] = exportable.map(logToExportRow)
  const breakdown = buildBreakdown(exportable)
  const truncated = logs.length >= EXPORT_ROW_LIMIT

  return {
    sheets: [
      // Details first: Excel opens on the first sheet, and the detail is what was asked for.
      // The Summary is a convenience tab beside it.
      { name: sanitiseSheetName('Logs'), headers: EXPORT_COLUMNS, rows, widths: EXPORT_WIDTHS },
      buildSummarySheet({
        from: filters.from,
        to: filters.to,
        nudgeKey: filters.nudgeKey,
        channel: filters.channel,
        status: filters.status,
        rowCount: logs.length,
        truncated,
        breakdown,
      }),
    ],
    rowCount: logs.length,
    truncated,
    description: `${filters.nudgeKey || 'all-nudges'}_${filters.channel || 'all'}_${filters.from}_to_${filters.to}`,
    breakdown,
  }
}
