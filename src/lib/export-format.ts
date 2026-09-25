/**
 * Formatting for log exports — date ranges, column layout, row building.
 *
 * Kept free of path aliases and of the database so `scripts/verify-changes.mjs` can import it
 * directly (the same reason mailer.ts and zoho-mail.ts are alias-free). The DB query lives in
 * log-export.ts; everything that decides WHAT a row looks like lives here, which is also what
 * makes the row mapping testable with plain objects instead of a live database.
 *
 * Dates are IST CALENDAR DAYS, inclusive at both ends, because that is how the operator reads
 * them ("all the logs for yesterday"). A UTC-based range would shift the boundary by 5.5 hours
 * and quietly include or exclude the wrong messages.
 */
import { explainWhatsAppError } from './whatsapp-errors.ts'
import { explainMailError } from './mail-errors.ts'
import type { CellValue, SheetSpec } from './xlsx.ts'

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000

/** yyyy-mm-dd for the IST day containing `d`. */
export function istDay(d: Date): string {
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10)
}

/** "2026-09-24 15:27:51" in IST — what the operator recognises, not a UTC ISO string. */
export function istDateTime(d: Date | null | undefined): string {
  if (!d) return ''
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ')
}

export function istToday(now = new Date()): string {
  return istDay(now)
}

export function istDaysAgo(days: number, now = new Date()): string {
  return istDay(new Date(now.getTime() - days * 24 * 60 * 60 * 1000))
}

/**
 * Turn an inclusive IST day range into a UTC instant range: 00:00:00.000 IST on `fromDay`
 * through 23:59:59.999 IST on `toDay`.
 */
export function istRangeToUtc(fromDay: string, toDay: string): { start: Date; end: Date } {
  const parse = (day: string) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim())
    if (!m) throw new Error(`Invalid date "${day}" — expected YYYY-MM-DD.`)
    const y = Number(m[1])
    const mo = Number(m[2])
    const d = Number(m[3])
    // Reject impossible dates like 2026-02-31, which Date.UTC would silently roll over.
    const probe = new Date(Date.UTC(y, mo - 1, d))
    if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
      throw new Error(`"${day}" is not a real calendar date.`)
    }
    return { y, mo, d }
  }
  const f = parse(fromDay)
  const t = parse(toDay)

  // Midnight IST == 18:30 UTC the previous day.
  const start = new Date(Date.UTC(f.y, f.mo - 1, f.d, 0, 0, 0, 0) - IST_OFFSET_MS)
  const end = new Date(Date.UTC(t.y, t.mo - 1, t.d, 23, 59, 59, 999) - IST_OFFSET_MS)
  if (end < start) throw new Error('The end date is before the start date.')
  return { start, end }
}

/* ───────────────────────────── column layout ───────────────────────────── */

export const EXPORT_COLUMNS: string[] = [
  'Attempted at (IST)',
  'Attempted at (UTC)',
  'Sent at (IST)',
  'Channel',
  'Nudge',
  'Nudge key',
  'Lead / recipient',
  'Company',
  'Email',
  'Phone',
  'Subject',
  'Template',
  'Message #',
  'Status',
  'Delivered',
  'Opened',
  'Opens',
  'Opened at (IST)',
  'Replied',
  'Replied at (IST)',
  'Reply text',
  'Failure reason',
  'Failure explained',
  'Error detail',
  'Tracking id',
  'Sheet row',
]

export const EXPORT_WIDTHS: number[] = [
  20, 21, 20, 10, 34, 32, 28, 26, 30, 15, 46, 30, 10, 10, 10, 8, 7, 20, 8, 20, 50, 26, 44, 60, 38, 40,
]

/** Rows are capped so a stray huge range cannot exhaust memory on the server. */
export const EXPORT_ROW_LIMIT = 100_000

/* ─────────────────────────────── row building ─────────────────────────────── */

/** The subset of a MessageLog row an export needs. */
export interface ExportableLog {
  channel: string
  createdAt: Date
  sentAt: Date | null
  opened: boolean
  openedAt: Date | null
  opensCount: number
  replied: boolean
  repliedAt: Date | null
  sentOk: boolean
  sendError: string | null
  subject: string | null
  templateName: string | null
  messageNumber: number
  toEmail: string | null
  toPhone: string | null
  trackingId: string | null
  sheetRowRef: string | null
  inboundText: string | null
  nudge: { key: string; name: string }
  lead: { fullName: string | null; company: string | null } | null
}

/** replied beats opened beats sent; a failed row can never be anything else. */
export function exportStatus(l: Pick<ExportableLog, 'replied' | 'opened' | 'sentOk'>): string {
  if (l.replied) return 'replied'
  if (l.opened) return 'opened'
  return l.sentOk ? 'sent' : 'failed'
}

export function logToExportRow(l: ExportableLog): CellValue[] {
  const isWa = l.channel === 'whatsapp'
  // A failed row is explained in plain English; a successful one has no error to explain.
  const help = l.sendError ? (isWa ? explainWhatsAppError(l.sendError) : explainMailError(l.sendError)) : null

  return [
    istDateTime(l.createdAt),
    l.createdAt.toISOString(),
    istDateTime(l.sentAt),
    l.channel,
    l.nudge.name,
    l.nudge.key,
    l.lead?.fullName ?? (isWa ? l.toPhone : l.toEmail) ?? '',
    l.lead?.company ?? '',
    l.toEmail ?? '',
    l.toPhone ?? '',
    l.subject ?? '',
    l.templateName ?? '',
    l.messageNumber,
    exportStatus(l),
    l.sentOk ? 'yes' : 'no',
    l.opened ? 'yes' : 'no',
    l.opensCount ?? 0,
    istDateTime(l.openedAt),
    l.replied ? 'yes' : 'no',
    istDateTime(l.repliedAt),
    l.inboundText ?? '',
    help?.label ?? (l.sendError ? 'unrecognised' : ''),
    help?.detail ?? '',
    l.sendError ?? '',
    l.trackingId ?? '',
    l.sheetRowRef ?? '',
  ]
}

export interface Breakdown {
  nudge: string
  channel: string
  status: string
  count: number
}

/** Counts by nudge + channel + status — usually the first thing anyone asks of an export. */
export function buildBreakdown(logs: ExportableLog[]): Breakdown[] {
  const counts = new Map<string, number>()
  for (const l of logs) {
    const key = `${l.nudge.key}\u0000${l.channel}\u0000${exportStatus(l)}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([key, count]) => {
      const [nudge, channel, status] = key.split('\u0000')
      return { nudge, channel, status, count }
    })
    .sort((a, b) => b.count - a.count)
}

export interface SummaryInput {
  from: string
  to: string
  nudgeKey?: string
  channel?: string
  status?: string
  rowCount: number
  truncated: boolean
  breakdown: Breakdown[]
  generatedAt?: Date
}

export function buildSummarySheet(input: SummaryInput): SheetSpec {
  const rows: CellValue[][] = [
    ['Range (IST)', `${input.from} to ${input.to}`],
    ['Nudge', input.nudgeKey || 'all'],
    ['Channel', input.channel || 'all'],
    ['Status filter', input.status || 'all'],
    ['Rows exported', input.rowCount],
    ['Truncated', input.truncated ? 'yes — narrow the range' : 'no'],
    ['Generated at (IST)', istDateTime(input.generatedAt ?? new Date())],
    [],
    ['Nudge key', 'Channel', 'Status', 'Count'],
    ...input.breakdown.map((b) => [b.nudge, b.channel, b.status, b.count] as CellValue[]),
  ]
  return { name: 'Summary', headers: [], rows, widths: [34, 30, 16, 12] }
}

/**
 * The same rows as CSV. Quoted per RFC 4180 so commas, quotes and newlines survive, and
 * prefixed with a BOM so Excel decodes UTF-8 (emoji, em dashes) instead of mojibake.
 */
export function toCsv(headers: string[], rows: CellValue[][]): string {
  const cell = (v: CellValue): string => {
    if (v === null || v === undefined) return ''
    const s = v instanceof Date ? v.toISOString() : String(v)
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [headers.map(cell).join(',')]
  for (const row of rows) lines.push(row.map(cell).join(','))
  return '\ufeff' + lines.join('\r\n') + '\r\n'
}
