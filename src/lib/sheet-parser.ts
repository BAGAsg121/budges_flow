/**
 * Parse a Google Sheets CSV export into an array of row objects keyed by header name.
 * Column headers are lower-cased and spaces replaced with underscores to match template vars.
 *
 * Usage:
 *   const rows = parseSheetCsv(csvText)
 *   // rows[0] => { email: "foo@bar.com", first_name: "Foo", ... }
 */

/** Normalise a header cell into a template-variable key (e.g. "First Name" → "first_name"). */
function normaliseHeader(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')
}

/** Minimal RFC 4180-compliant CSV parser (handles quoted fields with commas/newlines). */
function parseCsvLine(line: string): string[] {
  const cells: string[] = []
  let cur = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        // peek: escaped quote?
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        cur += ch
      }
    } else {
      if (ch === '"') {
        inQuotes = true
      } else if (ch === ',') {
        cells.push(cur)
        cur = ''
      } else {
        cur += ch
      }
    }
  }
  cells.push(cur)
  return cells
}

/** Convert raw CSV text to an array of row objects. Returns [] on empty input. */
export function parseSheetCsv(csvText: string): Record<string, string>[] {
  // Normalise Windows / old-Mac line endings
  const lines = csvText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  if (lines.length < 2) return []

  const headers = parseCsvLine(lines[0]).map(normaliseHeader)
  const rows: Record<string, string>[] = []

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    const cells = parseCsvLine(line)
    const row: Record<string, string> = {}
    headers.forEach((h, idx) => {
      row[h] = (cells[idx] ?? '').trim()
    })
    rows.push(row)
  }

  return rows
}

/**
 * Convert a Google Sheets URL (any form) to the CSV export URL.
 * Supports:
 *   - /spreadsheets/d/<id>/edit#gid=<gid>
 *   - /spreadsheets/d/<id>/pub
 *   - already an export URL (returned as-is)
 */
export function toSheetCsvUrl(url: string, sheetGid?: string): string {
  if (url.includes('/export?format=csv')) return url

  const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/)
  if (!match) throw new Error('Could not extract spreadsheet ID from the provided URL')

  const spreadsheetId = match[1]

  // Attempt to extract gid from fragment or query
  const gidMatch = url.match(/[?&#]gid=(\d+)/)
  const resolvedGid = sheetGid ?? gidMatch?.[1] ?? '0'

  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&gid=${resolvedGid}`
}
