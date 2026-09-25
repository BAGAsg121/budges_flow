/**
 * Manage the per-lead message cap.
 *
 *   node --env-file=.env scripts/set-max-per-lead.mjs                      # dry run, lead-driven nudges
 *   node --env-file=.env scripts/set-max-per-lead.mjs --apply --max 3 --follow-up-days 2
 *   node --env-file=.env scripts/set-max-per-lead.mjs --normalise-sheet --apply
 *
 * WHY THE SHEET NUDGES ARE EXCLUDED: `maxEmailsPerLead` / `followUpDays` are read only by
 * `decideSend`, which runs on the LEAD-DRIVEN paths (runNudge, runMysqlNudge, previewNudge).
 * The sheet-run route never calls it — it applies its own rule, "one message per recipient,
 * skipping anyone with an earlier successful send". So setting a cap on a sheet nudge looks like
 * it does something and does nothing at all. That is exactly the mistake this script now refuses
 * to make: it will not write a cap to a sheet nudge, and `--normalise-sheet` sets those rows to
 * the honest 1 / 0 instead.
 *
 * Never touches `enabled` — pausing and resuming is the operator's call.
 */
import { db } from '../src/lib/db.ts'
import { DEFAULT_NUDGES, WA_SHEET_FLOW_TEMPLATES, WA_EMAIL_TWIN } from '../src/lib/nudge-defaults.ts'
import { capAppliesTo, nudgeSourceOf } from '../src/lib/nudge-kind.ts'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const normaliseSheet = args.includes('--normalise-sheet')

function flagValue(name, fallback) {
  const i = args.indexOf(name)
  if (i === -1) return fallback
  const v = Number(args[i + 1])
  return Number.isFinite(v) ? v : fallback
}

// 0 is NOT "unlimited" in decideSend — it means "never send" — so guard against it.
const max = Math.max(1, flagValue('--max', 3))
const followUpDays = Math.max(0, flagValue('--follow-up-days', 2))

/** The four activation-fee nudges plus the IP notice, all of which are sheet-driven. */
const SHEET_KEYS = [
  'onboarded_transacting',
  'onboarded_not_transacting',
  ...Object.keys(WA_SHEET_FLOW_TEMPLATES),
  ...Object.values(WA_EMAIL_TWIN),
]

const rows = await db.nudge.findMany({
  select: {
    id: true,
    key: true,
    name: true,
    enabled: true,
    maxEmailsPerLead: true,
    followUpDays: true,
    zohoCriteria: true,
    filters: true,
  },
  orderBy: { key: 'asc' },
})

const leadDriven = rows.filter((r) => capAppliesTo(r))
const sheetDriven = rows.filter((r) => !capAppliesTo(r))

console.log(apply ? 'MODE: apply' : 'MODE: dry run (pass --apply to write)')
console.log(`\nLead-driven nudges (the cap APPLIES): ${leadDriven.length}  — Zoho-criteria and MySQL flows`)
console.log(`Sheet nudges (the cap does NOT apply): ${sheetDriven.length}  — sent from a pasted sheet`)

let changed = 0

if (normaliseSheet) {
  console.log(`\nNormalising sheet nudges to max=1, followUp=0 (the honest equivalent of "once per recipient")`)
  for (const row of sheetDriven) {
    const same = row.maxEmailsPerLead === 1 && row.followUpDays === 0
    if (same) {
      console.log(`  == ${row.key.padEnd(36)} already 1 / 0`)
      continue
    }
    console.log(
      `  -> ${row.key.padEnd(36)} max=${row.maxEmailsPerLead} followUp=${row.followUpDays}d  =>  1 / 0   (source: ${nudgeSourceOf(row)}, enabled=${row.enabled} left as-is)`
    )
    changed++
    if (apply) {
      await db.nudge.update({ where: { id: row.id }, data: { maxEmailsPerLead: 1, followUpDays: 0 } })
    }
  }
} else {
  console.log(`\nSetting max=${max}, followUpDays=${followUpDays} on lead-driven nudges only`)
  for (const row of leadDriven) {
    const same = row.maxEmailsPerLead === max && row.followUpDays === followUpDays
    if (same) {
      console.log(`  == ${row.key.padEnd(36)} already ${max} / ${followUpDays}d`)
      continue
    }
    console.log(
      `  -> ${row.key.padEnd(36)} max=${row.maxEmailsPerLead} followUp=${row.followUpDays}d  =>  ${max} / ${followUpDays}d   (enabled=${row.enabled} left as-is)`
    )
    changed++
    if (apply) {
      await db.nudge.update({ where: { id: row.id }, data: { maxEmailsPerLead: max, followUpDays } })
    }
  }

  // Say plainly what was deliberately skipped, so "it did nothing" is never a mystery.
  const withMeaninglessCap = sheetDriven.filter((r) => r.maxEmailsPerLead !== 1 || r.followUpDays !== 0)
  if (withMeaninglessCap.length) {
    console.log(
      `\nSkipped ${withMeaninglessCap.length} sheet nudge(s) carrying a cap that nothing enforces:`
    )
    for (const r of withMeaninglessCap) {
      console.log(`   ${r.key} (max=${r.maxEmailsPerLead}, followUp=${r.followUpDays}d)`)
    }
    console.log('Run with --normalise-sheet --apply to reset those to 1 / 0.')
  }
}

console.log(
  apply ? `\nApplied. ${changed} row(s) updated.` : `\nDry run. ${changed} row(s) would change. Re-run with --apply.`
)

// The MySQL pool keeps the event loop alive; close it so the script exits.
await db.$disconnect()
