/**
 * Repoint the two manual WhatsApp nudges at their UTILITY templates.
 *
 *   node --env-file=.env scripts/repoint-whatsapp-templates.mjs          # dry run
 *   node --env-file=.env scripts/repoint-whatsapp-templates.mjs --apply
 *
 * WHY: the original templates (`onboarded_transacting_pay`, `onboarded_not_transacting_pay`)
 * were auto-categorised MARKETING because their copy advertised an expiring discount, and
 * marketing templates are subject to Meta's per-user frequency cap — in production that
 * dropped 36 + 9 sends with 131049 and 3 with 130472. The replacement copy is purely
 * transactional and is submitted as UTILITY, which is not capped.
 *
 * Touches exactly three columns on exactly the nudges listed below, and never `enabled`.
 * The old templates are left on the WABA untouched: they are still referenced by the send
 * history, and deleting an approved template is not reversible.
 */
import { db } from '../src/lib/db.ts'
import { DEFAULT_NUDGES, WA_SHEET_FLOW_TEMPLATES, WA_RETIRED_MARKETING_TEMPLATES } from '../src/lib/nudge-defaults.ts'

const apply = process.argv.includes('--apply')

/** Only the manual sheet-driven WhatsApp nudges; nothing else in the app uses these specs. */
const KEYS = Object.keys(WA_SHEET_FLOW_TEMPLATES)

console.log(apply ? 'MODE: apply\n' : 'MODE: dry run (pass --apply to write)\n')

const rows = await db.nudge.findMany({
  where: { key: { in: KEYS } },
  select: { id: true, key: true, enabled: true, whatsappTemplateName: true, whatsappLanguage: true, bodyTemplate: true },
})
const byKey = new Map(rows.map((r) => [r.key, r]))

let changed = 0

for (const key of KEYS) {
  const row = byKey.get(key)
  const spec = WA_SHEET_FLOW_TEMPLATES[key]
  if (!row) {
    console.log(`  ?? ${key.padEnd(36)} NOT IN DATABASE`)
    continue
  }

  const retired = WA_RETIRED_MARKETING_TEMPLATES[key]
  const isRetired = row.whatsappTemplateName === retired
  const alreadyDone = row.whatsappTemplateName === spec.templateName && row.bodyTemplate === spec.body

  console.log(`  ${alreadyDone ? '==' : '->'} ${key.padEnd(36)} template ${row.whatsappTemplateName} => ${spec.templateName}`)
  if (isRetired) console.log(`       (retiring MARKETING template "${retired}" — left on the WABA, unused)`)
  console.log(`       enabled=${row.enabled} (left as-is)`)

  if (alreadyDone) continue
  changed++

  if (apply) {
    await db.nudge.update({
      where: { id: row.id },
      data: {
        whatsappTemplateName: spec.templateName,
        whatsappLanguage: process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'en_US',
        // The reference copy that --create-missing builds the Meta template from. Kept in step
        // with the nudge so the two cannot drift apart.
        bodyTemplate: spec.body,
      },
    })
  }
}

// Sanity check: the rest of the app's nudges should not be pointing at a retired template.
const stragglers = await db.nudge.findMany({
  where: { whatsappTemplateName: { in: Object.values(WA_RETIRED_MARKETING_TEMPLATES) } },
  select: { key: true, whatsappTemplateName: true },
})
if (stragglers.length) {
  console.log('\n⚠️  Still on a retired MARKETING template:')
  for (const s of stragglers) console.log(`   ${s.key} -> ${s.whatsappTemplateName}`)
}

// And that nothing references a template the code no longer defines.
const known = new Set(DEFAULT_NUDGES.map((n) => n.whatsappTemplateName).filter(Boolean))
const unknown = await db.nudge.findMany({
  where: { whatsappTemplateName: { not: null } },
  select: { key: true, whatsappTemplateName: true },
})
const dangling = unknown.filter((n) => !known.has(n.whatsappTemplateName))
if (dangling.length) {
  console.log('\n⚠️  Reference a template the code does not define:')
  for (const d of dangling) console.log(`   ${d.key} -> ${d.whatsappTemplateName}`)
}

console.log(
  apply ? `\nApplied. ${changed} row(s) updated.` : `\nDry run. ${changed} row(s) would change. Re-run with --apply.`
)
console.log('\nNext: node --env-file=.env scripts/check-whatsapp-templates.mjs --create-missing')

await db.$disconnect()
