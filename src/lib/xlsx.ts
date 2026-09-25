/**
 * A minimal, dependency-free .xlsx (SpreadsheetML) writer.
 *
 * WHY HAND-ROLLED: exporting to "Excel" usually means pulling in a large library, and this app
 * is a banking-adjacent service where every added dependency is supply-chain surface. An .xlsx
 * is a ZIP of small XML parts, and the subset needed here — inline strings, numbers, a bold
 * header row, frozen panes, a filter and column widths — is a few hundred lines against Node's
 * built-in zlib. Nothing else is required.
 *
 * Deliberate choices:
 *  - **Inline strings** (`t="inlineStr"`) instead of a shared-strings table. Slightly larger,
 *    but it removes an entire part and the index bookkeeping that goes with it — the usual
 *    source of "Excel found unreadable content" from hand-written workbooks.
 *  - **Dates are written as ISO strings, not Excel serial numbers.** A serial needs a number
 *    format and a 1900/1904 epoch decision; a string round-trips unambiguously and still sorts
 *    chronologically because ISO-8601 sorts lexicographically.
 *  - Cells are typed from the JS value: number -> numeric cell, boolean -> boolean cell,
 *    everything else -> text. A numeric-looking string stays text (tracking ids, phone numbers,
 *    Eko codes) so Excel does not silently drop leading zeros or reformat them in scientific
 *    notation.
 */

import { deflateRawSync } from 'zlib'

export type CellValue = string | number | boolean | null | undefined | Date

export interface SheetSpec {
  name: string
  /** Column headings, written in row 1 and bold. */
  headers: string[]
  rows: CellValue[][]
  /** Optional per-column widths in characters, parallel to `headers`. */
  widths?: number[]
}

/* ────────────────────────────── XML helpers ────────────────────────────── */

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // XML 1.0 forbids most control characters outright; Excel refuses the whole file if one
    // is present. Inbound WhatsApp text and provider errors can carry them.
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
}

/** Excel's sheet-name rules: <=31 chars, and none of : \ / ? * [ ] */
export function sanitiseSheetName(name: string, fallback = 'Sheet'): string {
  const cleaned = name.replace(/[:\\/?*[\]]/g, ' ').trim()
  const safe = cleaned || fallback
  return safe.length > 31 ? safe.slice(0, 31) : safe
}

/** 1 -> A, 26 -> Z, 27 -> AA */
export function columnLetter(index1Based: number): string {
  let n = index1Based
  let out = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    out = String.fromCharCode(65 + rem) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

function cellXml(ref: string, value: CellValue, styleIndex: number): string {
  const s = styleIndex ? ` s="${styleIndex}"` : ''

  if (value === null || value === undefined || value === '') {
    // An empty cell, but still presence-marked so the style applies.
    return styleIndex ? `<c r="${ref}"${s}/>` : ''
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${ref}"${s}><v>${value}</v></c>`
  }
  if (typeof value === 'boolean') {
    return `<c r="${ref}"${s} t="b"><v>${value ? 1 : 0}</v></c>`
  }

  const text = value instanceof Date ? value.toISOString() : String(value)
  // xml:space="preserve" keeps leading/trailing spaces that Meta error text often carries.
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`
}

function sheetXml(sheet: SheetSpec): string {
  const headers = sheet.headers
  const lastCol = columnLetter(Math.max(headers.length, 1))
  const lastRow = sheet.rows.length + 1

  const cols = sheet.widths?.length
    ? `<cols>${sheet.widths
        .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`)
        .join('')}</cols>`
    : ''

  const headerRow = `<row r="1">${headers
    .map((h, i) => cellXml(`${columnLetter(i + 1)}1`, h, 1))
    .join('')}</row>`

  const bodyRows = sheet.rows
    .map((row, r) => {
      const rowNum = r + 2
      const cells = row.map((v, c) => cellXml(`${columnLetter(c + 1)}${rowNum}`, v, 0)).join('')
      return `<row r="${rowNum}">${cells}</row>`
    })
    .join('')

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:${lastCol}${lastRow}"/>
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
${cols}
<sheetData>${headerRow}${bodyRows}</sheetData>
<autoFilter ref="A1:${lastCol}${lastRow}"/>
</worksheet>`
}

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2">
<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>
<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font>
</fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`

/* ──────────────────────────────── ZIP ──────────────────────────────── */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** Exported so the verification script can check the archives it reads back. */
export function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** DOS date/time pair used by the ZIP local headers. Fixed epoch keeps output byte-stable. */
function dosDateTime(d: Date): { time: number; date: number } {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f)
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f)
  return { time, date }
}

interface ZipEntry {
  name: string
  data: Buffer
}

/** Build a ZIP archive (deflate, no encryption, UTF-8 names). */
export function buildZip(entries: ZipEntry[], now = new Date()): Buffer {
  const { time, date } = dosDateTime(now)
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8')
    const crc = crc32(entry.data)
    const compressed = deflateRawSync(entry.data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0) // local file header signature
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // flags: UTF-8 names
    local.writeUInt16LE(8, 8) // method: deflate
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28) // extra length

    locals.push(local, nameBuf, compressed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0) // central directory signature
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // comment
    central.writeUInt16LE(0, 34) // disk number
    central.writeUInt16LE(0, 36) // internal attrs
    central.writeUInt32LE(0, 38) // external attrs
    central.writeUInt32LE(offset, 42) // offset of local header

    centrals.push(central, nameBuf)
    offset += local.length + nameBuf.length + compressed.length
  }

  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4) // this disk
  eocd.writeUInt16LE(0, 6) // disk with central dir
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20) // comment length

  return Buffer.concat([...locals, centralBuf, eocd])
}

/* ────────────────────────────── workbook ────────────────────────────── */

/** Build a complete .xlsx workbook from one or more sheets. */
export function buildXlsx(sheetsIn: SheetSpec[], now = new Date()): Buffer {
  const sheets = sheetsIn.length ? sheetsIn : [{ name: 'Sheet', headers: [], rows: [] }]

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${sheets
  .map(
    (_, i) =>
      `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
  )
  .join('\n')}
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`

  const seen = new Set<string>()
  const workbookSheets = sheets
    .map((s, i) => {
      let name = sanitiseSheetName(s.name, `Sheet${i + 1}`)
      // Excel rejects duplicate sheet names outright.
      let n = 2
      while (seen.has(name.toLowerCase())) name = `${sanitiseSheetName(s.name).slice(0, 28)} ${n++}`
      seen.add(name.toLowerCase())
      return `<sheet name="${escapeXml(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`
    })
    .join('')

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${workbookSheets}</sheets>
</workbook>`

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets
  .map(
    (_, i) =>
      `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
  )
  .join('\n')}
<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`

  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rootRels, 'utf8') },
    { name: 'xl/workbook.xml', data: Buffer.from(workbook, 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(workbookRels, 'utf8') },
    { name: 'xl/styles.xml', data: Buffer.from(STYLES_XML, 'utf8') },
    ...sheets.map((s, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: Buffer.from(sheetXml(s), 'utf8'),
    })),
  ]

  return buildZip(entries, now)
}
