/**
 * Print an .xlsx as readable rows.
 *
 *   node scripts/dump-xlsx.mjs <file.xlsx> [--cols a,b,c] [--limit N]
 *
 * Debugging companion to the export feature: the workbook is a ZIP of XML, so "what is actually
 * in the file the user downloaded" is otherwise invisible without Excel.
 */
import { readFileSync } from 'node:fs'
import { readZip, validateXlsx } from './lib/read-zip.mjs'

const file = process.argv[2]
if (!file) {
  console.log('usage: node scripts/dump-xlsx.mjs <file.xlsx> [--limit N]')
  process.exit(1)
}
const limitIdx = process.argv.indexOf('--limit')
const limit = limitIdx >= 0 ? Number(process.argv[limitIdx + 1]) || 10 : 10

const buf = readFileSync(file)
console.log(`File: ${file} (${buf.length} bytes)`)

const problems = validateXlsx(buf)
console.log(problems.length ? `VALIDATION PROBLEMS: ${problems.join('; ')}` : 'Validation: OK')

const parts = readZip(buf)
for (const [name, entry] of parts) {
  console.log(`  ${name.padEnd(34)} ${String(entry.bytes.length).padStart(7)} bytes`)
}

/**
 * Turn a worksheet's XML into an array of row arrays.
 *
 * Cells are placed by their `r` reference (A1, C1, AA1…), NOT by order: empty cells are omitted
 * from the XML entirely, so reading positionally shifts every column after the first gap and
 * makes a correct workbook look wrong. That mistake was made once here and cost a false alarm.
 */
function colIndex(ref) {
  const letters = (ref.match(/^[A-Z]+/) || [''])[0]
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

function rowsOf(xml) {
  const rows = []
  for (const rowMatch of xml.matchAll(/<row[^>]*>(.*?)<\/row>/g)) {
    const cells = []
    for (const cellMatch of rowMatch[1].matchAll(/<c([^>]*?)(?:\/>|>(.*?)<\/c>)/g)) {
      const attrs = cellMatch[1] ?? ''
      const inner = cellMatch[2] ?? ''
      const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1]
      const text = /<t[^>]*>([\s\S]*?)<\/t>/.exec(inner)
      const num = /<v>([\s\S]*?)<\/v>/.exec(inner)
      const raw = text ? text[1] : (num ? num[1] : '')
      const value = raw
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&')
      const at = ref ? colIndex(ref) : cells.length
      cells[at] = value
    }
    rows.push(cells)
  }
  return rows
}

const sheetNames = [...parts.keys()]
  .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
  .sort()

for (const sheetName of sheetNames) {
  const rows = rowsOf(parts.get(sheetName).content)
  console.log(`\n── ${sheetName}: ${rows.length} row(s)`)
  const header = rows[0] ?? []
  console.log(`HEADER (${header.length} cols): ${header.map((h, i) => `${i}:${h}`).join(' | ')}`)
  for (const r of rows.slice(1, limit + 1)) {
    console.log(
      `\nROW ${rows.indexOf(r)} (${r.length} cells):\n` +
        header.map((h, i) => `   ${String(h).padEnd(22)} ${r[i] ?? '(empty)'}`).join('\n')
    )
  }
  if (rows.length - 1 > limit) console.log(`\n… ${rows.length - 1 - limit} more row(s)`)
}
