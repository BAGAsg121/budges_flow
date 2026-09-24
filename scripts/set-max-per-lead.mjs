/**
 * Set the per-lead message cap (and follow-up gap) on the four activation-fee nudges.
 *
 *   node --env-file=.env scripts/set-max-per-lead.mjs           # dry run — shows the change
 *   node --env-file=.env scripts/set-max-per-lead.mjs --apply   # writes it
 *   node --env-file=.env scripts/set-max-per-lead.mjs --apply --max 3 --follow-up-days 2
 *
 * WHY A SEPARATE SCRIPT rather than `seed:nudges --force`: --force rewrites every field,
 * including subject/body templates that may have been edited in the UI. This touches
 * exactly two columns on exactly four rows and prints a before/after diff, so a cap change
 * can never quietly revert someone's copy edits.
 *
 * It never touches `enabled` — pausing and resuming is the operator's call, not a script's.
 */
import { db } from '../src/lib/db.ts'
import { WA_SHEET_FLOW_TEMPLATES, WA_EMAIL_TWIN } from '../src/lib/nudge-defaults.ts'

const args = process.argv.slice(2)
const apply = args.includes('--apply')

function flagValue(name, fallback) {
  const i = args.indexOf(name)
  if (i === -1) return fallback
  const v = Number(args[i + 1])
  return Number.isFinite(v) ? v : fallback
}

const max = flagValue('--max', 3)
const followUpDays = flagValue('--follow-up-days', 2)

/** The four nudges the user asked about: both email ones and their two WhatsApp twins. */
const TARGET_KEYS = [
  'onboarded_transacting',
  'onboarded_not_transacting',
  ...Object.keys(WA_SHEET_FLOW_TEMPLATES),
  ...Object.values(WA_EMAIL_TWIN),
]

const keys = [...new Set(TARGET_KEYS)]

console.log(`Setting max=${max}, followUpDays=${followUpDays} on ${keys.length} nudge(s)`)
console.log(apply ? 'MODE: apply\n' : 'MODE: dry run (pass --apply to write)\n')

const rows = await db.nudge.findMany({
  where: { key: { in: keys } },
  select: { id: true, key: true, name: true, enabled: true, maxEmailsPerLead: true, followUpDays: true },
})
const byKey = new Map(rows.map((r) => [r.key, r]))

const missing = keys.filter((k) => !byKey.has(k))
let changed = 0

for (const key of keys) {
  const row = byKey.get(key)
  if (!row) {
    console.log(`  ?? ${key.padEnd(38)} NOT IN DATABASE`)
    continue
  }

  const same = row.maxEmailsPerLead === max && row.followUpDays === followUpDays
  const before = `max=${row.maxEmailsPerLead} followUp=${row.followUpDays}d`
  const after = `max=${max} followUp=${followUpDays}d`

  if (same) {
    console.log(`  == ${key.padEnd(38)} already ${after} (enabled=${row.enabled})`)
    continue
  }

  console.log(`  -> ${key.padEnd(38)} ${before}  =>  ${after} (enabled=${row.enabled}, left as-is)`)
  changed++

  if (apply) {
    // Only these two columns. `enabled` is deliberately absent.
    await db.nudge.update({ where: { id: row.id }, data: { maxEmailsPerLead: max, followUpDays } })
  }
}

if (missing.length) console.log(`\nNot found (run npm run seed:nudges first): ${missing.join(', ')}`)
console.log(
  apply
    ? `\nApplied. ${changed} row(s) updated.`
    : `\nDry run. ${changed} row(s) would change. Re-run with --apply.`
)

// The MySQL pool keeps the event loop alive; close it so the script exits cleanly.
await db.$disconnect()
