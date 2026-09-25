/**
 * Export message logs to a spreadsheet from the command line.
 *
 *   node --env-file=.env scripts/export-logs.mjs --from 2026-09-23 --to 2026-09-23 \
 *        --nudge whatsapp_onboarded_not_transacting --channel whatsapp --out logs.xlsx
 *
 *   --from / --to   inclusive IST calendar days (default: yesterday)
 *   --nudge         nudge key (default: all)
 *   --channel       email | whatsapp (default: all)
 *   --status        sent | opened | replied | failed (default: all)
 *   --format        xlsx (default) | csv
 *   --out           output filename (default: derived from the filters)
 *
 * Uses the SAME modules as GET /api/logs/export, so the file this writes is byte-for-byte the
 * shape the button downloads — which is what makes this worth having: the export can be
 * produced, and its contents inspected, without going through the browser.
 *
 * Read-only.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { buildLogExport } from '../src/lib/log-export.ts'
import { istDaysAgo, istToday, toCsv, EXPORT_COLUMNS } from '../src/lib/export-format.ts'
import { buildXlsx } from '../src/lib/xlsx.ts'
import { readZip, validateXlsx } from './lib/read-zip.mjs'
import { db } from '../src/lib/db.ts'

const args = process.argv.slice(2)
function flag(name, fallback = '') {
  const i = args.indexOf(name)
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback
}

const from = flag('--from') || istDaysAgo(1)
const to = flag('--to') || from
const nudgeKey = flag('--nudge')
const channel = flag('--channel')
const status = flag('--status')
const format = (flag('--format') || 'xlsx').toLowerCase()
const demo = args.includes('--demo')

/**
 * Write a workbook built from fake rows, with no database access at all.
 *
 * Exists so the .xlsx format can be confirmed to open in Excel without exporting real customer
 * data — the writer is hand-rolled, and a throwaway file containing real phone numbers must not
 * sit in a working tree that something else may commit.
 */
if (demo) {
  const { EXPORT_WIDTHS, buildSummarySheet } = await import('../src/lib/export-format.ts')
  const fakeRows = [
    [
      '2026-09-24 11:35:00',
      '2026-09-24T06:05:00.000Z',
      '2026-09-24 11:35:01',
      'whatsapp',
      'WhatsApp · Onboarded but not transacting',
      'whatsapp_onboarded_not_transacting',
      'Demo Partner Pvt Ltd',
      'Demo Partner Pvt Ltd',
      '',
      '919000000001',
      '',
      'activation_fee_pending_not_transacting',
      1,
      'replied',
      'yes',
      'yes',
      2,
      '2026-09-24 12:10:00',
      'yes',
      '2026-09-24 12:20:00',
      'Please share the payment link again',
      '',
      '',
      '',
      'demo-tracking-id-1',
      '',
    ],
    [
      '2026-09-24 11:36:00',
      '2026-09-24T06:06:00.000Z',
      '',
      'email',
      'Onboarded but not transacting',
      'onboarded_not_transacting',
      'Second Demo Ltd',
      'Second Demo Ltd',
      'demo@example.com',
      '',
      'Your Eko account is activated — complete your integration',
      '',
      1,
      'failed',
      'no',
      'no',
      0,
      '',
      'no',
      '',
      '',
      'sending blocked by Zoho',
      'Zoho has blocked this account from sending to external recipients…',
      'Zoho Mail API: Unable to send message;Reason:550 5.4.6 Unusual sending activity detected. (code 500)',
      'demo-tracking-id-2',
      '',
    ],
  ]

  const sheets = [
    { name: 'Logs', headers: EXPORT_COLUMNS, rows: fakeRows, widths: EXPORT_WIDTHS },
    buildSummarySheet({
      from: '2026-09-24',
      to: '2026-09-24',
      rowCount: fakeRows.length,
      truncated: false,
      breakdown: [
        { nudge: 'whatsapp_onboarded_not_transacting', channel: 'whatsapp', status: 'replied', count: 1 },
        { nudge: 'onboarded_not_transacting', channel: 'email', status: 'failed', count: 1 },
      ],
    }),
  ]

  const out = flag('--out') || `demo-export.${format}`
  if (format === 'csv') {
    writeFileSync(out, toCsv(EXPORT_COLUMNS, fakeRows), 'utf8')
  } else {
    const bytes = buildXlsx(sheets)
    writeFileSync(out, bytes)
    const problems = validateXlsx(readFileSync(out))
    for (const p of problems) console.log(`⚠️  ${p}`)
    if (problems.length) process.exitCode = 1
    else console.log(`Demo workbook valid (${bytes.length} bytes, no real data).`)
  }
  console.log(`File: ${out}`)
  console.log('Contains only invented rows — open it to confirm Excel reads the format.')
  await db.$disconnect()
  process.exit(process.exitCode ?? 0)
}

console.log('Exporting logs')
console.log(`  range    ${from} .. ${to}  (IST days, inclusive; today is ${istToday()})`)
console.log(`  nudge    ${nudgeKey || 'all'}`)
console.log(`  channel  ${channel || 'all'}`)
console.log(`  status   ${status || 'all'}`)
console.log(`  format   ${format}\n`)

try {
  const result = await buildLogExport({ from, to, nudgeKey, channel, status })

  const out = flag('--out') || `nudge-logs_${result.description}.${format}`

  if (format === 'csv') {
    writeFileSync(out, toCsv(EXPORT_COLUMNS, result.sheets[0].rows), 'utf8')
  } else {
    const bytes = buildXlsx(result.sheets)
    writeFileSync(out, bytes)

    // Read the file back and check it is loadable, rather than assuming the writer is right.
    // A workbook Excel refuses to open is indistinguishable from an empty export.
    const problems = validateXlsx(readFileSync(out))
    if (problems.length) {
      console.log('\n⚠️  The written workbook FAILED validation:')
      for (const p of problems) console.log(`   - ${p}`)
      process.exitCode = 1
    } else {
      console.log('Workbook validated: all parts present, sizes consistent, XML balanced.')
    }
  }

  console.log(`\nRows: ${result.rowCount}${result.truncated ? ' (TRUNCATED — narrow the range)' : ''}`)
  console.log(`File: ${out}`)

  if (result.breakdown.length) {
    console.log('\nBreakdown:')
    for (const b of result.breakdown) {
      console.log(`  ${String(b.count).padStart(5)}  ${b.channel.padEnd(9)} ${b.status.padEnd(8)} ${b.nudge}`)
    }
  } else {
    console.log('\nNo logs matched those filters.')
  }
} catch (err) {
  console.log(`❌ ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
}

// The Prisma pool keeps the event loop alive; close it or the script hangs.
await db.$disconnect()
